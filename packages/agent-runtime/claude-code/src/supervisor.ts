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
import { ClaudeCodeStreamRpc } from './rpc.js';
import type { RuntimeAdmission } from '@excitedjs/dreamux-types';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionSpec,
  TurnSubmitOptions,
} from './types.js';

/** The live session: spawns and supervises the real `claude` child. */
class LiveClaudeCodeSession implements ClaudeCodeSession {
  private supervisor: SupervisedChild | null = null;
  private child: ChildProcess | null = null;
  private exitError: Error | null = null;
  private stopped = false;
  private stopRequested = false;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private rpc: ClaudeCodeStreamRpc | null = null;
  private onExitHandler: ((error: Error) => void) | null = null;

  constructor(private readonly spec: ClaudeCodeSessionSpec) {}

  isAlive(): boolean {
    return this.child !== null && !this.stopRequested && this.exitError === null;
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
    supervisor.onExit(() => this.onChildExit(new Error('claude resident child exited')));
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
      sessionId: this.spec.sessionId,
      outputSchemaEnabled: this.spec.outputSchemaEnabled,
      turnTimeoutMs: this.spec.turnTimeoutMs,
      log: this.spec.log,
      reapOnTimeout: (error) => {
        this.onChildExit(error);
        void this.stop().catch(() => {
          /* reap is best-effort */
        });
      },
      onRemoteControlUrl: this.spec.onRemoteControlUrl,
      onProtocolEvent: this.spec.onProtocolEvent,
    });
    this.rpc = rpc;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      rpc.onStdoutChunk(chunk);
    });
    if (this.spec.remoteControl) rpc.enableRemoteControl();
  }

  submit(
    prompt: string,
    options: TurnSubmitOptions = {},
    commandUuid?: string,
  ): Promise<RuntimeAdmission> {
    if (this.exitError !== null) return Promise.resolve({ status: 'failed', error: this.exitError });
    if (this.stopRequested || this.stopped) return Promise.resolve({ status: 'stopped' });
    if (this.child === null || this.rpc === null) {
      return Promise.resolve({ status: 'failed', error: new Error('claude resident child is not running') });
    }
    return this.rpc.submit(prompt, options, commandUuid);
  }

  /**
   * A dead child has nothing to interrupt, so this answers false rather than
   * writing to its stdin. The liveness half matters on its own: a child that
   * exited between the last stream line and this call still has an `rpc`, and
   * writing to it surfaces an EPIPE as `Command /stop failed: write EPIPE`
   * instead of the honest `No turn is running.`
   */
  interrupt(reason: string): Promise<boolean> {
    if (!this.isAlive() || this.stopped || this.rpc === null) {
      return Promise.resolve(false);
    }
    return this.rpc.interrupt(reason);
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
    // stopRequested already suppresses the exit caused by this teardown.
    // An earlier unexpected exit retains its failure cause through cleanup.
    this.rpc?.stop();
    const supervisorAtStop = this.supervisor;
    const supervisorStop = supervisorAtStop?.stop() ?? null;
    void supervisorStop?.catch(() => undefined);
    const supervisor = this.supervisor;
    await (supervisor === supervisorAtStop && supervisorStop !== null
      ? supervisorStop
      : supervisor?.stop());
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

  private onChildExit(error: Error): void {
    if (this.stopRequested || this.exitError !== null) return;
    this.exitError = error;
    this.rpc?.fail(error);
    this.onExitHandler?.(error);
  }

  setOnExit(handler: (error: Error) => void): void {
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
