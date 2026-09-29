/**
 * Owns the session's access state and every gate, pairing, and approval
 * transition. Inbound owns message IO: it asks for a gate decision, sends the
 * card or reference outside the store queue, then records successful delivery.
 * Access is loaded lazily, so a malformed file fails the operation that reads it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { errorInfo, TransactionalStore } from '@excitedjs/dreamux-utils';
import {
  ACCESS_STATE_VERSION,
  PAIRING_TTL_MS,
  PAIRING_TOKEN_REGEX,
  defaultDispatcherAccessState,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type PendingPairingEntry,
} from './state.js';

import {
  dreamuxFeishuGate,
  type GateAction,
  type GateInbound,
  type GateResult,
} from './gate.js';
import { introduceDenyReason } from '../introduce.js';

type PairingAction = Extract<GateAction, { action: 'pair' }>;

const V3_FAIL_MSG =
  'access.json must be v3 shape — copy allow_users to v3, add dm_policy + pending fields, then restart. See CHANGELOG.md and /.agents/domains/feishu-pairing-access.md.';

function isV3Shape(x: unknown): x is DispatcherAccessStateV3 {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.version !== ACCESS_STATE_VERSION) return false;
  if (typeof o.dm_policy !== 'string') return false;
  if (!o.group || typeof o.group !== 'object') return false;
  const g = o.group as Record<string, unknown>;
  if (typeof g.policy !== 'string') return false;
  if (!Array.isArray(g.allow_chats)) return false;
  if (typeof g.require_mention !== 'boolean') return false;
  if (!Array.isArray(o.allow_users)) return false;
  if (!o.pending || typeof o.pending !== 'object') return false;
  return true;
}

/**
 * A pending entry with every required field (`sender_id`, `chat_id`,
 * `expires_at`, `created_at`) present and correctly typed: missing or
 * wrong-type fields are rejected rather than backed by an invented value.
 * `prompt_message_id` is optional on the type, so it is carried through only
 * when present and typed right, omitted otherwise.
 */
function readPendingEntry(x: unknown): PendingPairingEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  if (typeof e.sender_id !== 'string') return null;
  if (typeof e.chat_id !== 'string') return null;
  if (typeof e.expires_at !== 'number') return null;
  if (typeof e.created_at !== 'number') return null;
  return {
    sender_id: e.sender_id,
    chat_id: e.chat_id,
    expires_at: e.expires_at,
    created_at: e.created_at,
    ...(typeof e.prompt_message_id === 'string'
      ? { prompt_message_id: e.prompt_message_id }
      : {}),
  };
}

export interface PairingApprovalResult {
  status: 'ok' | 'not_found' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

export interface FeishuAccessOptions {
  /** The dispatcher's durable state directory; `access.json` sits under it. */
  stateDir: string;
  dispatcherId: string;
  log: DreamuxLogger;
}

export class FeishuAccess {
  private readonly store: TransactionalStore<DispatcherAccessState>;
  private readonly dispatcherId: string;
  private readonly log: DreamuxLogger;

  constructor(opts: FeishuAccessOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.log = opts.log;
    // Never loaded at session start — the first gate decision loads it, and
    // an unreadable file fails that one operation rather than the session
    // start.
    this.store = new TransactionalStore({
      path: join(opts.stateDir, 'access.json'),
      load: () => this.readFromDisk(opts.stateDir),
      dirMode: 0o700,
    });
  }

  /** Snapshot the policy used before bot observation or /introduce. */
  async inboundPolicy(input: {
    chatType: 'p2p' | 'group';
    chatId: string;
    senderId: string;
  }) {
    await this.store.load();
    const state = this.store.current;
    return {
      observeBots: state.group.allow_chats.includes(input.chatId),
      introduceDenyReason: introduceDenyReason(state, input),
    };
  }

  /**
   * What the gate would decide for this person, against the held state,
   * committing nothing. For a caller that is not answering a message and so has
   * no conversation to send a pairing card into: a `pair` outcome here mints a
   * token nobody stores, and it means "not admitted" like a drop does.
   */
  async decide(inbound: GateInbound): Promise<GateAction> {
    await this.store.load();
    return dreamuxFeishuGate(this.store.current, inbound).action;
  }

  /**
   * Whether `group.allow_chats` lists this chat. The operator lists group
   * chats there, so a listed chat's kind is known without asking Feishu.
   */
  async listsChat(chatId: string): Promise<boolean> {
    await this.store.load();
    return this.store.current.group.allow_chats.includes(chatId);
  }

  /** Commit deliver/drop; pairing waits until its message has been sent. */
  async gate(inbound: GateInbound): Promise<GateAction> {
    let result!: GateResult;
    await this.store.update((current) => {
      result = dreamuxFeishuGate(current, inbound);
      return result.action.action === 'pair' ? current : result.nextState;
    });
    for (const entry of result.logs) {
      const level =
        entry.level === 'error' || entry.level === 'warn'
          ? entry.level
          : 'debug';
      this.log[level](entry.ctx ?? {}, `[feishu-gate] ${entry.msg}`);
    }
    return result.action;
  }

  /** Refresh an existing prompt only after inbound successfully references it. */
  async refreshPairing(action: PairingAction): Promise<void> {
    await this.store.update((current) => {
      const existing = current.pending[action.token];
      if (existing === undefined) return current;
      return {
        ...current,
        pending: {
          ...current.pending,
          [action.token]: {
            ...existing,
            expires_at: Date.now() + PAIRING_TTL_MS,
            prompt_message_id:
              existing.prompt_message_id ?? action.prompt_message_id,
          },
        },
      };
    });
  }

  /** Merge a sent card into the latest state, including any concurrent approval. */
  async recordPairingPrompt(
    inbound: GateInbound,
    action: PairingAction,
    messageId: string | undefined,
  ): Promise<void> {
    await this.store.update((current) => {
      // Approved mid-window? Skip entirely.
      if (
        action.kind === 'dm' &&
        current.allow_users.includes(inbound.sender_id)
      ) {
        return current;
      }
      if (
        action.kind === 'group' &&
        current.group.allow_chats.includes(inbound.chat_id)
      ) {
        return current;
      }
      // Another pending entry for the same sender exists? For a resend from
      // an older entry without a prompt message id, attach the newly-sent
      // card id and refresh the TTL. Otherwise do not clobber a concurrent
      // sender's already-recorded token.
      const existingKey = Object.entries(current.pending).find(
        ([, e]) => e.sender_id === inbound.sender_id,
      );
      if (existingKey !== undefined) {
        if (!action.is_resend) return current;
        const [token, existing] = existingKey;
        const bumped: PendingPairingEntry = {
          ...existing,
          expires_at: Date.now() + PAIRING_TTL_MS,
          prompt_message_id: existing.prompt_message_id ?? messageId,
        };
        return {
          ...current,
          pending: { ...current.pending, [token]: bumped },
        };
      }
      // Merge with fresh TTL (send succeeded right now).
      const entry: PendingPairingEntry = {
        sender_id: inbound.sender_id,
        chat_id: inbound.chat_id,
        created_at: Date.now(),
        expires_at: Date.now() + PAIRING_TTL_MS,
        prompt_message_id: messageId,
      };
      return {
        ...current,
        pending: { ...current.pending, [action.token]: entry },
      };
    });
  }

  /**
   * Load access.json from `stateDir`. Fails LOUDLY if the file exists but the
   * shape is not v3, or a `pending` entry is missing/mistyped on `sender_id`,
   * `chat_id`, `expires_at`, or `created_at`. A missing file returns the
   * secure default (pairing DM default, empty allowlists).
   *
   * Reconstructs the returned value field by field rather than casting
   * `parsed` as-is, so an old file's now-dropped ledger fields (`last_gate`,
   * `observed_chats`, `warnings`) or per-entry fields (`kind`, `replies`) are
   * read and discarded, never round-tripped into memory or back to disk.
   */
  private async readFromDisk(
    stateDir: string,
  ): Promise<DispatcherAccessStateV3> {
    const path = join(stateDir, 'access.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return defaultDispatcherAccessState();
      throw new Error(`Failed to read access.json: ${e.message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse access.json: ${(err as Error).message}. ${V3_FAIL_MSG}`,
      );
    }
    if (!isV3Shape(parsed)) throw new Error(V3_FAIL_MSG);
    const pending: Record<string, PendingPairingEntry> = {};
    for (const [token, rawEntry] of Object.entries(parsed.pending)) {
      const entry = readPendingEntry(rawEntry);
      if (entry === null) throw new Error(V3_FAIL_MSG);
      pending[token] = entry;
    }
    return {
      version: ACCESS_STATE_VERSION,
      dm_policy: parsed.dm_policy,
      group: {
        policy: parsed.group.policy,
        allow_chats: parsed.group.allow_chats,
        require_mention: parsed.group.require_mention,
      },
      allow_users: parsed.allow_users,
      pending,
    };
  }

  /**
   * Approve a pending pairing by its internal 6-hex token.
   *
   * Behavior:
   *   - Normalizes `token` to lowercase (the gate stores lowercased tokens).
   *   - Returns `not_found` when the token is unknown or expired (we reject
   *     expired entries explicitly, not just "not found", so the operator
   *     gets the right diagnostic).
   *   - Adds the DM sender to `allow_users`. Idempotent on allowlist
   *     membership (we detect duplicates via allowlist presence, not by
   *     whether the pending entry still has the slot), and always removes
   *     the pending key after a successful approval — the
   *     allowlist IS the source of truth, a pending entry is just a
   *     temporary token.
   *   - Details include `duplicate` flag, `ttl_left_ms`, `sender_id`,
   *     `chat_id`, `kind` for audit logging.
   *
   * The whole decide-and-write runs inside one `store.update()`, so it is
   * serialized against every other access-state change this class makes.
   * `not_found` and the duplicate-but-still-consumes-the-slot case are decided
   * inside the `update` and returned unchanged (no write); the decide logic
   * itself cannot throw. But `update()` also self-loads the store on its
   * first call (never loaded at session start), and that load can throw on a
   * malformed `access.json` — the `catch` below answers that case too, as
   * `status: 'error'`.
   */
  async approvePairingByToken(token: string): Promise<PairingApprovalResult> {
    if (!PAIRING_TOKEN_REGEX.test(token)) {
      return {
        status: 'error',
        message: '授权请求格式错误',
      };
    }
    const lowerToken = token.toLowerCase();
    let matchedEntry: PendingPairingEntry | undefined;
    let result!: PairingApprovalResult;
    try {
      await this.store.update((state) => {
        const entry = state.pending[lowerToken];
        const now = Date.now();
        if (entry === undefined || entry.expires_at <= now) {
          result = {
            status: 'not_found',
            message: '授权请求不存在或已过期',
            details: { token: lowerToken },
          };
          return state;
        }
        matchedEntry = entry;

        // Clone so we can mutate
        const next: DispatcherAccessStateV3 = {
          ...state,
          pending: { ...state.pending },
          allow_users: [...state.allow_users],
        };
        let duplicate = false;

        if (next.allow_users.includes(entry.sender_id)) {
          duplicate = true;
        } else {
          next.allow_users = [...next.allow_users, entry.sender_id];
        }

        // Always remove the pending entry (allowlist membership is the
        // durable approval; a re-approved duplicate token still consumes
        // its single-use slot).
        delete next.pending[lowerToken];

        const ttlLeftMs = Math.max(0, entry.expires_at - now);
        const who = `用户 ${entry.sender_id}`;
        result = {
          status: 'ok',
          message: duplicate
            ? `${who} 已在允许列表，授权请求已关闭`
            : `已批准 ${who} 访问`,
          details: {
            duplicate,
            kind: 'dm',
            ttl_left_ms: ttlLeftMs,
            sender_id: entry.sender_id,
            chat_id: entry.chat_id,
          },
        };
        return next;
      });
    } catch (err) {
      this.log.error(
        {
          dispatcher_id: this.dispatcherId,
          pairing_token_len: lowerToken.length,
          ...(matchedEntry !== undefined
            ? {
                sender_id: matchedEntry.sender_id,
                chat_id: matchedEntry.chat_id,
              }
            : {}),
          err: errorInfo(err),
        },
        '[card-action] failed to persist pairing approval',
      );
      return {
        status: 'error',
        message: '授权写入失败，请重试',
        details: { token: lowerToken },
      };
    }
    return result;
  }

  /**
   * Whether this sender is one of the Dispatcher's trusted humans.
   *
   * Reads this class's own held access store — the same store every gate
   * decision and pairing write goes through — rather than a fresh disk read,
   * so this always sees the value the running session actually committed
   * last.
   */
  async isTrustedDispatcherUser(openId: string): Promise<boolean> {
    await this.store.load();
    return this.store.current.allow_users.includes(openId);
  }
}
