/**
 * Codex app-server child process supervisor.
 *
 * Heavily simplified from claudemux's
 * `plugins/claudemux/core/src/engines/codex/supervisor.ts`. Differences:
 *   - one process per Dispatcher, owned in-memory (no /tmp registry)
 *   - no IPC bridge subprocess (the server holds the WS itself)
 *   - no spawn lock / borrow lock (Dispatcher is the single owner)
 *   - lifecycle bound to CodexRuntime, not a CLI invocation
 *
 * Issue #2 §"实现陷阱": codex CLI is a node wrapper that spawns the rust
 * binary as a child; both land in the same process group. Reap must
 * SIGKILL the whole group, not just the leader, or the rust process leaks.
 */

import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isProcessAlive, killProcessGroup } from '../../../platform/process.js';
import { ensureOwnerOnlyDir } from '../../../platform/owner-only-dir.js';
import { removeEmptyLogFile } from '../../../platform/logs.js';

export interface CodexProcessOptions {
  /** Unix socket path the daemon should listen on. */
  socketPath: string;
  /** Working directory for the daemon. */
  cwd: string;
  /** Where to log stdout. */
  stdoutLogPath: string;
  /** Where to log stderr. */
  stderrLogPath: string;
  /** Codex binary path. Defaults to `'codex'` on PATH; env `CODEX_HOST_CODEX_BIN` overrides. */
  binPath?: string;
  /** Extra args after `app-server --listen unix://<socket>`. */
  extraArgs?: string[];
  /** Environment for the daemon. */
  env?: NodeJS.ProcessEnv;
  /** Ready-probe timeout in ms (how long to wait for the socket to appear). */
  readyTimeoutMs?: number;
}

export interface CodexProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type CodexProcessExitHandler = (exit: CodexProcessExit) => void;

/** A handle to one running codex app-server child process. */
export class CodexProcess {
  readonly socketPath: string;
  readonly cwd: string;
  private child: ChildProcess | null = null;
  private _pid: number | null = null;
  private reaped = false;
  private readonly exitHandlers: CodexProcessExitHandler[] = [];

  constructor(private readonly opts: CodexProcessOptions) {
    this.socketPath = opts.socketPath;
    this.cwd = opts.cwd;
  }

  get pid(): number | null {
    return this._pid;
  }

  onExit(handler: CodexProcessExitHandler): void {
    this.exitHandlers.push(handler);
  }

  /** Spawn the daemon and resolve once its listen socket is bound. */
  async start(): Promise<void> {
    if (this.child !== null) {
      throw new Error('CodexProcess.start: already started');
    }
    const binPath =
      this.opts.binPath ?? (process.env['CODEX_HOST_CODEX_BIN'] || 'codex');
    const args = [
      'app-server',
      '--listen',
      `unix://${this.opts.socketPath}`,
      ...(this.opts.extraArgs ?? []),
    ];

    // The socket dir is a private runtime root (issue #182): owner-only, so
    // other local users can never reach the rendezvous endpoint. Enforce it
    // even when the dir already exists with a permissive mode.
    await ensureOwnerOnlyDir(dirname(this.opts.socketPath));
    await mkdir(this.opts.cwd, { recursive: true });
    await mkdir(dirname(this.opts.stdoutLogPath), { recursive: true });
    // Stale socket from a previous crashed run would otherwise prevent
    // the daemon from binding.
    try {
      await rm(this.opts.socketPath, { force: true });
    } catch {
      /* ignore — bind will fail loudly if it really is busy */
    }

    // Open the log files as FileHandles and hand their fds to the child's
    // stdio. The handles are kept in locals (referenced by the finally below)
    // so they cannot be garbage-collected — and thus closed out from under the
    // child — between open and spawn. They are closed once the child owns the
    // inherited fds, matching the previous openSync/closeSync timing.
    const stdoutHandle = await open(this.opts.stdoutLogPath, 'a', 0o600);
    const stderrHandle = await open(this.opts.stderrLogPath, 'a', 0o600);
    const spawnOpts: SpawnOptions = {
      cwd: this.opts.cwd,
      env: this.opts.env ?? process.env,
      detached: true, // its own process group, so we can group-kill on reap
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
    };

    let child: ChildProcess;
    try {
      child = await new Promise<ChildProcess>((resolve, reject) => {
        let settled = false;
        const c = spawnChild(binPath, args, spawnOpts);
        c.once('error', (e) => {
          if (settled) return;
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
        c.once('spawn', () => {
          if (settled) return;
          settled = true;
          resolve(c);
        });
      });
    } finally {
      await stdoutHandle.close();
      await stderrHandle.close();
    }

    if (child.pid === undefined) {
      throw new Error('codex daemon spawned without a pid');
    }
    this.child = child;
    this._pid = child.pid;
    // Future post-spawn `error` emissions must not crash the supervisor.
    child.on('error', () => {
      /* daemon-side error, can no longer affect this process */
    });
    child.once('exit', (code, signal) => {
      if (this.reaped) return;
      for (const handler of this.exitHandlers) {
        try {
          handler({ code, signal });
        } catch {
          /* exit observers must not poison process event dispatch */
        }
      }
    });

    try {
      await waitForSocket(
        this.opts.socketPath,
        child.pid,
        this.opts.readyTimeoutMs ?? 10000,
      );
    } catch (e) {
      await this.reap();
      throw e;
    }
  }

  /** SIGTERM → 1s wait → SIGKILL group. Idempotent. */
  async reap(): Promise<void> {
    if (this.reaped) return;
    this.reaped = true;
    const pid = this._pid;
    if (pid !== null) {
      if (isProcessAlive(pid)) {
        killProcessGroup(pid, 'SIGTERM');
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if (!isProcessAlive(pid)) break;
          await new Promise<void>((r) => setTimeout(r, 25));
        }
      }
      // Always SIGKILL the group, even if the leader is already dead —
      // a reparented child (rust binary outliving its node wrapper) is
      // the exact failure this guards against.
      killProcessGroup(pid, 'SIGKILL');
    }
    try {
      await rm(this.opts.socketPath, { force: true });
    } catch {
      /* best effort */
    }
    // The child has exited, so its inherited stdout/stderr fds are released.
    // Drop the log files if the child produced no output — normal Codex traffic
    // flows over the socket, so they are usually empty (issue #182 logs stage).
    await removeEmptyLogFile(this.opts.stdoutLogPath);
    await removeEmptyLogFile(this.opts.stderrLogPath);
    this.child = null;
  }
}

async function waitForSocket(
  path: string,
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await stat(path);
      if (st.isSocket()) return;
    } catch {
      /* not bound yet or race; keep polling */
    }
    if (!isProcessAlive(pid)) {
      throw new Error(
        `codex daemon (pid ${pid}) exited before binding ${path}`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  throw new Error(
    `codex daemon (pid ${pid}) did not bind ${path} within ${timeoutMs}ms`,
  );
}
