/**
 * The admin Unix-socket server: one adapter over the Core Command registry.
 *
 * One client gets one line-delimited NDJSON stream of requests; we reply with
 * one line per request. Permissions on the socket are 0600 to keep other local
 * users out (issue #2 §"管理接口").
 *
 * The adapter owns transport only. It frames a request, lifts the caller's
 * `dispatcher_id` out of the payload into the Command context, and maps a typed
 * Command failure onto the wire error. It holds no method table, no schema, no
 * payload validation, and no exposure policy — it invokes the same admitted
 * Command port the in-process Channel invoker does, which is where bounding,
 * schema validation, and shutdown admission happen for both.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Server } from '../server.js';
import { ensureOwnerOnlyDir } from '@excitedjs/dreamux-utils';
import type { CoreCommandContext, JsonValue } from '@excitedjs/dreamux-types';
import {
  DreamuxError,
  TransportError,
  ValidationError,
  commandFailure,
  type CommandFailure,
} from '../command/errors.js';
import { errorInfo } from '../platform/error-info.js';
import type { AdminRequest, AdminResponse } from './protocol.js';

export interface AdminSocketServer {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly socketPath: string;
}

export interface AdminSocketOptions {
  /**
   * Override the chmod implementation. Tests inject a throwing fn to assert
   * the fail-fast cleanup path (PR #3 review #2). Default: `fs/promises.chmod`.
   */
  chmodFn?: (path: string, mode: number) => void | Promise<void>;
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
  const chmodFn = options.chmodFn ?? chmod;
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
      // The socket + lock live under the volatile run root (issue #182),
      // which may not exist yet on a fresh install — create it owner-only, and
      // tighten it if a pre-existing run dir is group/world-traversable.
      await ensureOwnerOnlyDir(dirname(socketPath));
      await acquirePidLock(lockPath, myPid, isAlive);
      holdLock = true;

      try {
        // Lock is held — stale socket cleanup is now race-free.
        await rm(socketPath, { force: true });

        netServer = createServer((sock) => handleConnection(server, sock));
        await new Promise<void>((res, rej) => {
          netServer!.once('error', rej);
          netServer!.listen(socketPath, () => res());
        });

        // PR #3 review #2: chmod is a hard requirement, not best-effort —
        // a 0666 admin socket exposes server-ctl methods to every local user.
        try {
          await chmodFn(socketPath, 0o600);
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
          await rm(socketPath, { force: true });
        } catch {
          /* best-effort */
        }
        await releasePidLock(lockPath, myPid);
        holdLock = false;
        throw err;
      }
    },

    async close(): Promise<void> {
      if (netServer !== null) {
        await new Promise<void>((res) => netServer!.close(() => res()));
        netServer = null;
        try {
          await rm(socketPath, { force: true });
        } catch {
          /* */
        }
      }
      if (holdLock) {
        await releasePidLock(lockPath, myPid);
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
async function acquirePidLock(
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
async function releasePidLock(lockPath: string, myPid: number): Promise<void> {
  if ((await readPidFile(lockPath)) !== myPid) return;
  try {
    await rm(lockPath, { force: true });
  } catch {
    /* best-effort */
  }
}

async function readPidFile(path: string): Promise<number | null> {
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

export interface LegacyAdminServerCheckOptions {
  /** Pre-#182 admin lock path to probe (e.g. `state/admin.sock.lock`). */
  legacyLockPath: string;
  /** Liveness probe override (tests). Default: real `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Fail loud when a still-running OLD-version dreamux server holds the
 * pre-#182 admin socket lock (issue #182 PR-1, PR #183 review P1).
 *
 * The new server's single-instance guard locks `run/admin.sock.lock`, but an
 * old server locks the legacy `state/admin.sock.lock` — a different path — so
 * the two cannot see each other and could run simultaneously, which would also
 * break the runtime-socket sweep's single-server premise. We detect a *live*
 * legacy holder and refuse to start. Detection only: the legacy file is never
 * read for migration, removed, or rewritten here. A stale legacy lock (missing,
 * unreadable, or a dead PID) is ignored so a crashed old server does not block
 * the upgrade.
 */
export async function assertNoLegacyAdminServer(
  options: LegacyAdminServerCheckOptions,
): Promise<void> {
  const isAlive = options.isPidAlive ?? defaultIsPidAlive;
  const holder = await readPidFile(options.legacyLockPath);
  if (holder !== null && isAlive(holder)) {
    throw new Error(
      `a legacy dreamux serve process (pid ${holder}) still holds the pre-upgrade admin ` +
        `socket lock at ${options.legacyLockPath}. This version moved the admin socket to ` +
        '~/.dreamux/run/admin.sock, so the old and new servers cannot see each other and ' +
        'could run at the same time. Stop the old daemon (dreamux daemon stop, or stop the ' +
        'managed service) before starting this version. The legacy file is left untouched; ' +
        'remove it manually only after the old server is stopped.',
    );
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
    // A line that cannot be framed never reached a Command: this is the one
    // genuine transport failure this adapter owns.
    const error = new TransportError(err instanceof Error ? err.message : String(err));
    write(sock, { id: '?', ok: false, error: commandFailure(error) });
    return;
  }

  let context: CoreCommandContext;
  let payload: JsonValue;
  try {
    ({ context, payload } = adminInvocation(req));
  } catch (err) {
    // Envelope reading raises its own stated failures for everything a caller
    // can fix. Anything else is this server's defect, not the caller's, and is
    // reported as `INTERNAL` instead of being restated as a bad request.
    write(sock, {
      id: req.id,
      ok: false,
      error: reportedFailure(server, req.method, err),
    });
    return;
  }

  try {
    // The same admitted port the in-process Channel invoker uses: shutdown
    // admission is a property of invoking a Command, not of this transport.
    const result = await server.commands.invoke(context, req.method, payload);
    write(sock, { id: req.id, ok: true, result });
  } catch (err) {
    // A Dreamux failure already carries its own stable code; anything else is
    // an unclassified implementation failure and is reported as `INTERNAL`
    // under the message it already had.
    write(sock, {
      id: req.id,
      ok: false,
      error: reportedFailure(server, req.method, err),
    });
  }
}

/**
 * One failure on the wire, plus the ordinary log an operator reads.
 *
 * The envelope shape is decided once, in the Command layer, so this transport
 * and the in-process Channel port answer identically. What this adds is the
 * log: a failure Core never classified is written whole — stack included — to
 * the server log, because the caller only ever receives its message.
 */
function reportedFailure(
  server: Server,
  method: string,
  error: unknown,
): CommandFailure {
  if (!(error instanceof DreamuxError)) {
    server.logger.error(
      { method, err: errorInfo(error) },
      'admin command failed',
    );
  }
  return commandFailure(error);
}

/**
 * Split one wire request into caller context and Command payload.
 *
 * `dispatcher_id` is addressing, not a domain field: an admin caller states
 * which dispatcher it is talking to, exactly as a Channel session's invoker
 * binds its own. Lifting it here — and removing it from the payload — is what
 * lets every Command input schema stay closed around domain fields alone, while
 * the wire shape CLI and MCP callers already send is unchanged.
 */
function adminInvocation(req: AdminRequest): {
  context: CoreCommandContext;
  payload: JsonValue;
} {
  const params = req.params;
  if (params !== undefined && (typeof params !== 'object' || Array.isArray(params))) {
    throw new ValidationError("request 'params' must be an object");
  }
  const { dispatcher_id: dispatcherId, ...rest } = params ?? {};
  if (dispatcherId !== undefined && typeof dispatcherId !== 'string') {
    throw new ValidationError("param 'dispatcher_id' must be a string");
  }
  return {
    context: {
      source: 'admin_socket',
      ...(dispatcherId !== undefined ? { dispatcher_id: dispatcherId } : {}),
    },
    // The envelope was produced by `JSON.parse`, so its values are JSON by
    // construction; the wire type is only declared loosely.
    payload: rest as unknown as JsonValue,
  };
}

function write(sock: Socket, response: AdminResponse): void {
  try {
    sock.write(`${JSON.stringify(response)}\n`);
  } catch {
    /* client gone */
  }
}
