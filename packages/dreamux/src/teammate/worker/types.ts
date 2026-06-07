/**
 * TeamMate worker provider seam (issue #126 PR2).
 *
 * A worker provider runs ONE TeamMate task as a steerable, multi-input session
 * against a local target. This is deliberately a different abstraction from the
 * dispatcher's long-lived `AgentRuntimeProvider` (`src/agent-runtime/`): that one
 * models the dispatcher's own persistent runtime, whereas a worker session is
 * per-task and terminates when the task does.
 *
 * The provider never writes the ledger. It only emits lifecycle through the
 * {@link TeamMateWorkerCallbacks}; the execution service is the sole ledger
 * writer, so the server-owned ledger stays the single source of truth. The
 * contract carries no Codex-only assumptions — a Claude Code worker (still in
 * epic scope) implements the same seam.
 */

import type {
  TeamMateInputMode,
  TeamMateTargetMode,
  TeamMateTaskTarget,
} from '../ledger.js';

/** Per-task worker capabilities a provider advertises (read by get_capabilities). */
export interface TeamMateWorkerCapabilities {
  worker_available: boolean;
  /** Why execution is unavailable; empty when `worker_available` is true. */
  unsupported_reason: string;
  modes: { steer: boolean; queue: boolean; interrupt: boolean };
  resume: boolean;
  logs: boolean;
}

/**
 * Immutable context handed to a provider when a task starts. The target path is
 * local state already resolved/confined by the ledger; the provider receives it
 * but the server keeps it out of public artifacts.
 */
export interface TeamMateWorkerStartContext {
  dispatcherId: string;
  taskId: string;
  teammateId: string | null;
  title: string;
  prompt: string;
  target: TeamMateTaskTarget | null;
  targetMode: TeamMateTargetMode | null;
  // Team Mode reservation (issue #126): a future Team leader/Epic identity may be
  // threaded here additively. PR2 adds no Team fields and no Codex-only fields.
}

/** Opaque runtime handle a provider returns once a session is live. */
export interface TeamMateWorkerHandle {
  providerRef: string;
  sessionId: string | null;
  threadId: string | null;
}

/** Disposition of a follow-up input routed to a live worker session. */
export type TeamMateWorkerInputDisposition =
  | { status: 'accepted' }
  | { status: 'rejected'; reason: string };

/**
 * Service-side callbacks a provider drives to map worker lifecycle onto the
 * server-owned ledger. A provider MUST NOT touch the ledger directly; it only
 * emits these, and the execution service performs the ledger transition plus the
 * wait-broker notify.
 */
export interface TeamMateWorkerCallbacks {
  /** The worker has started turning; maps to `markRunning`. */
  onRunning(handle: TeamMateWorkerHandle): Promise<void>;
  /** The task finished successfully with a final result. */
  onCompleted(finalText: string): Promise<void>;
  /** The task failed; `errorText` is retained as the failure result. */
  onFailed(errorText: string): Promise<void>;
  /** The task was cancelled by the worker; maps to a `cancelled` close. */
  onCancelled(reason: string | null): Promise<void>;
}

/** A live, steerable worker session for one task. */
export interface TeamMateWorkerSession {
  readonly handle: TeamMateWorkerHandle;
  /** Deliver a follow-up input to the live session. */
  sendInput(input: {
    inputId: string;
    text: string;
    mode: TeamMateInputMode;
  }): Promise<TeamMateWorkerInputDisposition>;
  /** Request cancellation; the provider drives `onCancelled` when it lands. */
  cancel(reason: string | null): Promise<void>;
}

/** Outcome of attempting to start a worker session. */
export type TeamMateWorkerStartOutcome =
  | { status: 'started'; session: TeamMateWorkerSession }
  | {
      status: 'unavailable';
      reason: string;
      code: string;
      retryable: boolean;
    };

/** A pluggable TeamMate worker runtime. */
export interface TeamMateWorkerProvider {
  readonly ref: string;
  capabilities(): TeamMateWorkerCapabilities;
  startSession(
    context: TeamMateWorkerStartContext,
    callbacks: TeamMateWorkerCallbacks,
  ): Promise<TeamMateWorkerStartOutcome>;
}
