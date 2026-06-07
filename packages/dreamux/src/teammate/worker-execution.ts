/**
 * TeamMate worker execution orchestration (issue #126 PR2).
 *
 * This service is the sole bridge between a {@link TeamMateWorkerProvider} and
 * the server-owned ledger. It resolves a provider, starts a per-task session,
 * and maps the provider's lifecycle callbacks onto ledger transitions plus
 * wait-broker notifications:
 *
 *   onRunning   → ledger.markRunning              (accepted/queued → running)
 *   onCompleted → reportCompletion('completed')   (record result + deliver + notify)
 *   onFailed    → reportCompletion('failed')      (record result + deliver + notify)
 *   onCancelled → ledger.recordClose('cancelled') (live → cancelled close)
 *
 * The ledger stays the single source of truth: a provider never writes it, and a
 * provider-reported failure still lands a durable, pull-able `failed` result.
 * The completion path reuses the PR1 delivery service (`reportCompletion`), so
 * completion notification and delivery retry are unchanged.
 *
 * Production wires no worker for the MVP (an empty catalog), so `execute`
 * returns `provider_unavailable` exactly as PR1 did; only an injected catalog
 * (the fake worker in tests) actually runs a session.
 */

import {
  TeamMateTaskTransitionError,
  type TeamMateInputMode,
  type TeamMateLifecycleStatus,
  type TeamMateTaskLedger,
} from './ledger.js';
import type { TeamMateWorkerProviderCatalog } from './worker/catalog.js';
import type {
  TeamMateWorkerCallbacks,
  TeamMateWorkerInputDisposition,
  TeamMateWorkerSession,
} from './worker/types.js';

export const TEAMMATE_PROVIDER_UNAVAILABLE_CODE = 'TEAMMATE_PROVIDER_UNAVAILABLE';

const PROVIDER_UNAVAILABLE_DEFAULT_REASON =
  'TeamMate worker execution is not available';

/** Execution outcome the server maps onto the wire `execution` sub-result. */
export type TeamMateExecutionOutcome =
  | { status: 'running'; provider_ref: string }
  | { status: 'completed'; provider_ref: string }
  | { status: 'failed'; provider_ref: string }
  | { status: 'cancelled'; provider_ref: string }
  | {
      status: 'provider_unavailable';
      reason: string;
      code: string;
      retryable: boolean;
    };

export interface TeamMateWorkerCompletionReport {
  dispatcherId: string;
  taskId: string;
  outcome: 'completed' | 'failed';
  finalText: string;
}

export interface TeamMateWorkerExecutionDeps {
  ledger: (dispatcherId: string) => TeamMateTaskLedger;
  /** Resolve the active worker catalog (empty in production for the MVP). */
  workers: () => TeamMateWorkerProviderCatalog;
  /**
   * Record a worker-reported completion/failure. Wired to the PR1 delivery
   * service so completion is persisted before delivery and waiters wake at once.
   */
  reportCompletion: (report: TeamMateWorkerCompletionReport) => Promise<unknown>;
  /** Wake the wait broker after a ledger transition the service owns. */
  notifyEvent?: (dispatcherId: string, taskId: string) => void;
  log?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

export interface ExecuteTeamMateTaskInput {
  dispatcherId: string;
  taskId: string;
  /** Explicit provider ref override; falls back to the task's pinned ref. */
  providerRef?: string;
}

export interface SendTeamMateWorkerInputInput {
  dispatcherId: string;
  taskId: string;
  inputId: string;
  text: string;
  mode: TeamMateInputMode;
}

export interface SendTeamMateWorkerInputResult {
  /** Whether a live worker session received the input. */
  delivered: boolean;
  disposition?: TeamMateWorkerInputDisposition;
}

export class TeamMateWorkerExecutionService {
  private readonly sessions = new Map<string, TeamMateWorkerSession>();

  constructor(private readonly deps: TeamMateWorkerExecutionDeps) {}

  hasLiveSession(dispatcherId: string, taskId: string): boolean {
    return this.sessions.has(key(dispatcherId, taskId));
  }

  /**
   * Start (or no-op retry) worker execution for an accepted task. Returns the
   * execution outcome; the lifecycle transition itself flows through the
   * provider's `onRunning` callback. A missing/unavailable provider leaves the
   * task `accepted` (retryable). A terminal task is never re-executed.
   */
  async execute(
    input: ExecuteTeamMateTaskInput,
  ): Promise<TeamMateExecutionOutcome> {
    const ledger = this.deps.ledger(input.dispatcherId);
    const task = await ledger.getTask(input.taskId);
    if (task === null) {
      throw new Error(
        `TeamMate task ${JSON.stringify(input.taskId)} does not exist`,
      );
    }

    const sessionKey = key(input.dispatcherId, input.taskId);
    // Idempotent: a live session means the worker is already running; never
    // start a second one for the same task.
    const live = this.sessions.get(sessionKey);
    if (live !== undefined) {
      return { status: 'running', provider_ref: live.handle.providerRef };
    }

    if (isTerminalLifecycle(task.lifecycle_status)) {
      // A finished task is not re-executed; surface its terminal status.
      return {
        status: task.lifecycle_status,
        provider_ref: task.provider_ref ?? '',
      };
    }

    if (task.lifecycle_status === 'running') {
      // Running with no live session in THIS process means a prior run is still
      // owned elsewhere or predates a restart. Do not start a second worker for
      // the same task; surface it as running. Resume / orphan reconciliation of
      // such a task is deferred (issue #126).
      return { status: 'running', provider_ref: task.provider_ref ?? '' };
    }

    const provider = this.deps
      .workers()
      .resolve(input.providerRef ?? task.provider_ref);
    if (provider === null) {
      return providerUnavailable(PROVIDER_UNAVAILABLE_DEFAULT_REASON);
    }
    const caps = provider.capabilities();
    if (!caps.worker_available) {
      return providerUnavailable(
        caps.unsupported_reason || PROVIDER_UNAVAILABLE_DEFAULT_REASON,
      );
    }

    const callbacks = this.buildCallbacks(input.dispatcherId, input.taskId);
    const outcome = await provider.startSession(
      {
        dispatcherId: input.dispatcherId,
        taskId: input.taskId,
        teammateId: task.teammate_id,
        title: task.title,
        prompt: task.prompt,
        target: task.target,
        targetMode: task.target_mode,
      },
      callbacks,
    );
    if (outcome.status === 'unavailable') {
      // The task stays accepted/queued so execute_task can retry later.
      return {
        status: 'provider_unavailable',
        reason: outcome.reason,
        code: outcome.code,
        retryable: outcome.retryable,
      };
    }
    this.deps.log?.('info', 'teammate worker session started', {
      dispatcher_id: input.dispatcherId,
      task_id: input.taskId,
      provider_ref: provider.ref,
    });
    // A provider that completes/fails/cancels synchronously inside startSession
    // already drove the terminal callback; re-read the ledger and only retain a
    // session that is still live, so the idempotent live-session check stays
    // accurate and we never store a torn-down session.
    const after = await ledger.getTask(input.taskId);
    const lifecycle = after?.lifecycle_status ?? 'running';
    if (after !== null && isTerminalLifecycle(lifecycle)) {
      return { status: lifecycle, provider_ref: provider.ref };
    }
    this.sessions.set(sessionKey, outcome.session);
    return { status: 'running', provider_ref: provider.ref };
  }

  /**
   * Route a follow-up input to a live worker session, if any. The caller records
   * the input in the ledger first (durable, `queued`); on an accepted
   * disposition it transitions the input to `submitted`. With no live session
   * the input simply stays `queued` for a future worker — PR1 behaviour.
   */
  async sendInput(
    input: SendTeamMateWorkerInputInput,
  ): Promise<SendTeamMateWorkerInputResult> {
    const session = this.sessions.get(key(input.dispatcherId, input.taskId));
    if (session === undefined) return { delivered: false };
    const disposition = await session.sendInput({
      inputId: input.inputId,
      text: input.text,
      mode: input.mode,
    });
    return { delivered: true, disposition };
  }

  private buildCallbacks(
    dispatcherId: string,
    taskId: string,
  ): TeamMateWorkerCallbacks {
    const ledger = this.deps.ledger(dispatcherId);
    const sessionKey = key(dispatcherId, taskId);
    return {
      onRunning: async () => {
        const task = await ledger.getTask(taskId);
        if (task === null) return;
        if (
          task.lifecycle_status !== 'accepted' &&
          task.lifecycle_status !== 'queued'
        ) {
          return; // already running/terminal — running is idempotent.
        }
        try {
          await ledger.markRunning(taskId);
        } catch (err) {
          if (!(err instanceof TeamMateTaskTransitionError)) throw err;
          return;
        }
        this.deps.notifyEvent?.(dispatcherId, taskId);
      },
      onCompleted: async (finalText) => {
        this.sessions.delete(sessionKey);
        await this.deps.reportCompletion({
          dispatcherId,
          taskId,
          outcome: 'completed',
          finalText,
        });
      },
      onFailed: async (errorText) => {
        this.sessions.delete(sessionKey);
        await this.deps.reportCompletion({
          dispatcherId,
          taskId,
          outcome: 'failed',
          finalText: errorText,
        });
      },
      onCancelled: async (reason) => {
        this.sessions.delete(sessionKey);
        try {
          await ledger.recordClose(taskId, {
            status: 'cancelled',
            ...(reason !== null && reason !== '' ? { note: reason } : {}),
          });
        } catch (err) {
          if (!(err instanceof TeamMateTaskTransitionError)) throw err;
          return;
        }
        this.deps.notifyEvent?.(dispatcherId, taskId);
      },
    };
  }
}

function providerUnavailable(reason: string): TeamMateExecutionOutcome {
  return {
    status: 'provider_unavailable',
    reason,
    code: TEAMMATE_PROVIDER_UNAVAILABLE_CODE,
    retryable: true,
  };
}

function isTerminalLifecycle(
  status: TeamMateLifecycleStatus,
): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function key(dispatcherId: string, taskId: string): string {
  return `${dispatcherId}\u0000${taskId}`;
}
