/** Shared process-group helpers for runtime supervisors. */

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    return errno === 'EPERM';
  }
}

export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals | number,
): void {
  if (!Number.isFinite(pgid) || pgid <= 0) return;
  try {
    process.kill(-pgid, signal);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH' || errno === 'EPERM') return;
    throw e;
  }
}
