import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import type {
  WorkflowRunStatus,
  WorkflowTerminalStatus,
} from './types.js';

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

interface TerminalIntent {
  status: WorkflowTerminalStatus;
  result: unknown;
  error: string | null;
}

/** One retryable, truthful terminal task shared by every stop source. */
export class WorkflowRunTerminal {
  /**
   * Resolves once this run is durably over: terminal record written, terminal
   * completion delivered, nothing left to retry.
   *
   * It is a fact the run states about itself, not an instruction. The owner
   * that holds the run decides what being over means for its own bookkeeping;
   * the run does not reach up and remove itself from a collection it is not
   * allowed to know about.
   */
  readonly settled: Promise<void>;

  private task: Promise<void> | null = null;
  private intent: TerminalIntent | null = null;
  private beforeFinalize: Promise<void> | null = null;
  private announceSettled!: () => void;

  constructor(private readonly deps: WorkflowRunTerminalDeps) {
    this.settled = new Promise<void>((resolve) => {
      this.announceSettled = resolve;
    });
  }

  get requested(): WorkflowTerminalStatus | null {
    return this.intent?.status ?? null;
  }

  get accepting(): boolean {
    return this.intent === null && this.deps.status() === 'running';
  }

  get suppressDelivery(): boolean {
    return this.intent !== null;
  }

  reserveStop(): void {
    if (this.intent !== null || this.deps.status() !== 'running') return;
    this.intent = { status: 'stopped', result: null, error: null };
    this.deps.closeAdmission('stopped');
    this.signalStop();
  }

  async failAfterNotification(
    error: string,
    notify: () => Promise<void>,
  ): Promise<void> {
    const shouldNotify = this.reserveFailure(error);
    if (!shouldNotify) return;
    const notification = Promise.resolve().then(notify);
    this.beforeFinalize = notification;
    try {
      await notification;
    } finally {
      this.observe('failed', null, error);
    }
  }

  async stop(): Promise<WorkflowTerminalStatus> {
    if (this.intent === null && this.deps.status() !== 'running') {
      return this.deps.status() as WorkflowTerminalStatus;
    }
    this.reserveStop();
    await this.ensureTask();
    return this.intent?.status ?? (this.deps.status() as WorkflowTerminalStatus);
  }

  request(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    if (this.intent === null) {
      this.intent = { status, result, error };
      this.deps.closeAdmission(status);
    }
    return this.ensureTask();
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

  private ensureTask(): Promise<void> {
    if (this.task !== null) return this.task;
    const intent = this.intent;
    if (intent === null) return Promise.resolve();
    const task = (this.beforeFinalize ?? Promise.resolve())
      .catch((notificationError: unknown) => {
        this.deps.log.warn(
          { run_id: this.deps.runId, err: errorInfo(notificationError) },
          'workflow terminal notification failed; continuing teardown',
        );
      })
      .then(() => this.deps.finalize(intent.status, intent.result, intent.error))
      .then(() => {
        this.announceSettled();
      })
      .catch((error: unknown) => {
        if (this.task === task) this.task = null;
        throw error;
      });
    this.task = task;
    return task;
  }

  private reserveFailure(error: string): boolean {
    if (this.intent !== null || this.deps.status() !== 'running') return false;
    this.intent = { status: 'failed', result: null, error };
    this.deps.closeAdmission('failed');
    return true;
  }

  /** Reached once: the caller reserved the stop intent before asking for it. */
  private signalStop(): void {
    this.deps.log.info({ run_id: this.deps.runId }, 'stopping workflow run');
    void this.deps.abortRunner().catch((error: unknown) => {
      this.deps.log.warn(
        { run_id: this.deps.runId, err: errorInfo(error) },
        'workflow abort IPC failed; killing runner',
      );
    });
  }
}
