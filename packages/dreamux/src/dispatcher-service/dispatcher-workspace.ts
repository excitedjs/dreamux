import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { DreamuxConfig } from '../config/config.js';

/**
 * Dispatcher workspace cwd policy (issue #182 PR-4).
 *
 * Every configured dispatcher MUST declare an explicit `cwd`: there is no
 * fallback to a Dreamux state directory (`~/.dreamux/state/<id>/cwd`). The
 * workspace is the dispatcher agent's working directory AND the root under
 * which Dreamux-managed TeamMate/Team worktrees live
 * (`<workspace>/.workspace/worktree/...`), so it must be a real, operator-owned
 * project directory — never inside Dreamux's own state tree.
 *
 * The policy is enforced loud at server startup and the dispatcher launch path,
 * and diagnosed (non-throwing) by `dreamux doctor`.
 */

/**
 * The configured, absolute dispatcher workspace cwd, or `null` when the
 * dispatcher declares no `cwd`. Pure: it resolves the configured value to an
 * absolute path but touches no filesystem.
 */
export function configuredDispatcherCwd(
  config: DreamuxConfig,
  dispatcherId: string,
): string | null {
  const entry = config.dispatchers.find((dispatcher) => dispatcher.id === dispatcherId);
  const cwd = entry?.cwd ?? null;
  if (cwd === null || cwd.trim() === '') return null;
  return resolve(cwd);
}

/**
 * Resolve and validate a dispatcher's workspace cwd, failing loud when the
 * contract is broken (issue #182 PR-4):
 *
 *  - no explicit `cwd` configured → throw (no state-dir fallback);
 *  - cwd configured but missing → created with `mkdir -p` semantics;
 *  - cwd not a directory, or not read/write/exec accessible → throw.
 *
 * Returns the absolute, validated workspace path. Idempotent: safe to call at
 * startup pre-flight and again per dispatcher launch / teammate spawn.
 */
export async function ensureDispatcherWorkspace(
  config: DreamuxConfig,
  dispatcherId: string,
): Promise<string> {
  const cwd = configuredDispatcherCwd(config, dispatcherId);
  if (cwd === null) {
    throw new Error(
      `dispatcher ${JSON.stringify(dispatcherId)} has no configured \`cwd\`; ` +
        'set an explicit workspace directory in ~/.dreamux/config.json — dreamux ' +
        'no longer falls back to a state directory (issue #182)',
    );
  }
  try {
    await mkdir(cwd, { recursive: true });
  } catch (err) {
    throw new Error(
      `dispatcher ${JSON.stringify(dispatcherId)} workspace cwd could not be ` +
        `created: ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let info;
  try {
    info = await stat(cwd);
  } catch (err) {
    throw new Error(
      `dispatcher ${JSON.stringify(dispatcherId)} workspace cwd is not ` +
        `accessible: ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      `dispatcher ${JSON.stringify(dispatcherId)} workspace cwd is not a ` +
        `directory: ${cwd}`,
    );
  }
  try {
    await access(cwd, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (err) {
    throw new Error(
      `dispatcher ${JSON.stringify(dispatcherId)} workspace cwd is not ` +
        `read/write accessible: ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return cwd;
}

export interface DispatcherWorkspaceDiagnosis {
  ok: boolean;
  detail: string;
}

/**
 * Non-throwing variant for `dreamux doctor`: reports the cwd contract state
 * without creating or mutating anything. A configured-but-missing directory is
 * not an error — server startup creates it — but a missing/empty `cwd`, a
 * non-directory, or an inaccessible directory is.
 */
export async function diagnoseDispatcherWorkspace(
  config: DreamuxConfig,
  dispatcherId: string,
): Promise<DispatcherWorkspaceDiagnosis> {
  const cwd = configuredDispatcherCwd(config, dispatcherId);
  if (cwd === null) {
    return {
      ok: false,
      detail:
        'no configured `cwd`; set an explicit workspace directory in config.json ' +
        '(dreamux no longer falls back to a state directory)',
    };
  }
  let info;
  try {
    info = await stat(cwd);
  } catch {
    return { ok: true, detail: `${cwd} (missing; created at server startup)` };
  }
  if (!info.isDirectory()) {
    return { ok: false, detail: `${cwd} exists but is not a directory` };
  }
  try {
    await access(cwd, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return { ok: false, detail: `${cwd} is not read/write accessible` };
  }
  return { ok: true, detail: cwd };
}
