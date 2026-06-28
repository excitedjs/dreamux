/**
 * Feishu access gate v3 — IO + UI helpers.
 *
 * Split out from `feishu-gate.ts` to keep the pure gate under the max-lines
 * lint rule. Owns:
 *   - v3 shape validation + fail-loud loader/saver
 *   - pairing-prompt text rendering
 *
 * The pure decision logic (`dreamuxFeishuGate`, types, constants) lives in
 * `feishu-gate.ts`.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '@excitedjs/dreamux-utils';
import {
  ACCESS_STATE_VERSION,
  defaultDispatcherAccessState,
  type DispatcherAccessStateV3,
} from './feishu-gate.js';

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

// Alias retained so the session's `loadDispatcherAccess` import still
// compiles through a rename. Prefer the explicit `readDispatcherAccess` in
// new code.
export { readDispatcherAccess as loadDispatcherAccess };
