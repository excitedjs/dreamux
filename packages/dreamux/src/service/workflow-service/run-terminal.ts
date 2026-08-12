import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../../platform/error-info.js';
import type {
  WorkflowRunStatus,
  WorkflowTerminalStatus,
} from './types.js';
import { deferred } from './run-support.js';

/** Natural-settle grace granted to submitted turns after a stop intent. */
export const WORKFLOW_STOP_GRACE_MS = 5_000;

/**
 * A public stop whose finalization was taken over by server shutdown. Only the
 * public stop wrapper throws it (after the shared finalization completed); the
 * admin boundary maps it to `SERVER_SHUTTING_DOWN`. Internal shutdown/sweep
 * callers resolve normally.
 */
export class WorkflowStopInterruptedError extends Error {
  constructor() {
    super('workflow stop was interrupted by server shutdown');
    this.name = 'WorkflowStopInterruptedError';
  }
}

/**
 * Owner release failed before the terminal commit. The attempt rejects without
 * `end`, terminal record, delivery, or eviction; the run stays process-live
 * with durable `running` status and closed admission, and the memoized failed
 * attempt is cleared so a later stop or owner-close path can retry against the
 * original deadline.
 */
export class WorkflowOwnerReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOwnerReleaseError';
  }
}

/**
 * Why shutdown took over a run's terminal finalization, distinguishing which
 * part of the terminal barrier remains unproven.
 */
export type WorkflowShutdownTakeoverKind =
  /**
   * Frozen before owner release, or committed with terminal routing
   * synchronously discarded before it began. The collection-wide owner sweep
   * proves the missing release barrier, so the takeover tombstone resolves
   * when the sweep succeeds.
   */
  | 'frozen'
  /**
   * Terminal routing had already started and was detached mid-settle; the
   * owner sweep cannot prove its outcome. Delayed public stops reject while
   * the detached settle remains unresolved (or if it rejects outside the
   * router contract), and become idempotently readable after the exact
   * settle resolves terminally.
   */
  | 'routing-detached';

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
  now: () => number;
  stopGraceMs: number;
}

/**
 * Coordinates terminal reservation, the immutable first-intent stop deadline,
 * prompt stop, and shutdown interruption.
 */
export class WorkflowRunTerminal {
  private readonly shutdownSignal = deferred();
  private readonly deadlineSignal = deferred();
  private task: Promise<void> | null = null;
  private requestedStatus: WorkflowTerminalStatus | null = null;
  private shutdownRequested_ = false;
  private takeover_: WorkflowShutdownTakeoverKind | null = null;
  private stopDeadline_: number | null = null;
  private stopSignaled = false;
  /** The attempt's own natural result/error, reused when a retry joins. */
  private naturalResult: unknown = null;
  private naturalError: string | null = null;

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

  /**
   * The first stop intent's absolute deadline (`intent time + grace`). It is
   * immutable: repeated stop, Team close, and retry attempts never reset it.
   */
  get stopDeadline(): number | null {
    return this.stopDeadline_;
  }

  /** Resolved the moment the first stop intent records the immutable deadline. */
  get stopDeadlineSignal(): Promise<void> {
    return this.deadlineSignal.promise;
  }

  reserveStop(): void {
    this.recordStopDeadline();
    if (!this.accepting) return;
    this.requestedStatus = 'stopped';
    this.deps.closeAdmission('stopped');
  }

  /**
   * The public stop contract: await the shared finalization and return the
   * durable record's real status (including a journal downgrade to `failed`).
   * A stop taken over by shutdown rejects with {@link WorkflowStopInterruptedError}
   * instead of reporting a false terminal barrier.
   */
  async stop(): Promise<WorkflowTerminalStatus> {
    const currentStatus = this.deps.status();
    if (this.requestedStatus === null && currentStatus !== 'running') {
      return currentStatus;
    }
    this.initiateStop();
    if (this.task !== null) await this.task;
    if (this.takeover_ !== null) throw new WorkflowStopInterruptedError();
    const status = this.deps.status();
    if (status === 'running') {
      throw new Error('workflow stop finalization did not reach a terminal status');
    }
    return status;
  }

  /**
   * Internal owner-close path: await the shared finalization without the
   * public wrapper's shutdown rejection. A pre-terminal attempt failure
   * still propagates so Team close routes it through its existing error
   * handling; shutdown takeover resolves.
   */
  async stopAndWait(): Promise<void> {
    const currentStatus = this.deps.status();
    if (this.requestedStatus === null && currentStatus !== 'running') {
      if (this.task !== null) await this.task;
      return;
    }
    this.initiateStop();
    if (this.task !== null) await this.task;
  }

  /**
   * Bound process shutdown: wake terminal waits, then persist a terminal run
   * after killing the runner while leaving owned runtime cleanup to the
   * collection-wide force-stop sweep. A release already in progress remains
   * joined under the current neutral runtime contract.
   */
  async stopForShutdown(): Promise<void> {
    this.signalShutdown();
    if (this.requestedStatus === null && this.deps.status() !== 'running') return;
    this.initiateStop();
    const task = this.task;
    if (task === null) return;
    try {
      await task;
    } catch (error) {
      if (!(error instanceof WorkflowOwnerReleaseError)) throw error;
      // A pre-terminal release failure cleared the memoized attempt; shutdown
      // finalization never releases owners, so one fresh attempt cannot fail
      // the same way again.
      this.observe(this.requestedStatus ?? 'stopped', null, null);
      if (this.task !== null) await this.task;
    }
  }

  /**
   * Wake publication/grace waits and mark shutdown takeover without starting a
   * stop. The in-flight finalization freezes unresolved calls and skips a
   * per-run release that has not begun; not-yet-started finalization is left
   * to the shutdown sweep's `stopForShutdown`.
   */
  signalShutdown(): void {
    this.shutdownRequested_ = true;
    this.shutdownSignal.resolve();
  }

  /**
   * Mark the shared finalization as taken over by shutdown, recording which
   * part of the terminal barrier remains unproven. The first mark wins; the
   * finalization paths never transition between kinds.
   */
  markShutdownTakeover(kind: WorkflowShutdownTakeoverKind): void {
    if (this.takeover_ === null) this.takeover_ = kind;
  }

  /**
   * Per-run shutdown takeover: shutdown took over this run's terminal
   * finalization (frozen before owner release, or detached at terminal
   * routing after the durable commit). The finalizer reports this fact at
   * eviction so a delayed public stop on the evicted run can distinguish a
   * shutdown takeover from a truthful already-terminal commit.
   */
  get takeoverKind(): WorkflowShutdownTakeoverKind | null {
    return this.takeover_;
  }

  private initiateStop(): WorkflowTerminalStatus {
    this.reserveStop();
    if (this.requestedStatus === 'stopped') this.signalStop();
    const status = this.requestedStatus ?? 'stopped';
    this.observe(status, null, null);
    return status;
  }

  request(
    status: WorkflowTerminalStatus,
    result: unknown,
    error: string | null,
  ): Promise<void> {
    if (this.task !== null) return this.task;
    const isFirstRequest = this.requestedStatus === null;
    const terminalStatus = this.requestedStatus ?? status;
    this.requestedStatus = terminalStatus;
    this.deps.closeAdmission(terminalStatus);
    // Remember the original attempt's own result/error so a later retry keeps
    // the original terminal payload.
    if (isFirstRequest) {
      this.naturalResult = result;
      this.naturalError = error;
    }
    const attempt = this.deps.finalize(
      terminalStatus,
      isFirstRequest ? result : this.naturalResult,
      isFirstRequest ? error : this.naturalError,
    );
    const task = attempt.catch((attemptError: unknown) => {
      // Only a pre-terminal owner-release failure clears the memoized failed
      // attempt, so a later stop or owner-close path retries against the
      // original deadline instead of persisting a false terminal fact. The
      // durable record remains `running`. Other failures (notably a latched
      // WorkflowJournal persistence failure) stay fail-loud: no in-process
      // retry is promised, and no false terminal fact is published.
      if (
        this.task === task &&
        this.deps.status() === 'running' &&
        attemptError instanceof WorkflowOwnerReleaseError
      ) {
        this.task = null;
      }
      throw attemptError;
    });
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

  waitUnlessShutdown(task: Promise<boolean> | Promise<void>): Promise<boolean> {
    if (this.shutdownRequested_) return Promise.resolve(false);
    return Promise.race([
      task.then(() => true),
      this.shutdownSignal.promise.then(() => false),
    ]);
  }

  private recordStopDeadline(): void {
    if (this.stopDeadline_ !== null) return;
    this.stopDeadline_ = this.deps.now() + this.deps.stopGraceMs;
    this.deadlineSignal.resolve();
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
