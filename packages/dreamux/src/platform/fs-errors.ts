import { access } from 'node:fs/promises';

/**
 * True when an error is a Node `ENOENT` (missing file/dir). The shared form of
 * the predicate the per-dispatcher stores use to treat "no file yet" as an
 * empty read rather than a failure.
 */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Best-effort existence probe — the async replacement for `existsSync`. Treats
 * ANY access failure (including a permission error) as "absent". A caller that
 * must distinguish a missing entry from a real access error checks
 * {@link isNotFound} on the thrown error itself instead of using this.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
