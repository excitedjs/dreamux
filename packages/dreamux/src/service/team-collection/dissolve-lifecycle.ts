import type { TeamLiveWriter } from '../team-service/index.js';
import { TeamDissolveInterruptedError } from './errors.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveCleanupPendingResult,
  TeamDissolveRecord,
  TeamLogicalCloseExecutor,
  TeamSummary,
} from './types.js';

export const TEAM_DISSOLVE_RESULT_BUDGET_MS = 9_000;
export const TEAM_DISSOLVE_RETRY_MIN_MS = 1_000;
export const TEAM_DISSOLVE_RETRY_MAX_MS = 60_000;

export class DissolveMilestone<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    // Self-dissolve returns only the receipt, so milestones may have no public
    // waiter. Keep a rejection observer attached without changing what later
    // consumers observe from the original promise.
    void this.promise.catch(() => undefined);
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise(value);
  }

  reject(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(error);
  }
}

export class DissolveInterruptSignal {
  readonly promise: Promise<void>;
  private interruptPromise!: () => void;
  private interrupted = false;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.interruptPromise = resolve;
    });
  }

  interrupt(): void {
    if (this.interrupted) return;
    this.interrupted = true;
    this.interruptPromise();
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }
}

export interface TeamDissolveOperation {
  /** Immutable accepted generation; `record` is only its mutable snapshot. */
  readonly operationId: string;
  readonly teamId: string;
  /** Immutable TeamLeader generation captured with the accepted operation. */
  readonly leaderName: string;
  record: TeamDissolveRecord;
  writers: TeamLiveWriter[];
  logicalClose: TeamLogicalCloseExecutor | null;
  logical: DissolveMilestone<TeamSummary>;
  completed: DissolveMilestone<TeamSummary>;
  interrupt: DissolveInterruptSignal;
  runner: Promise<void> | null;
  retryTimer: NodeJS.Timeout | null;
  /** Restart recovery must re-quiesce reattached writers before resuming. */
  needsRecoveryIdle: boolean;
  handle: AcceptedTeamDissolve;
}

export function newDissolveOperation(input: {
  teamId: string;
  leaderName: string;
  record: TeamDissolveRecord;
  writers: TeamLiveWriter[];
}): TeamDissolveOperation {
  const logical = new DissolveMilestone<TeamSummary>();
  const completed = new DissolveMilestone<TeamSummary>();
  let readRecord = (): TeamDissolveRecord => input.record;
  const handle: AcceptedTeamDissolve = {
    operationId: input.record.operation_id,
    teamId: input.teamId,
    receipt: {
      accepted: true,
      team_name: input.teamId,
      status: 'closing',
    },
    logicalClosed: logical.promise,
    completed: completed.promise,
    dissolveSnapshot: () => readRecord(),
  };
  const operation: TeamDissolveOperation = {
    operationId: input.record.operation_id,
    teamId: input.teamId,
    leaderName: input.leaderName,
    record: input.record,
    writers: input.writers,
    logicalClose: null,
    logical,
    completed,
    interrupt: new DissolveInterruptSignal(),
    runner: null,
    retryTimer: null,
    needsRecoveryIdle: false,
    handle,
  };
  readRecord = () => operation.record;
  return operation;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(
    TEAM_DISSOLVE_RETRY_MAX_MS,
    TEAM_DISSOLVE_RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1),
  );
}

export function isActiveDissolve(
  record: TeamDissolveRecord | null,
): boolean {
  return record !== null && record.phase !== 'complete' && record.phase !== 'failed';
}

export function projectInProgressDissolve(
  handle: AcceptedTeamDissolve,
): AcceptedTeamDissolve['receipt'] | TeamDissolveCleanupPendingResult {
  const current = handle.dissolveSnapshot();
  if (
    current.operation_id === handle.operationId &&
    current.phase === 'worktree_cleanup_pending'
  ) {
    return {
      accepted: true,
      team_name: handle.teamId,
      status: 'closed',
      worktree_cleanup: 'pending',
      message: 'Managed worktree cleanup continues in the background.',
    };
  }
  return handle.receipt;
}

/** Project a bounded Dispatcher result without cancelling accepted work. */
export async function projectDispatcherDissolveResult(
  handle: AcceptedTeamDissolve,
  budgetMs: number = TEAM_DISSOLVE_RESULT_BUDGET_MS,
): Promise<
  TeamSummary |
  AcceptedTeamDissolve['receipt'] |
  TeamDissolveCleanupPendingResult
> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([
      handle.completed.then((summary) => ({ summary })),
      timeout,
    ]);
    return outcome === 'timeout'
      ? projectInProgressDissolve(handle)
      : outcome.summary;
  } catch (error) {
    if (error instanceof TeamDissolveInterruptedError) {
      return projectInProgressDissolve(handle);
    }
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
