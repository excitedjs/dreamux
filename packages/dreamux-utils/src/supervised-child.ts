import {
  fork,
  spawn,
  type ChildProcess,
  type ForkOptions,
  type SpawnOptions,
} from 'node:child_process';

import { isProcessGroupAlive, killProcessGroup } from './os.js';

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
 * Neutral owner for one detached child process group. Domain wrappers keep
 * readiness probes, transports, and cleanup policy; this class owns only
 * launch, unexpected-exit observation, and two-stage group termination.
 */
export class SupervisedChild {
  private child_: ChildProcess | null = null;
  private pid_: number | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
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
    if (this.child_ !== null) {
      throw new Error('SupervisedChild.start: already started');
    }
    if (this.stopping) {
      throw new Error('SupervisedChild.start: already stopped');
    }

    const child = launchChild(this.launch);
    this.child_ = child;
    // Node assigns pid synchronously for a successfully launched child. Publish
    // it before the first await so a concurrent stop can never miss the group.
    if (child.pid !== undefined) this.pid_ = child.pid;
    child.on('error', (error) => this.notifyError(error));
    child.once('exit', (code, signal) => {
      if (this.stopping) return;
      this.notifyExit({ code, signal });
    });

    try {
      await waitForSpawn(child);
    } catch (error) {
      this.child_ = null;
      this.pid_ = null;
      throw error;
    }
    if (child.pid === undefined) {
      this.child_ = null;
      this.pid_ = null;
      throw new Error('supervised child spawned without a pid');
    }
    this.pid_ = child.pid;
    if (this.stopping) {
      await this.stopPromise;
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
    const pid = this.pid_;
    if (pid !== null) {
      if (isProcessGroupAlive(pid)) {
        killProcessGroup(pid, 'SIGTERM');
        await waitForProcessGroupExit(
          pid,
          this.options.stopTimeoutMs ?? 1_000,
          this.options.pollIntervalMs ?? 25,
        );
      }
      if (isProcessGroupAlive(pid)) {
        killProcessGroup(pid, 'SIGKILL');
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

function launchChild(launch: SupervisedChildLaunch): ChildProcess {
  if (launch.kind === 'fork') {
    return fork(launch.modulePath, [...(launch.args ?? [])], {
      ...launch.options,
      detached: true,
    });
  }
  return spawn(launch.command, [...(launch.args ?? [])], {
    ...launch.options,
    detached: true,
  });
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.off('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = (): void => {
      if (settled) return;
      settled = true;
      child.off('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}
