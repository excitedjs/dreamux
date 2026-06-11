/**
 * Volatile Unix-socket allocation for agent-runtime child processes
 * (issue #182 PR-1).
 *
 * A runtime socket is a pure per-process rendezvous endpoint: dreamux starts a
 * child listening on the path and connects to it immediately. Nothing resumes
 * from a socket path, so every allocation is a fresh short random name and the
 * path must never be persisted into durable state (identity, history, ledger,
 * checkpoint, or status surfaces) — it lives only in supervisor/runtime memory.
 *
 * Placement preference (the allocator picks the first that fits the `sun_path`
 * budget):
 *   1. `$XDG_RUNTIME_DIR/dreamux/sockets/` — the canonical private per-user
 *      runtime dir on Linux. It is operator input, so a shared-tmp value is
 *      rejected rather than trusted.
 *   2. `~/.dreamux/run/sockets/` — the dreamux-owned volatile run root.
 *   3. `<os-private-temp>/dreamux/sockets/` — the per-user OS temp dir **only
 *      when it is a private root, not world-shared `/tmp`** (issue #182 final
 *      gate). On macOS `os.tmpdir()` is the per-user `$TMPDIR`
 *      (`/var/folders/<…>/T`, owner-only) and is far shorter than a long
 *      per-run durable `$HOME`, so it keeps Codex sockets within budget when
 *      there is no `$XDG_RUNTIME_DIR` and `~/.dreamux/run/sockets/` is over
 *      budget. On Linux `os.tmpdir()` is `/tmp` (shared) and is rejected, so
 *      this candidate never reintroduces a world-shared tmp socket.
 * Shared world-writable tmp roots (`/tmp`, `/var/tmp`) are never used for
 * sockets (global-bin decision record). When no candidate fits the `sun_path`
 * budget, allocation fails loudly.
 *
 * The supervisor owning a socket remains responsible for mkdir, stale-socket
 * removal before bind, and removal on stop/reap. `sweepRuntimeSocketDirs()`
 * additionally clears crash orphans; it must only run while the caller holds
 * the admin-socket lock (single-server guarantee), so every entry is dead.
 */

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';

import {
  assertUnixSocketPathBudget,
  runRoot,
  unixSocketPathFitsBudget,
} from './paths.js';

/**
 * Shared world-writable system tmp roots. `/private/tmp` and
 * `/private/var/tmp` are the macOS symlink-resolved spellings of `/tmp` and
 * `/var/tmp`, so a canonicalized path must not slip past the guard.
 */
const SHARED_TMP_ROOTS = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];

export function isSharedTmpPath(path: string): boolean {
  const normalized = normalize(path);
  return SHARED_TMP_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}${sep}`),
  );
}

/**
 * Candidate directories for volatile runtime sockets, in preference order.
 * Every candidate is dreamux-owned (a `dreamux` subtree or the run root), so
 * sweeping them whole is safe under the single-server lock.
 */
export function runtimeSocketDirCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const xdg = env['XDG_RUNTIME_DIR'];
  if (xdg !== undefined && xdg.trim() !== '' && !isSharedTmpPath(xdg)) {
    candidates.push(join(xdg, 'dreamux', 'sockets'));
  }
  candidates.push(join(runRoot(), 'sockets'));
  // Per-user OS temp dir, but only when it is a PRIVATE root (macOS `$TMPDIR`
  // = `/var/folders/<…>/T`, owner-only) — never world-shared `/tmp` (Linux),
  // which `isSharedTmpPath` rejects. This is the short, private fallback that
  // keeps sockets within the `sun_path` budget on macOS with no
  // `$XDG_RUNTIME_DIR` and a long per-run `$HOME` (issue #182 final gate). It
  // is consulted after the dreamux-owned run root, so short-`$HOME` placement
  // is unchanged; the supervisor still enforces owner-only on the dir.
  const tmp = osTempDir(env);
  if (tmp !== '' && !isSharedTmpPath(tmp)) {
    candidates.push(join(tmp, 'dreamux', 'sockets'));
  }
  return candidates;
}

/**
 * The per-user OS temp directory, resolved from the passed env so tests are
 * deterministic, mirroring Node's `os.tmpdir()` precedence
 * (`TMPDIR` → `TMP` → `TEMP` → platform default).
 */
function osTempDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['TMPDIR'] ?? env['TMP'] ?? env['TEMP'];
  const raw = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : tmpdir();
  // Strip a single trailing separator so joined paths stay canonical.
  return raw.endsWith(sep) && raw.length > 1 ? raw.slice(0, -1) : raw;
}

/**
 * Allocate a fresh runtime socket path: the first preference-ordered candidate
 * dir whose joined random-name path fits the Unix socket budget. Pure path
 * computation — the caller (supervisor) creates the directory and cleans up
 * the socket. Fails loudly (with `label` in the message) when even the
 * dreamux-owned fallback is over budget.
 */
export function allocateRuntimeSocketPath(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = `${randomBytes(6).toString('base64url')}.sock`;
  const candidates = runtimeSocketDirCandidates(env);
  for (const dir of candidates) {
    const path = join(dir, name);
    if (unixSocketPathFitsBudget(path)) return path;
  }
  // No candidate fits the budget. Every candidate is a dreamux-owned, sweepable
  // sockets dir (never the bare run root), so re-asserting on the last one
  // yields the fail-loud message naming the longest-shot placement we tried.
  const fallback = candidates[candidates.length - 1] as string;
  return assertUnixSocketPathBudget(join(fallback, name), label);
}

/**
 * Remove every runtime-socket candidate directory wholesale, clearing crash
 * orphans (sockets whose owning process died without reaping). Volatile by
 * contract — sockets are re-allocated on every runtime start, so nothing here
 * is ever reused. Only call while holding the admin-socket lock: that
 * single-server guarantee is what makes every entry provably dead. Returns the
 * swept directories for logging. Failures are best-effort per directory.
 */
export async function sweepRuntimeSocketDirs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const swept: string[] = [];
  for (const dir of runtimeSocketDirCandidates(env)) {
    try {
      await rm(dir, { recursive: true, force: true });
      swept.push(dir);
    } catch {
      /* best effort — a missing or busy dir must not block server startup */
    }
  }
  return swept;
}
