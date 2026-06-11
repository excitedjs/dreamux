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
