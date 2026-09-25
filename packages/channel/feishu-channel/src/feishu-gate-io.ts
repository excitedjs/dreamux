/**
 * Feishu access gate v3 — state IO and everything that mutates persisted
 * access state directly. Owns:
 *   - v3 shape validation + fail-loud loader (`readDispatcherAccess`), which
 *     is also the `load` option the session's held `TransactionalStore`
 *     builds with — the store owns every write from here on
 *   - turning an approved pairing token into an `allow_users` entry: the one
 *     access-state mutation that answers a card click rather than a gate
 *     decision
 *
 * The pure decision logic (`dreamuxFeishuGate`, types, constants) lives in
 * `feishu-gate.ts`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { TransactionalStore } from '@excitedjs/dreamux-utils';
import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_REGEX,
  defaultDispatcherAccessState,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type PendingPairingEntry,
} from './feishu-gate.js';

function errInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack !== undefined
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
  }
  return { message: String(err) };
}

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
 * `expires_at`, `created_at`) present and correctly typed, per R21: reject
 * missing/wrong-type fields rather than invent a value. `prompt_message_id`
 * is optional on the type, so it is carried through only when present and
 * typed right, omitted otherwise.
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

/**
 * Load access.json from stateDir. Fails LOUDLY if file exists but shape is
 * not v3, or a `pending` entry is missing/mistyped on `sender_id`, `chat_id`,
 * `expires_at`, or `created_at`. Missing file returns the secure default
 * (pairing DM default, empty allowlists).
 *
 * Reconstructs the returned value field by field rather than casting `parsed`
 * as-is, so an old file's now-dropped ledger fields (`last_gate`,
 * `observed_chats`, `warnings`) or per-entry fields (`kind`, `replies`) are
 * read and discarded, never round-tripped into memory or back to disk.
 */
export async function readDispatcherAccess(
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

export interface PairingApprovalResult {
  status: 'ok' | 'not_found' | 'error';
  message: string;
  details?: Record<string, unknown>;
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
 * serialized against every other access-state change the session makes.
 * `not_found` and the duplicate-but-still-consumes-the-slot case are decided
 * inside the `update` and returned unchanged (no write); the decide logic
 * itself cannot throw. But `update()` also self-loads the store on its first
 * call (never loaded at session start, per the store's own contract), and
 * that load can throw on a malformed `access.json` — a case the old code left
 * unhandled (the read sat inside the mutex's `lock`, outside any try/catch,
 * so it would have propagated as an unhandled rejection out of a card click
 * that arrived before any message had loaded the store). The `catch` below
 * now answers that case too, as `status: 'error'`; the message still says
 * "写入失败" (write failed) even though the failure may be a load, since no
 * named scenario justifies a second error message for what is already a rare,
 * fail-loud-at-the-daemon-level condition.
 */
export async function approvePairingByToken(
  session: {
    accessStore: TransactionalStore<DispatcherAccessState>;
    dispatcherId: string;
    log: DreamuxLogger;
  },
  token: string,
): Promise<PairingApprovalResult> {
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
    await session.accessStore.update((state) => {
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
    session.log.error(
      {
        dispatcher_id: session.dispatcherId,
        pairing_token_len: lowerToken.length,
        ...(matchedEntry !== undefined
          ? {
              sender_id: matchedEntry.sender_id,
              chat_id: matchedEntry.chat_id,
            }
          : {}),
        err: errInfo(err),
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
 * Reads the session's own held access store — the same store every gate
 * decision and pairing write goes through — rather than a fresh disk read, so
 * this always sees the value the running session actually committed last.
 *
 * It answers here rather than at its caller because a caller outside the gate
 * has no other reason to hold an access state — not because the field has a
 * single reader. The gate tests `allow_users` inline against state it already
 * loaded, and routing those through a second read would only add one.
 */
export async function isTrustedDispatcherUser(
  store: TransactionalStore<DispatcherAccessState>,
  openId: string,
): Promise<boolean> {
  await store.load();
  return store.current.allow_users.includes(openId);
}
