/**
 * Owner-only directory enforcement for Dreamux-owned runtime dirs (issue #182).
 *
 * `mkdir(path, { mode: 0o700, recursive: true })` only applies the mode to
 * directories it actually creates; a *pre-existing* dir keeps whatever
 * permissions it already had. So a Dreamux run/socket dir left over from an
 * older version (or created by something else with a permissive umask) would
 * silently host private control sockets and lock files under a world- or
 * group-traversable parent. This helper adopts the dir and guarantees the
 * privacy invariant regardless of who created it:
 *
 *  - reject a symlink at the leaf (a pre-planted symlink could redirect our
 *    private files outside the owner-only tree);
 *  - fail loud if the dir is owned by another uid (someone else's directory on
 *    our path — never silently trust it);
 *  - tighten to 0700 if any group/other permission bit is set.
 *
 * Detection + tightening of our own dir only — it never touches operator-owned
 * parents (e.g. `$XDG_RUNTIME_DIR` itself), which are not passed here.
 */

import { chmod, lstat, mkdir } from 'node:fs/promises';

export interface EnsureOwnerOnlyDirOptions {
  /**
   * Current-user uid probe override (tests). Default: `process.getuid`, or
   * undefined on platforms without it (Windows), where the ownership check is
   * skipped. Lets the foreign-owner reject branch be driven without root —
   * mirrors `assertNoLegacyAdminServer`'s `isPidAlive` seam.
   */
  getuid?: () => number;
}

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
