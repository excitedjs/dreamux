import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type {
  WorkflowRunStatus,
  WorkflowTerminalStatus,
} from './types.js';
import { deferred, errorInfo } from './run-support.js';

interface WorkflowRunTerminalDeps {
  runId: string;
  status: () => WorkflowRunStatus;
  abortRunner: () => Promise<void>;
  closeAdmission: (status: WorkflowTerminalStatus) => void;
  finalize: (
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ) => Promise<void>;
  log: DreamuxLogger;
}

/** Coordinates terminal reservation, prompt stop, and shutdown interruption. */
export class WorkflowRunTerminal {
  private readonly shutdownSignal = deferred();
  private task: Promise<void> | null = null;
  private requestedStatus: WorkflowTerminalStatus | null = null;
  private shutdownRequested_ = false;
  private stopSignaled = false;

  constructor(private readonly deps: WorkflowRunTerminalDeps) {}

  get requested(): WorkflowTerminalStatus | null {
    return this.requestedStatus;
  }

  get accepting(): boolean {
    return this.requestedStatus === null && this.deps.status() === 'running';
  }

  get suppressDelivery(): boolean {
    return this.requestedStatus !== null;
  }

  get shutdownRequested(): boolean {
    return this.shutdownRequested_;
  }

  reserveStop(): void {
    if (!this.accepting) return;
    this.requestedStatus = 'stopped';
    this.deps.closeAdmission('stopped');
  }

  async stop(): Promise<WorkflowTerminalStatus> {
    const currentStatus = this.deps.status();
    if (this.requestedStatus === null && currentStatus !== 'running') {
      return currentStatus;
    }
    this.reserveStop();
    if (this.requestedStatus === 'stopped') this.signalStop();
    this.observe(this.requestedStatus ?? 'stopped', null, null);
    return this.requestedStatus ?? 'stopped';
  }

  async stopAndWait(): Promise<void> {
    await this.stop();
    if (this.task !== null) await this.task;
  }

  async stopForShutdown(): Promise<void> {
    this.shutdownRequested_ = true;
    this.shutdownSignal.resolve();
    if (this.requestedStatus === null && this.deps.status() !== 'running') return;
    this.reserveStop();
    if (this.requestedStatus === 'stopped') this.signalStop();
    this.observe(this.requestedStatus ?? 'stopped', null, null);
    if (this.task !== null) await this.task;
  }

  request(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    if (this.task !== null) return this.task;
    const terminalStatus = this.requestedStatus ?? status;
    this.requestedStatus = terminalStatus;
    this.deps.closeAdmission(terminalStatus);
    const task = this.deps.finalize(
      terminalStatus,
      terminalStatus === status ? result : null,
      terminalStatus === status ? error : null,
    );
    this.task = task;
    return task;
  }

  observe(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): void {
    void this.request(status, result, error).catch((terminalError: unknown) => {
      this.deps.log.error(
        { run_id: this.deps.runId, err: errorInfo(terminalError) },
        'workflow terminal transition failed',
      );
    });
  }

  waitUnlessShutdown(task: Promise<void>): Promise<boolean> {
    if (this.shutdownRequested_) return Promise.resolve(false);
    return Promise.race([
      task.then(() => true),
      this.shutdownSignal.promise.then(() => false),
    ]);
  }

  private signalStop(): void {
    if (this.stopSignaled) return;
    this.stopSignaled = true;
    this.deps.log.info({ run_id: this.deps.runId }, 'stopping workflow run');
    void this.deps.abortRunner().catch((error: unknown) => {
      this.deps.log.warn(
        { run_id: this.deps.runId, err: errorInfo(error) },
        'workflow abort IPC failed; killing runner',
      );
    });
  }
}
