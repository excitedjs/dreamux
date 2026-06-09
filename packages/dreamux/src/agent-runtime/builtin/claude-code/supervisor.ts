/**
 * Claude Code resident child process supervisor.
 *
 * Mirrors `codex/supervisor.ts` for the `builtin:claude-code` transport:
 * spawn the long-lived `claude --print --input-format stream-json` child,
 * own its process group, surface unexpected exits, and delegate turn RPC to
 * `claude-code/rpc.ts`.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  isProcessAlive,
  killProcessGroup,
} from '../../../platform/process.js';
import { ClaudeCodeStreamRpc } from './rpc.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionSpec,
  TurnOutcome,
  TurnSubmitOptions,
} from './types.js';

/** The live session: spawns and supervises the real `claude` child. */
class LiveClaudeCodeSession implements ClaudeCodeSession {
  private child: ChildProcess | null = null;
  private pid: number | null = null;
  private exited = false;
  private stopped = false;
  private rpc: ClaudeCodeStreamRpc | null = null;
  private onExitHandler: (() => void) | null = null;

  constructor(private readonly spec: ClaudeCodeSessionSpec) {}

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  async start(): Promise<void> {
    if (this.child !== null) {
      throw new Error('ClaudeCodeSession.start: already started');
    }
    await mkdir(this.spec.cwd, { recursive: true });
    await mkdir(dirname(this.spec.stderrLogPath), { recursive: true });
    // Open the stderr log as a FileHandle and hand its fd to the child. The
    // handle is closed once the child owns the inherited fd (the finally),
    // matching the timing discipline in codex/supervisor.ts.
    const stderrHandle = await open(this.spec.stderrLogPath, 'a', 0o600);
    const spawnOpts: SpawnOptions = {
      cwd: this.spec.cwd,
      env: this.spec.env,
      // Own process group so a leaked grandchild is group-killable on reap.
      detached: true,
      stdio: ['pipe', 'pipe', stderrHandle.fd],
    };
    let child: ChildProcess;
    try {
      child = await new Promise<ChildProcess>((resolve, reject) => {
        let settled = false;
        const c = spawn(this.spec.bin, this.spec.args, spawnOpts);
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
      await stderrHandle.close();
    }
    if (child.pid === undefined) {
      throw new Error('claude resident child spawned without a pid');
    }
    this.child = child;
    this.pid = child.pid;
    // Post-spawn `error` must not crash the host event loop.
    child.on('error', (err) => {
      this.spec.log?.('warn', 'claude resident child error', err);
    });
    const stdin = child.stdin;
    if (stdin === null) {
      throw new Error('claude resident child spawned without stdin');
    }
    const rpc = new ClaudeCodeStreamRpc(stdin, {
      turnTimeoutMs: this.spec.turnTimeoutMs,
      log: this.spec.log,
      reapOnTimeout: () => {
        void this.stop().catch(() => {
          /* reap is best-effort */
        });
      },
      onRemoteControlUrl: this.spec.onRemoteControlUrl,
    });
    this.rpc = rpc;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      rpc.onStdoutChunk(chunk);
    });
    if (this.spec.remoteControl) rpc.enableRemoteControl();
    child.once('exit', () => this.onChildExit());
  }

  async submitTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<TurnOutcome> {
    if (this.stopped) {
      return Promise.reject(new Error('claude resident session is stopped'));
    }
    if (this.child === null || this.exited || this.rpc === null) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    return this.rpc.submitTurn(prompt, options);
  }

  async steerTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('claude resident session is stopped'));
    }
    if (this.child === null || this.exited || this.rpc === null) {
      return Promise.reject(new Error('claude resident child is not running'));
    }
    return this.rpc.steerTurn(prompt, options);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Mark exited up front so the child's own `exit` event (fired by the kill
    // below) is treated as a deliberate stop, never an unexpected exit that
    // would fire `onExit` and degrade the runtime we are intentionally tearing
    // down.
    this.exited = true;
    this.rpc?.failPending(
      new Error('claude resident session stopped mid-turn'),
    );
    const pid = this.pid;
    if (pid !== null) {
      if (isProcessAlive(pid)) {
        killProcessGroup(pid, 'SIGTERM');
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if (!isProcessAlive(pid)) break;
          await new Promise<void>((r) => setTimeout(r, 25));
        }
      }
      // Always SIGKILL the group — a reparented grandchild outliving its leader
      // is the exact leak this guards against.
      killProcessGroup(pid, 'SIGKILL');
    }
    this.exited = true;
    this.rpc = null;
    this.child = null;
  }

  private onChildExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.rpc?.failPending(new Error('claude resident child exited mid-turn'));
    this.onExitHandler?.();
  }

  setOnExit(handler: () => void): void {
    this.onExitHandler = handler;
  }
}

/**
 * The default factory: spawns the real `claude` binary. The returned session
 * exposes a `setOnExit` registration the runtime uses to react to an unexpected
 * child death (degrade + re-spawn next turn).
 */
export function createDefaultClaudeCodeSession(
  spec: ClaudeCodeSessionSpec,
): ClaudeCodeSession {
  return new LiveClaudeCodeSession(spec);
}

export type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
  ClaudeCodeSessionSpec,
  TurnOutcome,
  TurnSubmitOptions,
} from './types.js';
