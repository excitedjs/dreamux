/**
 * Filesystem write helpers shared across Dreamux providers and host.
 *
 * Domain note: these are primitives (atomic write, future: tmpdir,
 * safe unlink). Dreamux host-owned path/layout contracts live in
 * `@excitedjs/dreamux` — do not add them here.
 */

import { randomBytes } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  try {
    await writeFile(tmp, data, { flag: 'wx', mode: options.mode ?? 0o600 });
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if (isEexist(err)) return false;
      throw err;
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
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
