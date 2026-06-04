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
 * One JSON file per dispatcher, keyed by chat_id, so no chat_id ever has to be
 * sanitized into a path segment. Owner-only (0600); writes are atomic.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { dispatcherChatBotsPath } from '../runtime/paths.js';

/** Retain at most this many recent bot-added event ids per chat for dedupe. */
const MAX_SEEN_EVENT_IDS = 200;

/** Monotonic per-process counter so concurrent writes never share a temp path. */
let tmpCounter = 0;

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

/** Flag a chat as having pending discovery context, bumping its generation. */
function markBaseline(entry: ChatBotsEntry): void {
  entry.needsBaseline = true;
  entry.baselineGeneration += 1;
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
 * load failure degrades to an empty store rather than throwing.
 */
export async function loadChatBots(
  dispatcherId: string,
): Promise<ChatBotsState> {
  const path = dispatcherChatBotsPath(dispatcherId);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return normalizeChatBots(parsed);
  } catch {
    return defaultChatBotsState();
  }
}

export async function saveChatBots(
  dispatcherId: string,
  state: ChatBotsState,
): Promise<void> {
  const path = dispatcherChatBotsPath(dispatcherId);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

function entryFor(state: ChatBotsState, chatId: string): ChatBotsEntry {
  const existing = state.chats[chatId];
  if (existing !== undefined) return existing;
  const created = emptyEntry();
  state.chats[chatId] = created;
  return created;
}

/** Record a passively observed peer bot as *known* (awareness only). */
export async function observeKnownBot(
  dispatcherId: string,
  chatId: string,
  bot: PeerBot,
): Promise<void> {
  if (bot.openId === '') return;
  const state = await loadChatBots(dispatcherId);
  const entry = entryFor(state, chatId);
  let changed = recordName(entry, bot);
  if (!entry.known.includes(bot.openId)) {
    entry.known.push(bot.openId);
    changed = true;
  }
  if (changed) await saveChatBots(dispatcherId, state);
}

/**
 * Record peer bots introduced by an allowlisted `/introduce` as *trusted*.
 * Trusted bots are also known. Returns the open_ids newly added to trust.
 */
export async function trustIntroducedBots(
  dispatcherId: string,
  chatId: string,
  bots: PeerBot[],
): Promise<string[]> {
  const state = await loadChatBots(dispatcherId);
  const entry = entryFor(state, chatId);
  const added: string[] = [];
  let changed = false;
  for (const bot of bots) {
    if (bot.openId === '') continue;
    if (recordName(entry, bot)) changed = true;
    if (!entry.known.includes(bot.openId)) {
      entry.known.push(bot.openId);
      changed = true;
    }
    if (!entry.trusted.includes(bot.openId)) {
      entry.trusted.push(bot.openId);
      added.push(bot.openId);
      changed = true;
    }
  }
  // A newly trusted bot is pending discovery context for the next message
  // (issue #69). Re-introducing already-trusted bots changes nothing, so it
  // does not re-arm the one-shot.
  if (added.length > 0) markBaseline(entry);
  if (changed) await saveChatBots(dispatcherId, state);
  return added;
}

/**
 * The chat's pending one-shot discovery context, snapshotted for a
 * generation-safe clear (issue #69). The deliver path reads this before
 * enqueue, injects the trusted bots when `needsBaseline`, and clears via
 * `clearBaselineIfCurrent` only after a successful submission.
 */
export async function pendingBaseline(
  dispatcherId: string,
  chatId: string,
): Promise<PendingBaseline> {
  const entry = (await loadChatBots(dispatcherId)).chats[chatId];
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
  dispatcherId: string,
  chatId: string,
  generation: number,
): Promise<void> {
  const state = await loadChatBots(dispatcherId);
  const entry = state.chats[chatId];
  if (entry === undefined || !entry.needsBaseline) return;
  if (entry.baselineGeneration !== generation) return;
  entry.needsBaseline = false;
  await saveChatBots(dispatcherId, state);
}

/** Known and trusted peer bots for one chat (the `list_chat_bots` tool). */
export async function listChatBots(
  dispatcherId: string,
  chatId: string,
): Promise<ChatBotsListing> {
  const entry = (await loadChatBots(dispatcherId)).chats[chatId];
  if (entry === undefined) return { known: [], trusted: [] };
  return {
    known: peerBotsFrom(entry, entry.known),
    trusted: peerBotsFrom(entry, entry.trusted),
  };
}

/** The trust set the gate consults for one chat. */
export async function trustedBotIds(
  dispatcherId: string,
  chatId: string,
): Promise<Set<string>> {
  return new Set((await loadChatBots(dispatcherId)).chats[chatId]?.trusted ?? []);
}

/**
 * Record an `im.chat.member.bot.added_v1` event: mark the chat as needing a
 * baseline injection. Idempotent by event id — a redelivered event is a no-op.
 * Returns true when the event was newly recorded.
 */
export async function recordBotAdded(
  dispatcherId: string,
  chatId: string,
  eventId: string,
): Promise<boolean> {
  const state = await loadChatBots(dispatcherId);
  const entry = entryFor(state, chatId);
  if (eventId !== '' && entry.seenEventIds.includes(eventId)) return false;
  if (eventId !== '') {
    entry.seenEventIds.push(eventId);
    while (entry.seenEventIds.length > MAX_SEEN_EVENT_IDS) entry.seenEventIds.shift();
  }
  markBaseline(entry);
  await saveChatBots(dispatcherId, state);
  return true;
}

function recordName(entry: ChatBotsEntry, bot: PeerBot): boolean {
  if (bot.name === undefined || bot.name === '') return false;
  if (entry.names[bot.openId] === bot.name) return false;
  entry.names[bot.openId] = bot.name;
  return true;
}

function normalizeChatBots(raw: unknown): ChatBotsState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultChatBotsState();
  }
  const chatsRaw = (raw as Record<string, unknown>)['chats'];
  const chats: Record<string, ChatBotsEntry> = {};
  if (chatsRaw !== null && typeof chatsRaw === 'object' && !Array.isArray(chatsRaw)) {
    for (const [chatId, value] of Object.entries(chatsRaw as Record<string, unknown>)) {
      chats[chatId] = normalizeEntry(value);
    }
  }
  return { version: 1, chats };
}

function normalizeEntry(raw: unknown): ChatBotsEntry {
  const entry = emptyEntry();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return entry;
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
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))];
}
