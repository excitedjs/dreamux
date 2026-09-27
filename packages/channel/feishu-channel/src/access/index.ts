/**
 * `FeishuAccess` — the session's one held access-state store and every IO or
 * mutation that answers something other than a gate decision: the v3
 * fail-loud loader, turning an approved pairing token into an `allow_users`
 * entry, and the trusted-human check a subscribed-document comment gate
 * reuses.
 *
 * The pure decision logic (`dreamuxFeishuGate`, types, constants) lives in
 * `./gate.js` over the shape `./state.js` declares; a gate decision itself
 * still runs through this class's own `load`/`current`/`update` so every
 * access-state mutation is serialized against the same queue, whether it
 * answers a gate decision or a card click.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { errorInfo, TransactionalStore } from '@excitedjs/dreamux-utils';
import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_REGEX,
  defaultDispatcherAccessState,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type PendingPairingEntry,
} from './state.js';

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

  /** Read once; concurrent callers share the in-flight read. */
  load(): Promise<DispatcherAccessState> {
    return this.store.load();
  }

  /** The last committed access state. Throws before a successful `load()`. */
  get current(): DispatcherAccessState {
    return this.store.current;
  }

  /** Change the committed access state; see `TransactionalStore.update`. */
  update(
    change: (
      current: DispatcherAccessState,
    ) => DispatcherAccessState | Promise<DispatcherAccessState>,
  ): Promise<DispatcherAccessState> {
    return this.store.update(change);
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
