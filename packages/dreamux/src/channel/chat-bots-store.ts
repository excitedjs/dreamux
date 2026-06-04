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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
  /** Set when the bot is added to this chat; consumed by a later baseline inject. */
  needsBaseline: boolean;
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

export function defaultChatBotsState(): ChatBotsState {
  return { version: 1, chats: {} };
}

function emptyEntry(): ChatBotsEntry {
  return { known: [], trusted: [], names: {}, needsBaseline: false, seenEventIds: [] };
}

/**
 * Load the store. Unlike the access store, a corrupt or unreadable chat-bots
 * file is not security-critical — it only affects peer-bot discovery — so a
 * load failure degrades to an empty store rather than throwing.
 */
export function loadChatBots(dispatcherId: string): ChatBotsState {
  const path = dispatcherChatBotsPath(dispatcherId);
  if (!existsSync(path)) return defaultChatBotsState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return normalizeChatBots(parsed);
  } catch {
    return defaultChatBotsState();
  }
}

export function saveChatBots(dispatcherId: string, state: ChatBotsState): void {
  const path = dispatcherChatBotsPath(dispatcherId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function entryFor(state: ChatBotsState, chatId: string): ChatBotsEntry {
  const existing = state.chats[chatId];
  if (existing !== undefined) return existing;
  const created = emptyEntry();
  state.chats[chatId] = created;
  return created;
}

/** Record a passively observed peer bot as *known* (awareness only). */
export function observeKnownBot(
  dispatcherId: string,
  chatId: string,
  bot: PeerBot,
): void {
  if (bot.openId === '') return;
  const state = loadChatBots(dispatcherId);
  const entry = entryFor(state, chatId);
  let changed = recordName(entry, bot);
  if (!entry.known.includes(bot.openId)) {
    entry.known.push(bot.openId);
    changed = true;
  }
  if (changed) saveChatBots(dispatcherId, state);
}

/**
 * Record peer bots introduced by an allowlisted `/introduce` as *trusted*.
 * Trusted bots are also known. Returns the open_ids newly added to trust.
 */
export function trustIntroducedBots(
  dispatcherId: string,
  chatId: string,
  bots: PeerBot[],
): string[] {
  const state = loadChatBots(dispatcherId);
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
  if (changed) saveChatBots(dispatcherId, state);
  return added;
}

/** The trust set the gate consults for one chat. */
export function trustedBotIds(dispatcherId: string, chatId: string): Set<string> {
  return new Set(loadChatBots(dispatcherId).chats[chatId]?.trusted ?? []);
}

/**
 * Record an `im.chat.member.bot.added_v1` event: mark the chat as needing a
 * baseline injection. Idempotent by event id — a redelivered event is a no-op.
 * Returns true when the event was newly recorded.
 */
export function recordBotAdded(
  dispatcherId: string,
  chatId: string,
  eventId: string,
): boolean {
  const state = loadChatBots(dispatcherId);
  const entry = entryFor(state, chatId);
  if (eventId !== '' && entry.seenEventIds.includes(eventId)) return false;
  if (eventId !== '') {
    entry.seenEventIds.push(eventId);
    while (entry.seenEventIds.length > MAX_SEEN_EVENT_IDS) entry.seenEventIds.shift();
  }
  entry.needsBaseline = true;
  saveChatBots(dispatcherId, state);
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
