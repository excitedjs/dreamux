/**
 * Filesystem write helpers shared across Dreamux providers and host.
 *
 * Domain note: these are atomic-write primitives, one per publish semantic
 * (create-only vs. overwrite). Dreamux host-owned path/layout contracts live
 * in `@excitedjs/dreamux` — do not add them here.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
let windowsIdentity: Promise<string> | undefined;
const WINDOWS_RENAME_LOCK_TIMEOUT_MS = 1_000;
const WINDOWS_RENAME_LOCK_RETRY_MS = 25;

/**
 * Both publish primitives below write to this sibling path with `wx`
 * (create, exclusive) before moving the result into place, so a collision on
 * the random suffix throws instead of one in-flight writer silently
 * clobbering another's temp file.
 */
function tempSiblingPath(path: string): string {
  const suffix =
    process.pid.toString(16) +
    '-' +
    Date.now().toString(36) +
    '-' +
    randomBytes(4).toString('hex');
  return `${path}.tmp-${suffix}`;
}

/**
 * Publish a complete file without ever replacing an existing target: write
 * the full contents to a sibling temp file, then `link()` it into place.
 * `link()` either creates the destination name or fails — there is no window
 * where a reader can see a partial file, and no window where two concurrent
 * publishers can both "win". A collision surfaces as `EEXIST`, reported here
 * as `false` rather than thrown, because "someone else already published this
 * path" is the expected outcome of a no-clobber create, not an I/O failure.
 */
export async function publishFileExclusive(
  path: string,
  data: string,
  options: { mode?: number } = {},
): Promise<boolean> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = tempSiblingPath(path);
  let handle: FileHandle | undefined;
  try {
    handle = await writeTemporaryFile(tmp, data, options.mode ?? 0o600);
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if (isEexist(err)) return false;
      throw err;
    }
  } finally {
    // Keep the Windows file handle alive until its temporary hardlink is
    // removed. Closing it before link/unlink can leave the published file
    // refusing subsequent replacement with ERROR_ACCESS_DENIED.
    await rm(tmp, { force: true }).catch(() => undefined);
    await handle?.close();
  }
}

/**
 * Write a complete file to `path`, replacing whatever is already there: the
 * full contents land in a sibling temp file first, then `rename()` swaps it
 * over the target. A reader never observes a partial write, and a write that
 * fails partway leaves the previous file, if any, untouched. This is the
 * overwrite counterpart to `publishFileExclusive` above — same tmp+publish
 * shape, but `rename()` replaces an existing target instead of `link()`
 * refusing one.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = tempSiblingPath(path);
  let handle: FileHandle | undefined;
  try {
    handle = await writeTemporaryFile(tmp, data, options.mode ?? 0o600);
    await renameReplacingFile(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await handle?.close();
  }
}

async function renameReplacingFile(from: string, to: string): Promise<void> {
  const deadline = performance.now() + WINDOWS_RENAME_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const remaining = deadline - performance.now();
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        remaining <= 0
      ) {
        throw error;
      }
      // Windows readers can briefly deny delete sharing. Retry the atomic
      // rename itself; unlinking the destination would lose the old commit.
      await delay(Math.min(WINDOWS_RENAME_LOCK_RETRY_MS, remaining));
    }
  }
}

async function writeTemporaryFile(
  path: string,
  data: string,
  mode: number,
): Promise<FileHandle | undefined> {
  if (process.platform !== 'win32') {
    await writeFile(path, data, { flag: 'wx', mode });
    return;
  }
  // Set the new file's DACL before putting any private data in it. Unlike
  // chmod, icacls enforces owner-only access on Windows regardless of parent.
  const handle = await open(path, 'wx', mode);
  try {
    if ((mode & 0o077) === 0) {
      const system32 = join(
        process.env['SystemRoot'] ?? 'C:\\Windows',
        'System32',
      );
      windowsIdentity ??= execFileAsync(
        join(system32, 'whoami.exe'),
        ['/user', '/fo', 'csv', '/nh'],
        { windowsHide: true },
      ).then(({ stdout }) => {
        const sid = stdout.match(/S-1-\d+(?:-\d+)+/);
        if (sid === null)
          throw new Error('whoami did not return the current Windows user SID');
        return sid[0];
      });
      const sid = await windowsIdentity;
      await execFileAsync(
        join(system32, 'icacls.exe'),
        [path, '/inheritance:r', '/grant:r', `*${sid}:F`],
        { windowsHide: true },
      );
    }
    await handle.writeFile(data, 'utf8');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}
