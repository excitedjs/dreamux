/**
 * Realpath-confine a TeamMate worker's cwd to the dispatcher directory
 * (issue #126; extracted in PR4 so the Codex and Claude Code workers share one
 * containment primitive rather than duplicating a security check).
 *
 * PR1 only folded `..`/`.` lexically and deferred symlink resolution to the
 * worker slice. Both the dispatcher dir and the target are canonicalized through
 * their longest existing prefix (a not-yet-created leaf cannot be a symlink, so
 * its lexical tail is safe to re-append), then containment is re-checked. The
 * caller must run this BEFORE spawning anything and must treat a throw as a hard
 * refusal (no process created), not a retryable `unavailable`.
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Resolve a worker cwd, confined to the dispatcher dir. With no target the
 * dispatcher dir itself is the cwd (it is the containment root). Throws on a
 * post-symlink escape.
 */
export async function resolveConfinedWorkerCwd(
  targetPath: string | null,
  dispatcherDir: string,
): Promise<string> {
  const base = await canonicalizeExisting(dispatcherDir);
  if (targetPath === null) return base;
  const real = await canonicalizeExisting(targetPath);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (real !== base && !real.startsWith(prefix)) {
    throw new Error(
      'TeamMate target escapes the dispatcher directory after symlink ' +
        'resolution; refusing to launch a worker outside the dispatcher tree',
    );
  }
  return real;
}

/**
 * Resolve symlinks in the longest existing prefix of `p`, then re-append the
 * non-existent tail segments lexically. `realpath` throws `ENOENT` for a path
 * whose leaf does not exist yet (a worker may target a dir the runtime will
 * create), so walk up to the nearest existing ancestor and canonicalize that.
 */
export async function canonicalizeExisting(p: string): Promise<string> {
  let current = resolve(p);
  if (!isAbsolute(current)) {
    throw new Error(`worker cwd must resolve to an absolute path: ${p}`);
  }
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without an existing ancestor.
        throw new Error(`worker cwd has no existing ancestor: ${p}`);
      }
      tail.push(basename(current));
      current = parent;
    }
  }
}
