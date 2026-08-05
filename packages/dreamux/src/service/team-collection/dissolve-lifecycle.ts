import type { TeamLiveWriter } from '../team-service/types.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveRecord,
  TeamLogicalCloseExecutor,
  TeamSummary,
} from './types.js';

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
    // Public dissolve calls return only the receipt, so logical closure may
    // have no waiter. Keep a rejection observer attached without changing what
    // later target-close consumers observe from the original promise.
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
  const handle: AcceptedTeamDissolve = {
    operationId: input.record.operation_id,
    receipt: {
      accepted: true,
      team_name: input.teamId,
      status: 'closing',
    },
    logicalClosed: logical.promise,
  };
  const operation: TeamDissolveOperation = {
    operationId: input.record.operation_id,
    teamId: input.teamId,
    leaderName: input.leaderName,
    record: input.record,
    writers: input.writers,
    logicalClose: null,
    logical,
    interrupt: new DissolveInterruptSignal(),
    runner: null,
    retryTimer: null,
    needsRecoveryIdle: false,
    handle,
  };
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
