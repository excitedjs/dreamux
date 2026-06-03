/**
 * The admin Unix-socket server.
 *
 * One client gets one line-delimited NDJSON stream of requests; we reply
 * with one line per request. Permissions on the socket are 0600 to keep
 * other local users out (issue #2 §"管理接口").
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import type { Server } from '../server.js';
import {
  AdminError,
  type AdminRequest,
  type AdminResponse,
} from './protocol.js';
import { adminMethods } from './methods.js';

export interface AdminSocketServer {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly socketPath: string;
}

export interface AdminSocketOptions {
  /**
   * Override the chmod implementation. Tests inject a throwing fn to assert
   * the fail-fast cleanup path (PR #3 review #2). Default: `fs.chmodSync`.
   */
  chmodFn?: (path: string, mode: number) => void;
  /**
   * Override the liveness probe for the lockfile holder PID. Production uses
   * `process.kill(pid, 0)`; tests inject a stub so they can assert behavior
   * for "stale lock pid is dead" vs "lock pid is live" without spawning real
   * processes. Default: real `kill(pid, 0)` probe.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Override the PID this server claims the lock with. Default: `process.pid`.
   * Tests can use this to simulate two competing servers in one process.
   */
  selfPid?: number;
}

/**
 * Max attempts to reclaim a stale pidfile before yielding to a competitor.
 * Mirrors claudemux's instance-lock policy.
 */
const RECLAIM_ATTEMPTS = 3;

export function createAdminSocketServer(
  server: Server,
  socketPath: string,
  options: AdminSocketOptions = {},
): AdminSocketServer {
  const chmod = options.chmodFn ?? chmodSync;
  const isAlive = options.isPidAlive ?? defaultIsPidAlive;
  const myPid = options.selfPid ?? process.pid;
  const lockPath = `${socketPath}.lock`;
  let netServer: NetServer | null = null;
  let holdLock = false;

  return {
    socketPath,

    async start(): Promise<void> {
      // PR #3 review #3 (r2): the previous probe-then-unlink had a TOCTOU
      // window — two competing startups could both observe a stale socket
      // as not-live, then one bind successfully and the other unlink it
      // out from under the first. We resolve this by gating *every* path
      // (probe, cleanup, bind) behind a pidfile that's created with the
      // exclusive `wx` flag — atomic at the filesystem level. Once we
      // hold it, nobody else can be inside this start() concurrently.
      // Stale pidfiles (dead holder) are reclaimed up to RECLAIM_ATTEMPTS
      // times; a live holder always loses the race.
      acquirePidLock(lockPath, myPid, isAlive);
      holdLock = true;

      try {
        // Lock is held — stale socket cleanup is now race-free.
        if (existsSync(socketPath)) {
          rmSync(socketPath, { force: true });
        }

        netServer = createServer((sock) => handleConnection(server, sock));
        await new Promise<void>((res, rej) => {
          netServer!.once('error', rej);
          netServer!.listen(socketPath, () => res());
        });

        // PR #3 review #2: chmod is a hard requirement, not best-effort —
        // a 0666 admin socket exposes server-ctl methods to every local user.
        try {
          chmod(socketPath, 0o600);
        } catch (e) {
          const chmodErr = e instanceof Error ? e.message : String(e);
          throw new Error(
            `admin socket ${socketPath} could not be locked down to 0600 (${chmodErr}); refusing to expose it on a permissive mode`,
          );
        }
      } catch (err) {
        // Unwind whatever partial state we set up — bound server, socket
        // file, and the pidfile lock — so a retry doesn't trip over our
        // own leftovers.
        if (netServer !== null) {
          const closing = netServer;
          netServer = null;
          await new Promise<void>((res) => closing.close(() => res()));
        }
        try {
          rmSync(socketPath, { force: true });
        } catch {
          /* best-effort */
        }
        releasePidLock(lockPath, myPid);
        holdLock = false;
        throw err;
      }
    },

    async close(): Promise<void> {
      if (netServer !== null) {
        await new Promise<void>((res) => netServer!.close(() => res()));
        netServer = null;
        try {
          rmSync(socketPath, { force: true });
        } catch {
          /* */
        }
      }
      if (holdLock) {
        releasePidLock(lockPath, myPid);
        holdLock = false;
      }
    },
  };
}

/**
 * Acquire the single-instance pidfile lock.
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
function acquirePidLock(
  lockPath: string,
  myPid: number,
  isAlive: (pid: number) => boolean,
): void {
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
    try {
      writeFileSync(lockPath, `${myPid}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readPidFile(lockPath);
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
      rmSync(lockPath, { force: true });
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
function releasePidLock(lockPath: string, myPid: number): void {
  if (readPidFile(lockPath) !== myPid) return;
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* best-effort */
  }
}

function readPidFile(path: string): number | null {
  let txt: string;
  try {
    txt = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  if (txt === '') return null;
  const n = Number.parseInt(txt, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it (still alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function handleConnection(server: Server, sock: Socket): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === '') continue;
      void processLine(server, sock, line);
    }
  });
  sock.on('error', () => {
    /* client closed unexpectedly — nothing more to do */
  });
}

async function processLine(server: Server, sock: Socket, line: string): Promise<void> {
  let req: AdminRequest;
  try {
    req = JSON.parse(line) as AdminRequest;
    if (typeof req !== 'object' || req === null || typeof req.id !== 'string') {
      throw new Error('bad request envelope');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(sock, { id: '?', ok: false, error: { code: 'BAD_REQUEST', message: msg } });
    return;
  }

  const handler = adminMethods[req.method];
  if (handler === undefined) {
    write(sock, {
      id: req.id,
      ok: false,
      error: { code: 'UNKNOWN_METHOD', message: `unknown method '${req.method}'` },
    });
    return;
  }

  try {
    const result = await handler(server, req.params);
    write(sock, { id: req.id, ok: true, result });
  } catch (err) {
    if (err instanceof AdminError) {
      write(sock, {
        id: req.id,
        ok: false,
        error: { code: err.code, message: err.message },
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    write(sock, {
      id: req.id,
      ok: false,
      error: { code: 'INTERNAL', message: msg },
    });
  }
}

function write(sock: Socket, response: AdminResponse): void {
  try {
    sock.write(`${JSON.stringify(response)}\n`);
  } catch {
    /* client gone */
  }
}
