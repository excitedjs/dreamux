/**
 * Generic owner-only directory enforcement, vendored into this package so it
 * depends on `@excitedjs/dreamux-types` + `@excitedjs/feishu-transport` only and
 * never imports `@excitedjs/dreamux` core. This is a platform primitive (a 0700
 * privacy invariant on a created/adopted dir), NOT a Dreamux host layout/path
 * contract — the attachment cache dir itself is supplied by the host through the
 * session options.
 */
import { chmod, lstat, mkdir } from 'node:fs/promises';

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
