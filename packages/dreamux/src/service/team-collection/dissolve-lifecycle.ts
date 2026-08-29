import type {
  AcceptedTeamDissolve,
  TeamDissolveRecord,
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
    // An operation rebuilt by recovery has nobody waiting on it. Keep one
    // observer attached so its settlement is never an unhandled rejection.
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
  logical: DissolveMilestone<TeamSummary>;
  interrupt: DissolveInterruptSignal;
  runner: Promise<void> | null;
  retryTimer: NodeJS.Timeout | null;
  handle: AcceptedTeamDissolve;
}

export function newDissolveOperation(input: {
  teamId: string;
  leaderName: string;
  record: TeamDissolveRecord;
}): TeamDissolveOperation {
  const logical = new DissolveMilestone<TeamSummary>();
  const handle: AcceptedTeamDissolve = {
    operationId: input.record.operation_id,
    receipt: {
      accepted: true,
      team_name: input.teamId,
      status: 'closed',
    },
    logicalClosed: logical.promise,
  };
  const operation: TeamDissolveOperation = {
    operationId: input.record.operation_id,
    teamId: input.teamId,
    leaderName: input.leaderName,
    record: input.record,
    logical,
    interrupt: new DissolveInterruptSignal(),
    runner: null,
    retryTimer: null,
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

/**
 * Is this operation still owed work?
 *
 * The three terminal phases are terminal for different reasons — the Team
 * closed, the close failed, or the post-stop check kept the workspace — but
 * they agree on the only thing this predicate decides: nothing further will
 * happen under that operation id, so the Team is no longer fenced by it.
 */
export function isActiveDissolve(
  record: TeamDissolveRecord | null,
): boolean {
  return record !== null &&
    record.phase !== 'complete' &&
    record.phase !== 'failed' &&
    record.phase !== 'blocked_after_stop';
}
