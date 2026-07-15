/**
 * Provider-neutral Task Channel Host contracts.
 *
 * A task-capable channel is deliberately separate from conversational delivery.
 * The provider supplies stable remote task/attempt identity and a bounded task
 * body; Dreamux derives every Team, route, worktree, receipt, and event-stream
 * identity. Host events are execution telemetry, not channel replies.
 */
export type ChannelTaskHostCapability =
  | 'durable_task_submission_v1'
  | 'host_event_stream_v1'
  | 'logical_repository_binding_v1';

/** A provider opts in explicitly; conversational-only providers omit it. */
export interface ChannelTaskProviderCapability {
  protocol: 'task_channel_host_v1';
  /** Protocol schemas implemented by the provider adapter. */
  schema_versions: readonly number[];
  /** Host capabilities the provider can actually consume. */
  capabilities: readonly ChannelTaskHostCapability[];
}

export interface ChannelTaskAttemptIdentity {
  task_key: string;
  attempt_key: string;
}

/** Stable remote collaboration container identity; no display/meta payload. */
export interface ChannelTaskContainerIdentity {
  container_type: string;
  container_key: string;
}

/** A remote logical name. It can never carry a host path. */
export interface ChannelLogicalRepositoryBinding {
  repository_key: string;
  /** Optional expected revision of the host-local binding policy. */
  expected_revision?: string;
}

/** Remote attachment metadata accepted by strict task delivery; never a host path. */
export interface ChannelTaskAttachment {
  kind: string;
  name?: string;
}

/** Bounded, path-free task input accepted before Dreamux issues a durable receipt. */
export interface ChannelTaskTurnInput {
  text: string;
  sourceId: string;
  source?: string;
  attrs?: Array<[string, string]>;
  body?: string;
  attachments?: readonly ChannelTaskAttachment[];
}

export interface ChannelTaskSubmitInput {
  attempt: ChannelTaskAttemptIdentity;
  container: ChannelTaskContainerIdentity;
  /** Required only when the channel's default binding uses a local resolver. */
  repository?: ChannelLogicalRepositoryBinding;
  turn: ChannelTaskTurnInput;
  title?: string;
}

export interface ChannelTaskReceipt {
  receipt_id: string;
  target_id: string;
  attempt: ChannelTaskAttemptIdentity;
  revision: number;
  accepted_at: number;
}

export type ChannelTaskRejectCode =
  | 'TASK_HOST_NOT_NEGOTIATED'
  | 'TASK_HOST_CAPABILITY_UNAVAILABLE'
  | 'TASK_INPUT_INVALID'
  | 'TASK_DEFAULT_BINDING_DISABLED'
  | 'TASK_REPOSITORY_BINDING_MISSING'
  | 'TASK_REPOSITORY_BINDING_MISMATCH'
  | 'TASK_REPOSITORY_NOT_MANAGED'
  | 'TASK_ATTEMPT_CONFLICT'
  | 'TASK_HOST_BACKPRESSURE'
  | 'TASK_HOST_SHUTTING_DOWN';

export type ChannelTaskSubmitResult =
  | { status: 'accepted'; receipt: ChannelTaskReceipt }
  | {
      status: 'rejected';
      code: ChannelTaskRejectCode;
      message: string;
      retryable: boolean;
    };

export interface ChannelTaskCancelInput {
  attempt: ChannelTaskAttemptIdentity;
  container: ChannelTaskContainerIdentity;
  reason?: string;
}

export type ChannelTaskCancelResult =
  | { status: 'accepted'; receipt: ChannelTaskReceipt }
  | {
      status: 'already_terminal';
      receipt: ChannelTaskReceipt;
      terminal: ChannelTaskTerminalResult;
    }
  | { status: 'not_found' }
  | {
      status: 'rejected';
      code:
        | 'TASK_HOST_NOT_NEGOTIATED'
        | 'TASK_HOST_SHUTTING_DOWN'
        | 'TASK_INPUT_INVALID';
    };

export type ChannelTaskTerminalOutcome = 'completed' | 'failed' | 'cancelled';

export interface ChannelTaskTerminalResult {
  outcome: ChannelTaskTerminalOutcome;
  /** A bounded provider-facing result, never a raw runtime or admin DTO. */
  summary?: string;
}

export type ChannelTaskPhase =
  | 'received'
  | 'binding_resolved'
  | 'provisioning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'terminal'
  | 'finalizing'
  | 'finalized';

export interface ChannelTaskSnapshotItem {
  receipt: ChannelTaskReceipt;
  container: ChannelTaskContainerIdentity;
  phase: ChannelTaskPhase;
  revision: number;
  terminal: ChannelTaskTerminalResult | null;
  blocked: {
    code: ChannelTaskBlockedCode;
    retryable: boolean;
  } | null;
  team: {
    team_id: string;
    status: 'provisioning' | 'ready' | 'closing' | 'closed';
  };
  worktree: {
    status: 'provisional' | 'ready' | 'cleaning' | 'deleted' | 'retained';
    reason?: 'dirty' | 'unmerged' | 'unique_commits' | 'cleanup_error';
  };
  turns: Array<{
    turn_key: string;
    status: 'submitted' | 'running' | 'completed' | 'failed' | 'stopped' | 'in_doubt';
  }>;
  /** True when older settled turns were omitted from this bounded projection. */
  turns_truncated: boolean;
  updated_at: number;
  tombstone: boolean;
}

export type ChannelTaskBlockedCode =
  | 'TASK_PROVISIONING_FAILED'
  | 'TASK_SUBMISSION_IN_DOUBT'
  | 'TASK_FINALIZER_RETRY_REQUIRED';

export type ChannelHostStatusCode = 'TASK_FINALIZER_RETRY_REQUIRED';

/** Opaque cursor valid only for the scoped session and snapshot id that issued it. */
export type ChannelTaskSnapshotCursor = string;

export interface ChannelTaskSnapshotRequest {
  cursor?: ChannelTaskSnapshotCursor;
  limit?: number;
}

export interface ChannelTaskSnapshot {
  schema_version: 1;
  /** Stable for every page of one staged snapshot. */
  snapshot_id: string;
  session_fence: string;
  host_stream_id: string;
  stream_generation: number;
  watermark: number;
  acknowledged_through: number;
  host_status: ChannelHostStatus;
  item_offset: number;
  item_count: number;
  total_items: number;
  /** True only on the final page; apply the staged projection only then. */
  complete: boolean;
  items: ChannelTaskSnapshotItem[];
  next_cursor: string | null;
}

export type ChannelTaskSnapshotResult =
  | { status: 'page'; page: ChannelTaskSnapshot }
  | {
      status: 'restart_required';
      reason: 'cursor_invalid' | 'snapshot_expired' | 'stream_changed';
      host_stream_id: string;
      stream_generation: number;
      watermark: number;
    };

export type ChannelHostStatus =
  | 'recovering'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped';

export type ChannelTaskHostEventPayload =
  | {
      kind: 'host.lifecycle';
      status: ChannelHostStatus;
      code?: ChannelHostStatusCode;
    }
  | {
      kind: 'task.lifecycle';
      phase: ChannelTaskPhase;
      outcome?: ChannelTaskTerminalOutcome;
      summary?: string;
      blocked_code?: ChannelTaskBlockedCode;
      retryable?: boolean;
      /** The acknowledged finalized aggregate was reduced to durable identity. */
      tombstone?: true;
    }
  | {
      kind: 'team.lifecycle';
      status: 'provisioning' | 'ready' | 'closing' | 'closed';
      team_id: string;
    }
  | {
      kind: 'worktree.lifecycle';
      status: 'provisional' | 'ready' | 'cleaning' | 'deleted' | 'retained';
      reason?: 'dirty' | 'unmerged' | 'unique_commits' | 'cleanup_error';
    }
  | {
      kind: 'turn.lifecycle';
      /** Opaque Core-derived correlation key; not an AgentRuntime operation id. */
      turn_key: string;
      status: 'submitted' | 'running' | 'completed' | 'failed' | 'stopped' | 'in_doubt';
    }
  | {
      kind: 'cleanup.lifecycle';
      status: 'started' | 'completed';
    };

export interface ChannelTaskHostEvent {
  schema_version: 1;
  event_id: string;
  sequence: number;
  occurred_at: number;
  target_id: string | null;
  /** Target aggregate revision after this transition, or null for host events. */
  task_revision: number | null;
  attempt: ChannelTaskAttemptIdentity | null;
  container: ChannelTaskContainerIdentity | null;
  payload: ChannelTaskHostEventPayload;
}

export interface ChannelTaskHostEventBatch {
  schema_version: 1;
  host_stream_id: string;
  stream_generation: number;
  first_sequence: number | null;
  last_sequence: number | null;
  events: readonly ChannelTaskHostEvent[];
  has_more: boolean;
}

export interface ChannelTaskHostEventSinkResult {
  /** Highest fully processed consecutive sequence, never a sparse watermark. */
  acknowledged_through: number;
}

export interface ChannelTaskHostEventSink {
  acceptHostEvents(
    batch: ChannelTaskHostEventBatch,
  ): Promise<ChannelTaskHostEventSinkResult>;
}

export interface ChannelTaskHostNegotiationInput {
  supported_schema_versions: readonly number[];
  supported_capabilities: readonly ChannelTaskHostCapability[];
  resume?: ChannelTaskHostStreamCursor;
}

/** Core-created, session-scoped facts available before negotiation. */
export interface ChannelTaskHostScope {
  schema_versions: readonly [1];
  required_capabilities: readonly ChannelTaskHostCapability[];
  optional_capabilities: readonly ChannelTaskHostCapability[];
  host_stream_id: string;
  stream_generation: number;
  host_status: ChannelHostStatus;
  /** Opaque handle incarnation. Calls fail after this session is revoked. */
  session_fence: string;
}

export interface ChannelTaskHostNegotiationResult {
  schema_version: 1;
  capabilities: readonly ChannelTaskHostCapability[];
  host_stream_id: string;
  stream_generation: number;
  watermark: number;
  /** Core's durable consecutive prefix before this session resumes. */
  acknowledged_through: number;
  host_status: ChannelHostStatus;
  session_fence: string;
  resume: 'replay' | 'snapshot_required';
}

export interface ChannelTaskHostStreamCursor {
  host_stream_id: string;
  stream_generation: number;
  acknowledged_through: number;
}

export type ChannelTaskHostReplayResult =
  | { status: 'events'; batch: ChannelTaskHostEventBatch }
  | {
      status: 'snapshot_required';
      host_stream_id: string;
      stream_generation: number;
      watermark: number;
    };

export interface ChannelTaskHostReplayRequest {
  host_stream_id: string;
  stream_generation: number;
  after_sequence: number;
  limit?: number;
}

export interface ChannelTaskHostAcknowledgeInput {
  host_stream_id: string;
  stream_generation: number;
  /** Highest fully applied consecutive prefix offered to this session. */
  acknowledged_through: number;
}

export interface ChannelTaskHostAcknowledgeResult {
  acknowledged_through: number;
}

export interface ChannelTaskHost {
  /** Immutable facts for this scoped handle. */
  readonly scope: ChannelTaskHostScope;
  negotiate(
    input: ChannelTaskHostNegotiationInput,
  ): Promise<ChannelTaskHostNegotiationResult>;
  submit(input: ChannelTaskSubmitInput): Promise<ChannelTaskSubmitResult>;
  lookupSubmission(
    attempt: ChannelTaskAttemptIdentity,
    container: ChannelTaskContainerIdentity,
  ): Promise<ChannelTaskReceipt | null>;
  cancel(input: ChannelTaskCancelInput): Promise<ChannelTaskCancelResult>;
  /**
   * Start or continue one immutable staged snapshot. Every page for a cursor
   * has the same snapshot id, watermark, item count, and host facts. The
   * adapter atomically replaces its remote projection only after `complete`,
   * persists the watermark, then acknowledges that prefix. An invalid/expired
   * cursor requires starting again without a cursor.
   */
  snapshot(input?: ChannelTaskSnapshotRequest): Promise<ChannelTaskSnapshotResult>;
  replay(input: ChannelTaskHostReplayRequest): Promise<ChannelTaskHostReplayResult>;
  acknowledgeHostEvents(
    input: ChannelTaskHostAcknowledgeInput,
  ): Promise<ChannelTaskHostAcknowledgeResult>;
}

export interface ChannelRepositoryBindingResolveContext<TConfig = unknown> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
}

/** Trusted host-local resolver output. Core validates and fingerprints it. */
export interface ChannelResolvedRepositoryBinding {
  cwd: string;
  base_ref?: string;
  binding_revision: string;
}
