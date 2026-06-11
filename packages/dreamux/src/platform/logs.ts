/**
 * Log-file hygiene helpers (issue #182 logs stage).
 *
 * Runtime child stdout/stderr logs are opened eagerly as inherited fds before
 * the child produces any output (the supervisor must hand the child a valid fd
 * at spawn time, so they cannot be created lazily). Normal Codex traffic flows
 * over the Unix socket and normal Claude Code traffic over the resident stream,
 * so these files mostly stay empty and would otherwise accumulate one zero-byte
 * file per runtime start. After a clean child shutdown the owning supervisor
 * calls {@link removeEmptyLogFile} on each child log path to drop the empties
 * while keeping any file that actually captured startup/crash output.
 *
 * This is per-child self-cleanup of files this process created — NOT age-based
 * pruning of the operator's accumulated logs, which #182 keeps manual.
 */

import { stat, unlink } from 'node:fs/promises';

/**
 * Remove `path` only if it exists and is zero bytes. Best-effort: a missing
 * file, a non-empty file, or any IO error leaves things untouched and never
 * throws, so teardown is never blocked by log hygiene.
 */
export async function removeEmptyLogFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size === 0) await unlink(path);
  } catch {
    /* best effort — missing/busy/non-empty files are left as-is */
  }
}
