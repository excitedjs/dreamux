import type { ChildProcess } from 'node:child_process';

import {
  SupervisedChild,
  type SupervisedChildExit,
} from '@excitedjs/dreamux-utils';

import type { WorkflowRunnerParentMessage } from './protocol.js';

export interface WorkflowRunnerHandle {
  start(): Promise<void>;
  send(message: WorkflowRunnerParentMessage): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkflowRunnerHandlers {
  onMessage(message: unknown): void;
  onExit(exit: SupervisedChildExit): void;
  onError(error: Error): void;
}

export type WorkflowRunnerFactory = (
  handlers: WorkflowRunnerHandlers,
) => WorkflowRunnerHandle;

/** IPC adapter around the neutral process-group supervisor. */
export class ForkedWorkflowRunner implements WorkflowRunnerHandle {
  private readonly child: SupervisedChild;
  private process: ChildProcess | null = null;

  constructor(
    entryPath: string,
    private readonly handlers: WorkflowRunnerHandlers,
  ) {
    this.child = new SupervisedChild({
      kind: 'fork',
      modulePath: entryPath,
      options: {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: ['--experimental-vm-modules'],
      },
    });
    this.child.onError((error) => this.handlers.onError(error));
  }

  async start(): Promise<void> {
    const process = await this.child.start();
    this.process = process;
    process.on('message', (message) => this.handlers.onMessage(message));
    process.once('exit', (code, signal) => {
      this.handlers.onExit({ code, signal });
    });
  }

  async send(message: WorkflowRunnerParentMessage): Promise<void> {
    const process = this.process;
    if (process === null || process.send === undefined || !process.connected) {
      throw new Error('workflow runner IPC channel is unavailable');
    }
    await new Promise<void>((resolve, reject) => {
      process.send?.(message, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    await this.child.stop();
    this.process = null;
  }
}
