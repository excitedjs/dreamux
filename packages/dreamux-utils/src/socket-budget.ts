/**
 * Unix-domain socket path-budget primitives (issue #209 cleanup).
 *
 * The kernel caps a Unix socket path at `sun_path` bytes (108 on Linux including
 * the NUL terminator, 104 on macOS). 103 usable bytes is the safe cross-platform
 * budget Dreamux enforces. These are pure functions with no IO and no host
 * path-layout knowledge: a provider package that allocates its own rendezvous
 * socket (e.g. the Codex app-server socket) uses them to pick a candidate
 * directory whose full path fits, while Dreamux core uses the same primitives so
 * the budget never drifts between the two.
 */

/** Safe cross-platform `sun_path` byte budget for a Unix-domain socket path. */
export const DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES = 103;

/** Whether `path` fits the Unix-domain socket `sun_path` budget. */
export function unixSocketPathFitsBudget(path: string): boolean {
  return Buffer.byteLength(path, 'utf8') <= DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES;
}

/**
 * Return `path` if it fits the socket budget, else throw a fail-loud error
 * naming `label`, the byte count, and the offending path.
 */
export function assertUnixSocketPathBudget(path: string, label: string): string {
  if (unixSocketPathFitsBudget(path)) return path;
  const bytes = Buffer.byteLength(path, 'utf8');
  throw new Error(
    `${label} is too long for Unix sockets (${bytes} bytes > ${DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES} safe bytes): ${path}`,
  );
}
