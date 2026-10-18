/**
 * Codex app-server child process supervisor.
 *
 * Heavily simplified from claudemux's
 * `plugins/claudemux/core/src/engines/codex/supervisor.ts`. Differences:
 *   - one process per Dispatcher, owned in-memory (no /tmp registry)
 *   - no IPC bridge subprocess (the server owns its transport)
 *   - no spawn lock / borrow lock (Dispatcher is the single owner)
 *   - lifecycle bound to CodexRuntime, not a CLI invocation
 *
 * Issue #2 "implementation pitfalls": codex CLI is a node wrapper that spawns
 * the Rust binary as a child. Reap must terminate the whole process tree,
 * including the native child, through the shared platform supervisor.
 */

import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ensureOwnerOnlyDir,
  isProcessAlive,
  removeEmptyLogFile,
  SupervisedChild,
} from '@excitedjs/dreamux-utils';
import type { CodexRpcClientOptions } from './rpc.js';

export interface CodexProcessOptions {
  /** Unix socket path, or omitted for private stdio transport on Windows. */
  socketPath?: string;
  /** Working directory for the daemon. */
  cwd: string;
  /** Where to log stdout. */
  stdoutLogPath: string;
  /** Where to log stderr. */
  stderrLogPath: string;
  /** Codex binary path, already resolved by `bin.ts`'s `resolveCodexBinPath`. */
  binPath: string;
  /** Extra args after `app-server --listen <transport>`. */
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
  readonly socketPath: string | undefined;
  readonly cwd: string;
  private supervisor: SupervisedChild | null = null;
  private connection: CodexRpcClientOptions | null = null;
  private _pid: number | null = null;
  private startTask: Promise<void> | null = null;
  private reapTask: Promise<void> | null = null;
  private reapRequested = false;
  private reaped = false;
  private readonly exitHandlers: CodexProcessExitHandler[] = [];

  constructor(private readonly opts: CodexProcessOptions) {
    this.socketPath = opts.socketPath;
    this.cwd = opts.cwd;
  }

  get pid(): number | null {
    return this._pid;
  }

  get connectionOptions(): CodexRpcClientOptions {
    if (this.connection === null) {
      throw new Error('CodexProcess: no running connection');
    }
    return this.connection;
  }

  onExit(handler: CodexProcessExitHandler): void {
    this.exitHandlers.push(handler);
  }

  /** Spawn the daemon and resolve once its transport is available. */
  async start(): Promise<void> {
    if (this.supervisor !== null || this.startTask !== null) {
      throw new Error('CodexProcess.start: already started');
    }
    this.assertStartAllowed();
    const task = this.startProcess();
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = null;
    }
  }

  private async startProcess(): Promise<void> {
    const binPath = this.opts.binPath;
    const socketPath = this.opts.socketPath;
    const args = [
      'app-server',
      '--listen',
      socketPath === undefined ? 'stdio://' : `unix://${socketPath}`,
      ...(this.opts.extraArgs ?? []),
    ];

    // The socket dir is a private runtime root (issue #182): owner-only, so
    // other local users can never reach the rendezvous endpoint. Enforce it
    // even when the dir already exists with a permissive mode.
    if (socketPath !== undefined) {
      await ensureOwnerOnlyDir(dirname(socketPath));
    }
    await mkdir(this.opts.cwd, { recursive: true });
    await mkdir(dirname(this.opts.stdoutLogPath), { recursive: true });
    // Stale socket from a previous crashed run would otherwise prevent
    // the daemon from binding.
    if (socketPath !== undefined) {
      try {
        await rm(socketPath, { force: true });
      } catch {
        /* ignore — bind will fail loudly if it really is busy */
      }
    }

    // Open the log files as FileHandles and hand their fds to the child's
    // stdio. The handles are kept in locals (referenced by the finally below)
    // so they cannot be garbage-collected — and thus closed out from under the
    // child — between open and spawn. They are closed once the child owns the
    // inherited fds, matching the previous openSync/closeSync timing.
    const logHandles: Array<Awaited<ReturnType<typeof open>>> = [];
    try {
      // With stdio transport stdout carries protocol envelopes, not logs.
      const stdoutHandle =
        socketPath === undefined
          ? null
          : await open(this.opts.stdoutLogPath, 'a', 0o600);
      if (stdoutHandle !== null) logHandles.push(stdoutHandle);
      const stderrHandle = await open(this.opts.stderrLogPath, 'a', 0o600);
      logHandles.push(stderrHandle);
      this.assertStartAllowed();
      const supervisor = new SupervisedChild({
        kind: 'spawn',
        command: binPath,
        args,
        options: {
          cwd: this.opts.cwd,
          env: this.opts.env ?? process.env,
          stdio:
            stdoutHandle === null
              ? ['pipe', 'pipe', stderrHandle.fd]
              : ['ignore', stdoutHandle.fd, stderrHandle.fd],
        },
      });
      supervisor.onError(() => {
        /* daemon-side error, can no longer affect this process */
      });
      supervisor.onExit((exit) => {
        if (this.reapRequested || this.reaped) return;
        for (const handler of this.exitHandlers) {
          try {
            handler(exit);
          } catch {
            /* exit observers must not poison process event dispatch */
          }
        }
      });
      // Publish termination authority before the spawn await. A concurrent
      // reap waits for this start task and can never miss a late child.
      this.supervisor = supervisor;

      try {
        const child = await supervisor.start();
        this.assertStartAllowed();
        const pid = child.pid!;
        this._pid = pid;
        if (socketPath === undefined) {
          this.connection = {
            stdio: { stdin: child.stdin!, stdout: child.stdout! },
          };
        } else {
          await waitForSocket(
            socketPath,
            pid,
            this.opts.readyTimeoutMs ?? 10000,
          );
          this.connection = { socketPath };
        }
        this.assertStartAllowed();
      } catch (error) {
        try {
          await this.terminateSpawnedProcess();
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            'Codex process start failed and termination could not be proved',
          );
        }
        throw error;
      }
    } finally {
      // The child already inherited these descriptors. Parent-side close
      // errors cannot make a successfully supervised child unowned.
      await Promise.all(
        logHandles.map((handle) => handle.close().catch(() => undefined)),
      );
    }
  }

  /** Terminate the supervised process tree. Idempotent. */
  reap(): Promise<void> {
    if (this.reaped) return Promise.resolve();
    if (this.reapTask !== null) return this.reapTask;
    this.reapRequested = true;
    const task = this.reapProcess();
    this.reapTask = task;
    void task.catch(() => {
      if (this.reapTask === task) this.reapTask = null;
    });
    return task;
  }

  private async reapProcess(): Promise<void> {
    // If no supervisor has been published, `reapRequested` is itself the
    // fence: every later pre-spawn seam checks it before creating a child. Do
    // not join an arbitrary filesystem/startup wait that owns no process yet.
    if (this.supervisor !== null) await this.terminateSpawnedProcess();
    this.reaped = true;
  }

  private async terminateSpawnedProcess(): Promise<void> {
    const supervisor = this.supervisor;
    await supervisor?.stop();
    if (this.opts.socketPath !== undefined) {
      try {
        await rm(this.opts.socketPath, { force: true });
      } catch {
        /* best effort */
      }
    }
    // The child has exited, so its inherited stdout/stderr fds are released.
    // Drop the log files if the child produced no output — normal Codex traffic
    // flows over the socket, so they are usually empty (issue #182 logs stage).
    await removeEmptyLogFile(this.opts.stdoutLogPath);
    await removeEmptyLogFile(this.opts.stderrLogPath);
    if (this.supervisor === supervisor) {
      this.supervisor = null;
      this.connection = null;
      this._pid = null;
    }
  }

  private assertStartAllowed(): void {
    if (this.reapRequested || this.reaped) {
      throw new Error('CodexProcess.start: stopped during start');
    }
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
