/**
 * Per-dispatcher peer-bot awareness/trust store.
 *
 * Two sets are tracked separately, per chat_id, and they must never be
 * conflated (issue #62 hard contract):
 *
 *   - `known`   — bots passively observed sending messages in an authorized
 *                 chat. Awareness only; observing a bot NEVER grants it trust.
 *   - `trusted` — bots introduced by an allowlisted sender running `/introduce`.
 *                 The gate consults this set (and only this set) when deciding
 *                 whether a peer bot's group message may be delivered.
 *
 * `baseline` bookkeeping records `im.chat.member.bot.added_v1` events so the
 * host can later inject a one-shot "bots in this group" context; it is
 * idempotent by Feishu event id. (The one-shot context injection itself is a
 * follow-up; this store keeps the durable bookkeeping the contract needs.)
 *
 * This module owns the state shape and the loader (`loadChatBots`); the
 * session holds the one `TransactionalStore<ChatBotsState>` that loader feeds
 * and passes it into every function below. Every mutation here is a pure
 * `(state) => state` change handed to the store's own `update()` — it never
 * mutates the committed value it is given, and the store itself reads,
 * writes, and serializes the file (one JSON file per dispatcher, owner-only,
 * atomic writes).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TransactionalStore } from '@excitedjs/dreamux-utils';

/** Retain at most this many recent bot-added event ids per chat for dedupe. */
const MAX_SEEN_EVENT_IDS = 200;

/** The one file this store owns, under the dispatcher's state directory. */
export const CHAT_BOTS_FILENAME = 'chat-bots.json';

export interface ChatBotsEntry {
  /** Passively observed peer-bot open_ids — awareness only, never trust. */
  known: string[];
  /** Introduced peer-bot open_ids — the gate's trust set for this chat. */
  trusted: string[];
  /** Best-effort open_id → display name map for known/trusted bots. */
  names: Record<string, string>;
  /**
   * Set when this chat has pending discovery context to inject once (a bot was
   * added, or an `/introduce` newly trusted a bot). Consumed by the next
   * delivered group message; see `pendingBaseline` / `clearBaselineIfCurrent`.
   */
  needsBaseline: boolean;
  /**
   * Monotonic counter bumped every time `needsBaseline` is (re)set. The deliver
   * path snapshots it before enqueue and only clears the flag if it is still
   * current, so a newer `/introduce` / bot-added event arriving mid-enqueue is
   * not clobbered by a stale clear (issue #69, generation-safe one-shot clear).
   */
  baselineGeneration: number;
  /** Recent bot-added event ids, for idempotent member-event handling. */
  seenEventIds: string[];
}

export interface ChatBotsState {
  version: 1;
  chats: Record<string, ChatBotsEntry>;
}

export interface PeerBot {
  openId: string;
  name?: string;
}

/** The pending one-shot discovery context for one chat (issue #69). */
export interface PendingBaseline {
  /** Whether this chat has discovery context waiting to be injected. */
  needsBaseline: boolean;
  /** Snapshot of the entry's generation, for a generation-safe clear. */
  generation: number;
  /** The chat's trusted peer bots (open_id + best-effort name). */
  trusted: PeerBot[];
}

/** Known and trusted peer bots for one chat, for the `list_chat_bots` tool. */
export interface ChatBotsListing {
  known: PeerBot[];
  trusted: PeerBot[];
}

export function defaultChatBotsState(): ChatBotsState {
  return { version: 1, chats: {} };
}

function emptyEntry(): ChatBotsEntry {
  return {
    known: [],
    trusted: [],
    names: {},
    needsBaseline: false,
    baselineGeneration: 0,
    seenEventIds: [],
  };
}

/** Build PeerBot records (open_id + best-effort name) for a set of open_ids. */
function peerBotsFrom(entry: ChatBotsEntry, openIds: string[]): PeerBot[] {
  return openIds.map((openId) => {
    const name = entry.names[openId];
    return name !== undefined && name !== '' ? { openId, name } : { openId };
  });
}

/**
 * Load the store. Unlike the access store, a corrupt or unreadable chat-bots
 * file is not security-critical — it only affects peer-bot discovery — so a
 * load failure degrades to an empty store rather than throwing. This is the
 * `load` option the session's `TransactionalStore<ChatBotsState>` is built
 * with.
 */
export async function loadChatBots(stateDir: string): Promise<ChatBotsState> {
  const path = join(stateDir, CHAT_BOTS_FILENAME);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return normalizeChatBots(parsed);
  } catch {
    return defaultChatBotsState();
  }
}

/** A copy of `entry` with `bot`'s name recorded, or `entry` itself if there is nothing new to record. */
function withName(entry: ChatBotsEntry, bot: PeerBot): ChatBotsEntry {
  if (bot.name === undefined || bot.name === '') return entry;
  if (entry.names[bot.openId] === bot.name) return entry;
  return { ...entry, names: { ...entry.names, [bot.openId]: bot.name } };
}

/** A copy of `entry` with `openId` added to `known`, or `entry` itself if it already is. */
function withKnownId(entry: ChatBotsEntry, openId: string): ChatBotsEntry {
  if (entry.known.includes(openId)) return entry;
  return { ...entry, known: [...entry.known, openId] };
}

/** A copy of `entry` with `openId` added to `trusted`, or `entry` itself if it already is. */
function withTrustedId(entry: ChatBotsEntry, openId: string): ChatBotsEntry {
  if (entry.trusted.includes(openId)) return entry;
  return { ...entry, trusted: [...entry.trusted, openId] };
}

/** A copy of `entry` flagged as having pending discovery context, generation bumped. */
function withBaseline(entry: ChatBotsEntry): ChatBotsEntry {
  return {
    ...entry,
    needsBaseline: true,
    baselineGeneration: entry.baselineGeneration + 1,
  };
}

/** A copy of `state` with `chatId`'s entry replaced by `entry`. */
function withEntry(
  state: ChatBotsState,
  chatId: string,
  entry: ChatBotsEntry,
): ChatBotsState {
  return { ...state, chats: { ...state.chats, [chatId]: entry } };
}

/** Record a passively observed peer bot as *known* (awareness only). */
export async function observeKnownBot(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
  bot: PeerBot,
): Promise<void> {
  if (bot.openId === '') return;
  await store.update((state) => {
    const entry = state.chats[chatId] ?? emptyEntry();
    const next = withKnownId(withName(entry, bot), bot.openId);
    return next === entry ? state : withEntry(state, chatId, next);
  });
}

/**
 * Record peer bots introduced by an allowlisted `/introduce` as *trusted*.
 * Trusted bots are also known. Returns the open_ids newly added to trust.
 */
export async function trustIntroducedBots(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
  bots: PeerBot[],
): Promise<string[]> {
  let added: string[] = [];
  await store.update((state) => {
    added = [];
    let entry = state.chats[chatId] ?? emptyEntry();
    let changed = false;
    for (const bot of bots) {
      if (bot.openId === '') continue;
      const named = withName(entry, bot);
      if (named !== entry) changed = true;
      entry = named;
      const known = withKnownId(entry, bot.openId);
      if (known !== entry) changed = true;
      entry = known;
      const trusted = withTrustedId(entry, bot.openId);
      if (trusted !== entry) {
        changed = true;
        added.push(bot.openId);
      }
      entry = trusted;
    }
    // A newly trusted bot is pending discovery context for the next message
    // (issue #69). Re-introducing already-trusted bots changes nothing, so it
    // does not re-arm the one-shot.
    if (added.length > 0) entry = withBaseline(entry);
    return changed ? withEntry(state, chatId, entry) : state;
  });
  return added;
}

/**
 * The chat's pending one-shot discovery context, snapshotted for a
 * generation-safe clear (issue #69). The deliver path reads this before
 * enqueue, injects the trusted bots when `needsBaseline`, and clears via
 * `clearBaselineIfCurrent` only after a successful submission.
 */
export async function pendingBaseline(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
): Promise<PendingBaseline> {
  await store.load();
  const entry = store.current.chats[chatId];
  if (entry === undefined) {
    return { needsBaseline: false, generation: 0, trusted: [] };
  }
  return {
    needsBaseline: entry.needsBaseline,
    generation: entry.baselineGeneration,
    trusted: peerBotsFrom(entry, entry.trusted),
  };
}

/**
 * Clear the pending-context flag only if the chat's generation still matches
 * the snapshot taken before enqueue. A newer `/introduce` / bot-added event
 * that arrived mid-enqueue bumps the generation, so this no-ops rather than
 * dropping the newer pending context (issue #69).
 */
export async function clearBaselineIfCurrent(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
  generation: number,
): Promise<void> {
  await store.update((state) => {
    const entry = state.chats[chatId];
    if (entry === undefined || !entry.needsBaseline) return state;
    if (entry.baselineGeneration !== generation) return state;
    return withEntry(state, chatId, { ...entry, needsBaseline: false });
  });
}

/** Known and trusted peer bots for one chat (the `list_chat_bots` tool). */
export async function listChatBots(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
): Promise<ChatBotsListing> {
  await store.load();
  const entry = store.current.chats[chatId];
  if (entry === undefined) return { known: [], trusted: [] };
  return {
    known: peerBotsFrom(entry, entry.known),
    trusted: peerBotsFrom(entry, entry.trusted),
  };
}

/** The trust set the gate consults for one chat. */
export async function trustedBotIds(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
): Promise<Set<string>> {
  await store.load();
  return new Set(store.current.chats[chatId]?.trusted ?? []);
}

/**
 * Record an `im.chat.member.bot.added_v1` event: mark the chat as needing a
 * baseline injection. Idempotent by event id — a redelivered event is a no-op.
 * Returns true when the event was newly recorded.
 */
export async function recordBotAdded(
  store: TransactionalStore<ChatBotsState>,
  chatId: string,
  eventId: string,
): Promise<boolean> {
  let recorded = false;
  await store.update((state) => {
    const entry = state.chats[chatId] ?? emptyEntry();
    if (eventId !== '' && entry.seenEventIds.includes(eventId)) {
      recorded = false;
      return state;
    }
    recorded = true;
    let seenEventIds = entry.seenEventIds;
    if (eventId !== '') {
      seenEventIds = [...seenEventIds, eventId];
      if (seenEventIds.length > MAX_SEEN_EVENT_IDS) {
        seenEventIds = seenEventIds.slice(
          seenEventIds.length - MAX_SEEN_EVENT_IDS,
        );
      }
    }
    return withEntry(state, chatId, withBaseline({ ...entry, seenEventIds }));
  });
  return recorded;
}

function normalizeChatBots(raw: unknown): ChatBotsState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultChatBotsState();
  }
  const chatsRaw = (raw as Record<string, unknown>)['chats'];
  const chats: Record<string, ChatBotsEntry> = {};
  if (
    chatsRaw !== null &&
    typeof chatsRaw === 'object' &&
    !Array.isArray(chatsRaw)
  ) {
    for (const [chatId, value] of Object.entries(
      chatsRaw as Record<string, unknown>,
    )) {
      chats[chatId] = normalizeEntry(value);
    }
  }
  return { version: 1, chats };
}

function normalizeEntry(raw: unknown): ChatBotsEntry {
  const entry = emptyEntry();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return entry;
  const obj = raw as Record<string, unknown>;
  entry.known = stringArray(obj['known']);
  entry.trusted = stringArray(obj['trusted']);
  entry.seenEventIds = stringArray(obj['seenEventIds']);
  entry.needsBaseline = obj['needsBaseline'] === true;
  entry.baselineGeneration =
    typeof obj['baselineGeneration'] === 'number' &&
    Number.isFinite(obj['baselineGeneration'])
      ? obj['baselineGeneration']
      : 0;
  const names = obj['names'];
  if (names !== null && typeof names === 'object' && !Array.isArray(names)) {
    for (const [k, v] of Object.entries(names as Record<string, unknown>)) {
      if (typeof v === 'string') entry.names[k] = v;
    }
  }
  return entry;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string'),
    ),
  ];
}
