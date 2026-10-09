import { readFile, rm, writeFile } from 'node:fs/promises';

/**
 * Max attempts to reclaim a stale pidfile before yielding to a competitor.
 * Mirrors claudemux's instance-lock policy.
 */
const RECLAIM_ATTEMPTS = 3;

/**
 * Acquire a single-instance pidfile lock at `lockPath`.
 *
 * Atomic `wx` create races safely: two competing startups both attempt the
 * same call; one wins, one gets EEXIST. The loser then reads the holder's
 * PID and decides:
 *   - alive holder  → throw (split-brain prevention)
 *   - dead holder   → remove the stale file and retry the `wx` create
 *
 * RECLAIM_ATTEMPTS bounds the retry so a pathologically broken filesystem
 * doesn't spin forever.
 */
export async function acquireInstanceLock(
  lockPath: string,
  myPid: number,
  isAlive: (pid: number) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
    try {
      await writeFile(lockPath, `${myPid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = await readPidFile(lockPath);
    if (holder === myPid) {
      // Re-entrant — shouldn't happen in normal use, but treat as held.
      return;
    }
    if (holder !== null && isAlive(holder)) {
      throw new Error(
        `admin socket lockfile ${lockPath} is held by another live dreamux serve process (pid ${holder}). ` +
          'Refusing to bind to avoid split-brain admin control. ' +
          'Stop the other instance before starting a new one.',
      );
    }
    // Stale lock (unreadable PID, or PID belongs to a dead process).
    // Remove and retry the exclusive create. A competitor reclaiming the
    // same stale file simply wins this round of `wx`, and we'll see *their*
    // live PID on the next iteration and bail out.
    try {
      await rm(lockPath, { force: true });
    } catch {
      /* concurrent reclaim — retry the wx open */
    }
  }
  throw new Error(
    `admin socket lockfile ${lockPath} could not be acquired after ${RECLAIM_ATTEMPTS} reclaim attempts; ` +
      'a competitor is racing us. Retry after the other startup finishes.',
  );
}

/**
 * Release the pidfile lock — but only if it still names us. A holder whose
 * file was already reclaimed by a competitor (e.g. we were paused long
 * enough for our PID to look dead) must not delete the new holder's lock.
 */
export async function releaseInstanceLock(
  lockPath: string,
  myPid: number,
): Promise<void> {
  if ((await readPidFile(lockPath)) !== myPid) return;
  try {
    await rm(lockPath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Read and parse a pidfile written by `acquireInstanceLock`, or `null`. */
export async function readPidFile(path: string): Promise<number | null> {
  let txt: string;
  try {
    txt = (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
  if (txt === '') return null;
  const n = Number.parseInt(txt, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Default liveness probe: `process.kill(pid, 0)`. */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it (still alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
