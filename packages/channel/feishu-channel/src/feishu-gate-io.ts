/**
 * Feishu access gate v3 — state IO and everything that mutates persisted
 * access state directly. Owns:
 *   - v3 shape validation + fail-loud loader/saver
 *   - turning an approved pairing token into an `allow_users` entry: the one
 *     access-state mutation that answers a card click rather than a gate
 *     decision
 *
 * The pure decision logic (`dreamuxFeishuGate`, types, constants) lives in
 * `feishu-gate.ts`.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { writeAtomic } from '@excitedjs/dreamux-utils';
import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_REGEX,
  defaultDispatcherAccessState,
  type DispatcherAccessStateV3,
} from './feishu-gate.js';
import type { AsyncMutex } from './lib/mutex.js';

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
 * Load access.json from stateDir. Fails LOUDLY if file exists but shape is
 * not v3. Missing file returns the secure default (pairing DM default,
 * empty allowlists).
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
  return parsed;
}

/**
 * Persist access state atomically (tmpfile → rename, mode 0600). Refuses to
 * write non-v3 state. Creates stateDir with mode 0700 if missing.
 */
export async function saveDispatcherAccess(
  stateDir: string,
  state: DispatcherAccessStateV3,
): Promise<void> {
  if (!isV3Shape(state)) {
    throw new Error('saveDispatcherAccess: refusing to write non-v3 state');
  }
  try {
    await stat(stateDir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      await mkdir(stateDir, { mode: 0o700, recursive: true });
    } else {
      throw new Error(`stat state dir: ${e.message}`);
    }
  }
  const payload = JSON.stringify(state, null, 2) + '\n';
  await writeAtomic(stateDir, 'access.json', payload, 0o600);
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
 * `accessMutex` is the caller's session-scoped serialization on access.json;
 * this function does not own it, only locks it for its own read-modify-write.
 */
export async function approvePairingByToken(
  session: {
    stateDir: string;
    accessMutex: AsyncMutex;
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
  return session.accessMutex.lock(async () => {
    const state = await readDispatcherAccess(session.stateDir);
    const entry = state.pending[lowerToken];
    const now = Date.now();
    if (entry === undefined || entry.expires_at <= now) {
      return {
        status: 'not_found',
        message: '授权请求不存在或已过期',
        details: { token: lowerToken },
      };
    }

    if (entry.kind !== 'dm') {
      return {
        status: 'error',
        message: '授权请求类型已不再支持',
        details: { token: lowerToken, kind: entry.kind },
      };
    }

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

    try {
      await saveDispatcherAccess(session.stateDir, next);
    } catch (err) {
      session.log.error(
        {
          dispatcher_id: session.dispatcherId,
          pairing_token_len: lowerToken.length,
          sender_id: entry.sender_id,
          chat_id: entry.chat_id,
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

    const ttlLeftMs = Math.max(0, entry.expires_at - now);
    const who = `用户 ${entry.sender_id}`;
    return {
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
  });
}

/**
 * Whether this sender is one of the Dispatcher's trusted humans.
 *
 * Read-only, and deliberately not under the access mutex: the mutex serializes
 * the gate's *writes*, and asking who is trusted mutates nothing. The state is
 * written by rename, so a read racing a write sees one whole version or the
 * other.
 *
 * It answers here rather than at its caller because a caller outside the gate
 * has no other reason to hold an access state — not because the field has a
 * single reader. The gate tests `allow_users` inline against state it already
 * loaded, and routing those through a second read would only add one.
 */
export async function isTrustedDispatcherUser(
  stateDir: string,
  openId: string,
): Promise<boolean> {
  return (await readDispatcherAccess(stateDir)).allow_users.includes(openId);
}

// Alias retained so the session's `loadDispatcherAccess` import still
// compiles through a rename. Prefer the explicit `readDispatcherAccess` in
// new code.
export { readDispatcherAccess as loadDispatcherAccess };
