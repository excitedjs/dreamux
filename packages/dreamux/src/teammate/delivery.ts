/**
 * TeamMate completion delivery with bounded retry (issue #110 PR8).
 *
 * The Dispatcher Service hands a finished task's result back into the scheduling
 * dispatcher's context through the selected AgentRuntimeProvider's
 * `deliverTeamMateCompletion` seam (Codex: inbox + turn trigger; Claude Code:
 * task notification). It is runtime-agnostic — it only consumes the public
 * `AgentRuntime` interface, never turn-manager internals — so it survives the
 * planned move of queue/state to a per-dispatcher state owner.
 *
 * Durability invariant: the result is persisted by `ledger.recordResult` BEFORE
 * any delivery attempt. Delivery only ever transitions an already-saved result
 * to `delivered` or `delivery_failed`. The bounded retry is thin protection
 * against transient submit failures; the real "never lose a result" guarantee is
 * retention + the pull path, not the retry.
 */

import type { AgentRuntime } from '../agent-runtime/types.js';
import type { TeamMateTaskLedger, TeamMateTaskRecord } from './ledger.js';

export interface TeamMateCompletionInput {
  dispatcherId: string;
  taskId: string;
  outcome: 'completed' | 'failed';
  finalText: string;
  now?: number;
}

export type TeamMateDeliveryReport =
  | { status: 'delivered'; task: TeamMateTaskRecord }
  | { status: 'delivery_failed'; task: TeamMateTaskRecord };

export interface TeamMateDeliveryServiceDeps {
  /** Resolve the per-dispatcher ledger. */
  ledger: (dispatcherId: string) => TeamMateTaskLedger;
  /** Resolve the dispatcher's running runtime, or null when it is not up. */
  resolveRuntime: (dispatcherId: string) => AgentRuntime | null;
  /** Max delivery attempts before `delivery_failed` (default 3, min 1). */
  maxAttempts?: number;
  /** Backoff before the next attempt, in ms (default exponential; tests pass 0). */
  backoffMs?: (attempt: number) => number;
  /** Sleep seam (default real timer). */
  sleep?: (ms: number) => Promise<void>;
  log?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 5_000;

function defaultBackoff(attempt: number): number {
  return Math.min(DEFAULT_BACKOFF_MAX_MS, DEFAULT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TeamMateDeliveryService {
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TeamMateDeliveryServiceDeps) {
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.backoffMs = deps.backoffMs ?? defaultBackoff;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Record a task's result durably, then deliver it into the dispatcher context
   * with bounded retry. Returns `delivered` or `delivery_failed` (pull-able).
   * Throws only if the result cannot be recorded (unknown task / illegal
   * transition such as a double report).
   */
  async reportCompletion(
    input: TeamMateCompletionInput,
  ): Promise<TeamMateDeliveryReport> {
    const ledger = this.deps.ledger(input.dispatcherId);
    // Persist the result FIRST — before any delivery attempt — so it can never
    // be lost by a downed runtime or a crash mid-delivery.
    await ledger.recordResult(input.taskId, {
      outcome: input.outcome,
      text: input.finalText,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return this.deliver(input.dispatcherId, input.taskId);
  }

  private async deliver(
    dispatcherId: string,
    taskId: string,
  ): Promise<TeamMateDeliveryReport> {
    const ledger = this.deps.ledger(dispatcherId);
    const task = await ledger.getTask(taskId);
    if (task === null || task.result === null) {
      // recordResult just succeeded, so this is only reachable on a concurrent
      // mutation; treat as a delivery failure rather than crashing the caller.
      const failed = await ledger.recordDeliveryFailed(taskId, {
        error: 'result missing at delivery time',
      });
      return { status: 'delivery_failed', task: failed };
    }
    const envelope = {
      taskId: task.task_id,
      teammateId: task.teammate_id ?? task.task_id,
      status: task.result.outcome,
      finalText: task.result.text,
    };

    let lastError = 'delivery not attempted';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const failure = await this.attemptOnce(dispatcherId, envelope);
      if (failure === null) {
        const delivered = await ledger.recordDelivered(taskId);
        this.deps.log?.('info', 'teammate completion delivered', {
          dispatcher_id: dispatcherId,
          task_id: taskId,
          attempt,
        });
        return { status: 'delivered', task: delivered };
      }
      lastError = failure;
      await ledger.recordDeliveryAttemptFailure(taskId, { error: failure });
      this.deps.log?.('warn', 'teammate completion delivery attempt failed', {
        dispatcher_id: dispatcherId,
        task_id: taskId,
        attempt,
        error: failure,
      });
      if (attempt < this.maxAttempts) {
        await this.sleep(this.backoffMs(attempt));
      }
    }

    const failed = await ledger.recordDeliveryFailed(taskId, { error: lastError });
    this.deps.log?.('error', 'teammate completion delivery failed; result is pull-able', {
      dispatcher_id: dispatcherId,
      task_id: taskId,
      attempts: this.maxAttempts,
      error: lastError,
    });
    return { status: 'delivery_failed', task: failed };
  }

  /** One delivery attempt. Returns null on success or a failure reason string. */
  private async attemptOnce(
    dispatcherId: string,
    envelope: {
      taskId: string;
      teammateId: string;
      status: 'completed' | 'failed';
      finalText: string;
    },
  ): Promise<string | null> {
    const runtime = this.deps.resolveRuntime(dispatcherId);
    if (runtime === null) {
      return 'dispatcher runtime is not running';
    }
    if (runtime.deliverTeamMateCompletion === undefined) {
      return `runtime ${runtime.providerRef} does not support TeamMate delivery`;
    }
    try {
      const result = await runtime.deliverTeamMateCompletion(envelope);
      if (result.status === 'accepted') return null;
      return result.status === 'failed' ? result.error.message : result.reason;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
