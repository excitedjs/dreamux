import {
  legacyTaskStatus,
  type TeamMateLifecycleStatus,
  type TeamMateTaskRecord,
} from '../teammate/ledger.js';
import type { TeamMateExecutionOutcome } from '../teammate/worker-execution.js';
import type { TeamMateWorkerProvider } from '../teammate/worker/types.js';
import {
  isWaitToken,
  lastEventId,
  TEAMMATE_WAIT_DEFAULT_UNTIL,
  type TeamMateWaitToken,
} from '../teammate/wait-broker.js';
import type {
  ServerTeamMateExecutionResult,
  ServerTeamMateProviderCapability,
  ServerTeamMatePullResult,
  ServerTeamMateTaskSummary,
  TeamMateWorkerAvailability,
} from './teammate-types.js';

export function isTerminalLifecycle(
  status: TeamMateLifecycleStatus,
): status is 'completed' | 'failed' | 'cancelled' {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

export function toTeamMateTaskSummary(
  task: TeamMateTaskRecord,
): ServerTeamMateTaskSummary {
  return {
    task_id: task.task_id,
    status: legacyTaskStatus(task),
    lifecycle_status: task.lifecycle_status,
    delivery_status: task.delivery_status,
    title: task.title,
    teammate_id: task.teammate_id,
    provider_ref: task.provider_ref,
    created_at: task.created_at,
    updated_at: task.updated_at,
    last_event_id: lastEventId(task),
    delivery_attempts: task.delivery?.attempts ?? 0,
    has_result: task.result !== null,
  };
}

export function toTeamMatePullResult(
  task: TeamMateTaskRecord,
): ServerTeamMatePullResult {
  if (task.result === null) {
    throw new Error(
      `TeamMate task ${JSON.stringify(task.task_id)} has no retained result`,
    );
  }
  return {
    task_id: task.task_id,
    status: legacyTaskStatus(task),
    lifecycle_status: task.lifecycle_status,
    delivery_status: task.delivery_status,
    outcome: task.result.outcome,
    text: task.result.text,
    delivered: task.delivery_status === 'delivered',
    delivery_attempts: task.delivery?.attempts ?? 0,
  };
}

/** Map the execution service outcome onto the public `execution` sub-result. */
export function toExecutionResult(
  outcome: TeamMateExecutionOutcome,
): ServerTeamMateExecutionResult {
  if (outcome.status === 'provider_unavailable') {
    return {
      status: 'provider_unavailable',
      reason: outcome.reason,
      code: outcome.code,
      retryable: outcome.retryable,
    };
  }
  return {
    status: outcome.status,
    ...(outcome.provider_ref !== '' ? { provider_ref: outcome.provider_ref } : {}),
  };
}

/**
 * Build a provider capability row for `get_capabilities`. When the catalog has
 * a worker for the ref, its static capabilities are reported, downgraded to
 * unavailable when the binary probe could not resolve the worker's binary.
 */
export function toProviderCapability(
  ref: string,
  worker: TeamMateWorkerProvider | undefined,
  availability: TeamMateWorkerAvailability | null,
): ServerTeamMateProviderCapability {
  if (worker === undefined) {
    return {
      provider_ref: ref,
      worker_available: false,
      unsupported_reason:
        'TeamMate worker execution is not implemented yet (issue #126)',
      modes: { steer: false, queue: false, interrupt: false },
      resume: false,
      logs: false,
    };
  }
  const caps = worker.capabilities();
  const binaryUnavailable = availability !== null && !availability.available;
  const workerAvailable = caps.worker_available && !binaryUnavailable;
  return {
    provider_ref: ref,
    worker_available: workerAvailable,
    unsupported_reason: binaryUnavailable
      ? availability.reason
      : caps.unsupported_reason,
    modes: { ...caps.modes },
    resume: caps.resume,
    logs: caps.logs,
  };
}

/** Validate and default the `await_completion.until` token set. */
export function parseWaitUntil(until: string[] | undefined): Set<TeamMateWaitToken> {
  if (until === undefined) return new Set(TEAMMATE_WAIT_DEFAULT_UNTIL);
  if (!Array.isArray(until) || until.length === 0) {
    throw new Error('until must be a non-empty array of states');
  }
  const tokens = new Set<TeamMateWaitToken>();
  for (const token of until) {
    if (!isWaitToken(token)) {
      throw new Error(`unsupported await_completion state: ${String(token)}`);
    }
    tokens.add(token);
  }
  return tokens;
}
