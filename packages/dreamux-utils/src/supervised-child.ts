import {
  fork,
  type ChildProcess,
  type ForkOptions,
  type SpawnOptions,
} from 'node:child_process';
import { once } from 'node:events';

import { isProcessGroupAlive, killProcessGroup } from './os.js';
import { spawnCommand } from './process-command.js';
import type { WindowsJob } from './windows-job.js';

export interface SupervisedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type SupervisedChildLaunch =
  | {
      kind: 'spawn';
      command: string;
      args?: readonly string[];
      options?: Omit<SpawnOptions, 'detached'>;
    }
  | {
      kind: 'fork';
      modulePath: string;
      args?: readonly string[];
      options?: Omit<ForkOptions, 'detached'>;
    };

export interface SupervisedChildOptions {
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

type ExitHandler = (exit: SupervisedChildExit) => void;
type ErrorHandler = (error: Error) => void;

/**
 * Neutral owner for one child process tree. Domain wrappers keep
 * readiness probes, transports, and cleanup policy; this class owns only
 * launch, unexpected-exit observation, and platform-native tree termination.
 */
export class SupervisedChild {
  private child_: ChildProcess | null = null;
  private pid_: number | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startPromise: Promise<ChildProcess> | null = null;
  private windowsJob: WindowsJob | null = null;
  private readonly exitHandlers = new Set<ExitHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  constructor(
    private readonly launch: SupervisedChildLaunch,
    private readonly options: SupervisedChildOptions = {},
  ) {}

  get pid(): number | null {
    return this.pid_;
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  async start(): Promise<ChildProcess> {
    if (this.child_ !== null || this.startPromise !== null) {
      throw new Error('SupervisedChild.start: already started');
    }
    if (this.stopping) {
      throw new Error('SupervisedChild.start: already stopped');
    }
    const attempt = this.doStart();
    this.startPromise = attempt;
    try {
      return await attempt;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<ChildProcess> {
    let child: ChildProcess;
    try {
      if (process.platform === 'win32') {
        const { launchWindowsChild } = await import('./windows-child.js');
        const launched = await launchWindowsChild(this.launch);
        child = launched.child;
        this.windowsJob = launched.job;
      } else {
        child = await launchChild(this.launch);
      }
    } catch (error) {
      this.notifyError(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    this.child_ = child;
    // stop() joins pending launch before reading this process-tree authority.
    if (child.pid !== undefined) this.pid_ = child.pid;
    child.on('error', (error) => this.notifyError(error));
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.notifyExit({ code, signal });
    });

    if (child.pid === undefined) {
      this.child_ = null;
      this.pid_ = null;
      throw new Error('supervised child spawned without a pid');
    }
    this.pid_ = child.pid;
    if (this.stopping) {
      throw new Error('SupervisedChild.start: stopped during start');
    }
    return child;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    const attempt = this.doStop();
    this.stopPromise = attempt;
    void attempt.catch(() => {
      if (this.stopPromise === attempt) this.stopPromise = null;
    });
    return attempt;
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    await this.startPromise?.catch(() => undefined);
    if (process.platform === 'win32') {
      await this.windowsJob?.terminate();
      this.windowsJob?.close();
      this.windowsJob = null;
      this.child_ = null;
      this.pid_ = null;
      return;
    }
    const pid = this.pid_;
    if (pid !== null) {
      if (isProcessGroupAlive(pid)) {
        await killProcessGroup(pid, 'SIGTERM');
        await waitForProcessGroupExit(
          pid,
          this.options.stopTimeoutMs ?? 1_000,
          this.options.pollIntervalMs ?? 25,
        );
      }
      if (isProcessGroupAlive(pid)) {
        await killProcessGroup(pid, 'SIGKILL');
        await waitForProcessGroupExit(
          pid,
          this.options.stopTimeoutMs ?? 1_000,
          this.options.pollIntervalMs ?? 25,
        );
      }
      if (isProcessGroupAlive(pid)) {
        throw new Error(
          `SupervisedChild.stop: process group ${pid} still exists after SIGKILL`,
        );
      }
    }
    this.child_ = null;
    this.pid_ = null;
  }

  private notifyExit(exit: SupervisedChildExit): void {
    for (const handler of this.exitHandlers) {
      try {
        handler(exit);
      } catch {
        // Observers must not poison child-process event dispatch.
      }
    }
  }

  private notifyError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Observers must not poison child-process event dispatch.
      }
    }
  }
}

async function waitForProcessGroupExit(
  pgid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isProcessGroupAlive(pgid) && Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(1, pollIntervalMs)),
    );
  }
}

async function launchChild(
  launch: SupervisedChildLaunch,
): Promise<ChildProcess> {
  if (launch.kind === 'fork') {
    const options = {
      ...launch.options,
      detached: process.platform !== 'win32',
      windowsHide: true,
    };
    const child = fork(launch.modulePath, [...(launch.args ?? [])], options);
    await once(child, 'spawn');
    return child;
  }
  return spawnCommand(launch.command, [...(launch.args ?? [])], {
    ...launch.options,
    detached: process.platform !== 'win32',
  });
}
