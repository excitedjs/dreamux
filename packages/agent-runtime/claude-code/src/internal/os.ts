/**
 * Generic OS/filesystem utilities the Codex runtime needs, vendored into this
 * package so it depends on `@excitedjs/dreamux-types` only and never imports
 * `@excitedjs/dreamux` core. These are platform primitives (process-group
 * signalling, owner-only dir enforcement, empty-log cleanup, existence probe),
 * NOT Dreamux host layout/path/socket/log contracts — those are supplied by the
 * host through the create context and provider options.
 */

import { access, chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises';

/** True when `pid` names a live process (EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    return errno === 'EPERM';
  }
}

/** Signal an entire process group; ESRCH/EPERM are swallowed. */
export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals | number,
): void {
  if (!Number.isFinite(pgid) || pgid <= 0) return;
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH' || errno === 'EPERM') return;
    throw e;
  }
}

export interface EnsureOwnerOnlyDirOptions {
  /** Current-user uid probe override (tests). */
  getuid?: () => number;
}

/**
 * Create/adopt a directory and guarantee the owner-only (0700) privacy
 * invariant regardless of who created it: reject a symlink leaf, fail loud on a
 * foreign-uid dir, and tighten any group/other permission bits.
 */
export async function ensureOwnerOnlyDir(
  path: string,
  options: EnsureOwnerOnlyDirOptions = {},
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(
      `refusing to use Dreamux runtime directory ${path}: it is a symlink, not a real directory`,
    );
  }
  const getuid = options.getuid ?? process.getuid?.bind(process);
  if (getuid !== undefined && info.uid !== getuid()) {
    throw new Error(
      `refusing to use Dreamux runtime directory ${path}: it is owned by uid ${info.uid}, ` +
        `not the current user (uid ${getuid()})`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}

/**
 * Remove `path` only if it exists and is zero bytes. Best-effort: a missing,
 * non-empty, or busy file is left untouched and never throws.
 */
export async function removeEmptyLogFile(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size === 0) await unlink(path);
  } catch {
    /* best effort — missing/busy/non-empty files are left as-is */
  }
}

/** Best-effort existence probe — the async replacement for `existsSync`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
