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
  | 'durable_container_manifest_v1'
  | 'resource_lifecycle_v1'
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
  /** Non-empty UTF-8 identity, at most 512 bytes. */
  task_key: string;
  /** Non-empty UTF-8 identity, at most 512 bytes. */
  attempt_key: string;
}

/**
 * Stable remote collaboration container identity; no display/meta payload.
 * The type is at most 512 UTF-8 bytes and the key at most 2,048 bytes.
 */
export interface ChannelTaskContainerIdentity {
  container_type: string;
  container_key: string;
}

/** A remote logical name. It can never carry a host path. */
export interface ChannelLogicalRepositoryBinding {
  /** Non-empty logical identity, at most 512 UTF-8 bytes; never a path. */
  repository_key: string;
  /** Optional expected host-local policy revision, at most 512 UTF-8 bytes. */
  expected_revision?: string;
}

export type ChannelTaskContainerState = 'active' | 'draining' | 'revoked';

/** One entry in a complete provider-owned container authorization manifest. */
export interface ChannelTaskContainerManifestEntry {
  container: ChannelTaskContainerIdentity;
  /** Positive safe-integer incarnation fence for this container binding. */
  generation: number;
  state: ChannelTaskContainerState;
  /** Optional path-free repository identity resolved by trusted host policy. */
  repository?: ChannelLogicalRepositoryBinding;
  /** Safe-integer epoch milliseconds; required only for revoked entries. */
  tombstoned_at?: number;
}

/**
 * Complete container set for one channel. Entries are retained as explicit
 * revoked tombstones; omission is never interpreted as revocation. Revision is
 * a non-negative safe integer and the v1 Host accepts at most 100 entries.
 */
export interface ChannelTaskContainerManifest {
  revision: number;
  entries: readonly ChannelTaskContainerManifestEntry[];
}

export type ChannelTaskRepositoryResolution =
  | {
      status: 'ready';
      /** Host-local policy revision, never a path. */
      binding_revision: string;
      /** Lowercase SHA-256 proof of the frozen policy; reveals no host path. */
      fingerprint: string;
    }
  | {
      status: 'unavailable';
      code:
        | 'TASK_DEFAULT_BINDING_DISABLED'
        | 'TASK_REPOSITORY_BINDING_MISSING'
        | 'TASK_REPOSITORY_BINDING_MISMATCH'
        | 'TASK_REPOSITORY_NOT_MANAGED';
      retryable: boolean;
    }
  | { status: 'revoked' };

export interface ChannelTaskContainerResolution {
  container: ChannelTaskContainerIdentity;
  generation: number;
  resolution: ChannelTaskRepositoryResolution;
}

/** Durable, path-free Host projection of the applied complete manifest. */
export interface ChannelTaskContainerManifestState {
  manifest: ChannelTaskContainerManifest;
  digest: string;
  /** Safe-integer epoch milliseconds of the first durable apply. */
  applied_at: number;
  resolutions: readonly ChannelTaskContainerResolution[];
}

export interface ChannelTaskContainerManifestApplyInput {
  manifest: ChannelTaskContainerManifest;
}

export type ChannelTaskContainerManifestRejectCode =
  | 'TASK_MANIFEST_INVALID'
  | 'TASK_MANIFEST_STALE'
  | 'TASK_MANIFEST_CONFLICT';

export type ChannelTaskContainerManifestApplyResult =
  | {
      status: 'applied' | 'unchanged';
      state: ChannelTaskContainerManifestState;
      /** Highest durable Host sequence covered when this barrier resolved. */
      host_watermark: number;
    }
  | {
      status: 'rejected';
      code: ChannelTaskContainerManifestRejectCode;
      message: string;
      current_revision: number;
    };

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
  /** Must equal the complete manifest revision durably applied to this Host. */
  manifest_revision: number;
  /** Binding incarnation authorized by the remote task command. */
  container_generation: number;
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
  /** Original authorization fence under which Core accepted this target. */
  manifest_revision: number;
  container_generation: number;
}

export type ChannelTaskRejectCode =
  | 'TASK_HOST_NOT_NEGOTIATED'
  | 'TASK_HOST_CAPABILITY_UNAVAILABLE'
  | 'TASK_INPUT_INVALID'
  | 'TASK_DEFAULT_BINDING_DISABLED'
  | 'TASK_REPOSITORY_BINDING_MISSING'
  | 'TASK_REPOSITORY_BINDING_MISMATCH'
  | 'TASK_REPOSITORY_NOT_MANAGED'
  | 'TASK_CONTAINER_MANIFEST_NOT_APPLIED'
  | 'TASK_CONTAINER_NOT_AUTHORIZED'
  | 'TASK_CONTAINER_GENERATION_MISMATCH'
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
  /** Current applied manifest revision, even for an older accepted target. */
  manifest_revision: number;
  /** Original generation returned in that target's durable receipt. */
  container_generation: number;
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
        | 'TASK_INPUT_INVALID'
        | 'TASK_CONTAINER_MANIFEST_NOT_APPLIED'
        | 'TASK_CONTAINER_GENERATION_MISMATCH';
      message: string;
      retryable: boolean;
    };

export type ChannelTaskTerminalOutcome = 'completed' | 'failed' | 'cancelled';

export interface ChannelTaskTerminalResult {
  outcome: ChannelTaskTerminalOutcome;
  /** At most 64 KiB UTF-8; never a raw runtime or admin DTO. */
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

/**
 * Bounded provider-facing resource projection. Resource ids are opaque and
 * stable for one accepted target across Core restart. Parent ids form only the
 * Team/agent/turn/worktree hierarchy below that target. Every revision is the
 * positive task aggregate revision that produced the projection; summaries,
 * when present, are at most 4 KiB UTF-8.
 */
export type ChannelTaskResource =
  | {
      kind: 'team';
      resource_id: string;
      revision: number;
      state: 'provisioning' | 'ready' | 'closing' | 'closed';
    }
  | {
      kind: 'leader';
      resource_id: string;
      parent_resource_id: string;
      revision: number;
      state:
        | 'provisioning'
        | 'ready'
        | 'running'
        | 'completed'
        | 'failed'
        | 'stopped'
        | 'in_doubt'
        | 'closing'
        | 'closed';
      summary?: string;
    }
  | {
      kind: 'member';
      resource_id: string;
      parent_resource_id: string;
      revision: number;
      state:
        | 'provisioning'
        | 'ready'
        | 'running'
        | 'completed'
        | 'failed'
        | 'stopped'
        | 'in_doubt'
        | 'closing'
        | 'closed';
      summary?: string;
    }
  | {
      kind: 'turn';
      resource_id: string;
      parent_resource_id: string;
      revision: number;
      state: 'submitted' | 'running' | 'completed' | 'failed' | 'stopped' | 'in_doubt';
      summary?: string;
    }
  | {
      kind: 'worktree';
      resource_id: string;
      parent_resource_id: string;
      revision: number;
      state: 'provisional' | 'ready' | 'cleaning' | 'deleted' | 'retained';
      reason?: 'dirty' | 'unmerged' | 'unique_commits' | 'cleanup_error';
    };

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
  resources: ChannelTaskResource[];
  /** True when older resources were omitted from this bounded projection. */
  resources_truncated: boolean;
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
  /** Repeated on every page so a consumer can stage one atomic projection. */
  container_manifest: ChannelTaskContainerManifestState;
  /** Zero-based first item position in this immutable capture. */
  item_offset: number;
  /** Number of items on this page; always equals `items.length`. */
  item_count: number;
  /** Immutable total across every page with this snapshot id. */
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
      kind: 'container_manifest.applied';
      revision: number;
      digest: string;
      entry_count: number;
    }
  | {
      kind: 'resource.lifecycle';
      resource: ChannelTaskResource;
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
  /** Applied manifest for host events, or the target's original accept fence. */
  manifest_revision: number;
  /** Original target binding incarnation, or null for host-wide events. */
  container_generation: number | null;
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

/**
 * Core-created, session-scoped facts available before negotiation. This is an
 * immutable handle-creation snapshot; apply results and snapshots carry newer
 * manifest/status facts. Starting another session or detaching this one fences
 * the handle.
 */
export interface ChannelTaskHostScope {
  schema_versions: readonly [1];
  required_capabilities: readonly ChannelTaskHostCapability[];
  optional_capabilities: readonly ChannelTaskHostCapability[];
  host_stream_id: string;
  stream_generation: number;
  host_status: ChannelHostStatus;
  applied_manifest_revision: number;
  applied_manifest_digest: string;
  /** Opaque handle incarnation. Calls fail after this session is revoked. */
  session_fence: string;
}

export interface ChannelTaskHostNegotiationResult {
  schema_version: 1;
  capabilities: readonly ChannelTaskHostCapability[];
  required_capabilities: readonly ChannelTaskHostCapability[];
  host_stream_id: string;
  stream_generation: number;
  watermark: number;
  /** Core's durable consecutive prefix before this session resumes. */
  acknowledged_through: number;
  host_status: ChannelHostStatus;
  applied_manifest_revision: number;
  applied_manifest_digest: string;
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

/**
 * Revocable scoped Host handle. Calls waiting to cross a Core durable-write
 * boundary recheck the session fence; after revocation they reject instead of
 * committing provider-authorized state. A transaction that already crossed
 * that boundary remains authoritative and is recovered by the replacement
 * session even if its original call did not return.
 */
export interface ChannelTaskHost {
  /** Immutable facts for this scoped handle. */
  readonly scope: ChannelTaskHostScope;
  negotiate(
    input: ChannelTaskHostNegotiationInput,
  ): Promise<ChannelTaskHostNegotiationResult>;
  /**
   * Durably apply one complete container set. A successful result is returned
   * only after its checksummed WAL transaction is fsynced; commands fenced by
   * that revision may execute only after this barrier resolves.
   */
  applyContainerManifest(
    input: ChannelTaskContainerManifestApplyInput,
  ): Promise<ChannelTaskContainerManifestApplyResult>;
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
   * after verifying contiguous offsets, identical immutable facts, and exactly
   * `total_items`; it then persists the watermark and acknowledges that prefix.
   * An invalid/expired cursor requires discarding all staged pages and starting
   * again without a cursor.
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
