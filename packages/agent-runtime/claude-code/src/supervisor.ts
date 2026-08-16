/**
 * Claude Code resident child process supervisor.
 *
 * Mirrors `codex/supervisor.ts` for the `builtin:claude-code` transport:
 * spawn the long-lived `claude --print --input-format stream-json` child,
 * own its process group, surface unexpected exits, and delegate turn RPC to
 * `claude-code/rpc.ts`.
 */

import type { ChildProcess } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  removeEmptyLogFile,
  SupervisedChild,
} from '@excitedjs/dreamux-utils';
import {
  ClaudeCodeStreamRpc,
  ClaudeSteerAdmissionError,
} from './rpc.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionSpec,
  TurnOutcome,
  TurnSubmitOptions,
} from './types.js';

/** The live session: spawns and supervises the real `claude` child. */
class LiveClaudeCodeSession implements ClaudeCodeSession {
  private supervisor: SupervisedChild | null = null;
  private child: ChildProcess | null = null;
  private exited = false;
  private stopped = false;
  private stopRequested = false;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private rpc: ClaudeCodeStreamRpc | null = null;
  private onExitHandler: (() => void) | null = null;

  constructor(private readonly spec: ClaudeCodeSessionSpec) {}

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  start(): Promise<void> {
    if (this.stopRequested || this.stopped) {
      return Promise.reject(new Error('ClaudeCodeSession.start: stopped'));
    }
    if (this.startTask !== null) return this.startTask;
    if (this.child !== null) {
      return Promise.reject(new Error('ClaudeCodeSession.start: already started'));
    }
    const task = this.startSession();
    this.startTask = task;
    void task.finally(() => {
      if (this.startTask === task) this.startTask = null;
    }).catch(() => undefined);
    return task;
  }

  private async startSession(): Promise<void> {
    this.assertStartAllowed();
    await mkdir(this.spec.cwd, { recursive: true });
    this.assertStartAllowed();
    await mkdir(dirname(this.spec.stderrLogPath), { recursive: true });
    this.assertStartAllowed();
    // Open the stderr log as a FileHandle and hand its fd to the child. The
    // handle is closed once the child owns the inherited fd (the finally),
    // matching the timing discipline in codex/supervisor.ts.
    const stderrHandle = await open(this.spec.stderrLogPath, 'a', 0o600);
    if (this.stopRequested) {
      await stderrHandle.close();
      this.assertStartAllowed();
    }
    const supervisor = new SupervisedChild({
      kind: 'spawn',
      command: this.spec.bin,
      args: this.spec.args,
      options: {
        cwd: this.spec.cwd,
        env: this.spec.env,
        stdio: ['pipe', 'pipe', stderrHandle.fd],
      },
    });
    supervisor.onError((error) => {
      this.spec.log?.('warn', 'claude resident child error', error);
    });
    supervisor.onExit(() => this.onChildExit());
    // Publish group-termination authority before spawn resolves. If a later
    // setup step fails, runtime cleanup can still prove that no child remains.
    this.supervisor = supervisor;
    let child: ChildProcess;
    try {
      child = await supervisor.start();
    } finally {
      await stderrHandle.close();
    }
    this.child = child;
    this.assertStartAllowed();
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
  }

  async submitTurn(
    prompt: string,
    options: TurnSubmitOptions = {},
  ): Promise<TurnOutcome> {
    if (this.stopRequested || this.stopped) {
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
    if (this.stopRequested || this.stopped) {
      return Promise.reject(
        new ClaudeSteerAdmissionError(
          'failed',
          'claude resident session is stopped before live steer',
        ),
      );
    }
    if (this.child === null || this.exited || this.rpc === null) {
      return Promise.reject(
        new ClaudeSteerAdmissionError(
          'failed',
          'claude resident child is not running before live steer',
        ),
      );
    }
    return this.rpc.steerTurn(prompt, options);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopTask !== null) return this.stopTask;
    this.stopRequested = true;
    const task = this.stopSession();
    this.stopTask = task;
    try {
      await task;
    } catch (error) {
      if (this.stopTask === task) this.stopTask = null;
      throw error;
    }
  }

  private async stopSession(): Promise<void> {
    // Mark exited up front so the child's own `exit` event (fired by the kill
    // below) is treated as a deliberate stop, never an unexpected exit that
    // would fire `onExit` and degrade the runtime we are intentionally tearing
    // down.
    this.exited = true;
    this.rpc?.failPending(
      new Error('claude resident session stopped mid-turn'),
    );
    const supervisorAtStop = this.supervisor;
    const supervisorStop = supervisorAtStop?.stop() ?? null;
    void supervisorStop?.catch(() => undefined);
    const supervisor = this.supervisor;
    await (supervisor === supervisorAtStop && supervisorStop !== null
      ? supervisorStop
      : supervisor?.stop());
    this.exited = true;
    this.rpc = null;
    this.child = null;
    this.supervisor = null;
    // The child is gone, so its inherited stderr fd is released. Drop the stderr
    // log if it stayed empty — claude traffic flows over the resident stream, so
    // it usually captures nothing (issue #182 logs stage).
    await removeEmptyLogFile(this.spec.stderrLogPath);
    this.stopped = true;
  }

  private assertStartAllowed(): void {
    if (this.stopRequested || this.stopped) {
      throw new Error('ClaudeCodeSession.start: stopped during start');
    }
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
