/**
 * Filesystem write helpers shared across Dreamux providers and host.
 *
 * Domain note: these are primitives (atomic write, future: tmpdir,
 * safe unlink). Dreamux host-owned path/layout contracts live in
 * `@excitedjs/dreamux` — do not add them here.
 */

import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Atomic write: tmpfile in same dir → write with O_CREAT|O_EXCL (fail loud on
 * collision instead of clobbering) → rename over final path.
 * Permissions applied at open (never chmod final path).
 * Parent dir must exist.
 */
export async function writeAtomic(
  dir: string,
  filename: string,
  data: string,
  mode: number = 0o600,
): Promise<void> {
  const suffix =
    process.pid.toString(16) +
    '-' +
    Date.now().toString(36) +
    '-' +
    randomBytes(4).toString('hex');
  const tmp = join(dir, `${filename}.tmp-${suffix}`);
  const final = join(dir, filename);

  // O_CREAT | O_EXCL | O_WRONLY = 'wx' — a name collision throws instead of
  // silently overwriting (infinitesimally unlikely given pid+time+random, but
  // the invariant calls for it).
  let fd: import('node:fs').promises.FileHandle | null = null;
  try {
    fd = await open(tmp, 'wx', mode);
    await fd.writeFile(data);
    await fd.close();
    fd = null;
    await rename(tmp, final);
  } catch (err) {
    if (fd) {
      try { await fd.close(); } catch { /* swallow */ }
    }
    try { await rm(tmp, { force: true }); } catch { /* swallow */ }
    throw err;
  }
}
