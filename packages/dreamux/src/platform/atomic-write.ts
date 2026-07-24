import { randomUUID } from 'node:crypto';
import { link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
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

/**
 * Publish a complete file atomically without replacing an existing target.
 *
 * The sibling temp file is fully written before `link()` makes the destination
 * visible. A competing publisher wins with one atomic hard-link operation;
 * losers observe `EEXIST` and return false. A crash before the link can leave
 * only an unreferenced temp file, never an empty or partial destination.
 */
export async function writeFileExclusiveAtomic(
  path: string,
  data: string,
  options: { mode?: number } = {},
): Promise<boolean> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, {
      flag: 'wx',
      mode: options.mode ?? 0o600,
    });
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}
