import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomically write a file (issue #199 Slice 4). A plain `writeFile` truncates
 * the target before writing, so a concurrent reader can observe an empty or
 * partial file — exactly the `JSON.parse('')` race the per-name record store hit
 * under parallel settles. Writing the full contents to a sibling temp file and
 * `rename`-ing it into place makes the swap atomic: a reader always sees either
 * the complete old file or the complete new one, never a torn write. The temp is
 * created in the SAME directory so the rename stays on one filesystem.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: options.mode ?? 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
