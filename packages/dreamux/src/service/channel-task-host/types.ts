import type {
  AgentRuntimeDurableSubmissionDelivery,
  AgentRuntimeDurableSettlement,
  ChannelLogicalRepositoryBinding,
  ChannelTaskAttemptIdentity,
  ChannelTaskBlockedCode,
  ChannelTaskContainerIdentity,
  ChannelTaskContainerManifest,
  ChannelTaskContainerState,
  ChannelTaskHostEventPayload,
  ChannelTaskReceipt,
  ChannelTaskRepositoryResolution,
  ChannelTaskTerminalResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import type {
  CollaborationBindingSnapshot,
  ResolvedCollaborationRepositoryPolicy,
} from '../collaboration-space/types.js';
import type {
  TaskRuntimeEffect,
  TaskRuntimeRole,
} from '../task-runtime-submission.js';

export const TASK_TARGET_RECORD_VERSION = 1;

export type TaskTargetPhase =
  | 'received'
  | 'binding_resolved'
  | 'provisioning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'terminal'
  | 'finalizing'
  | 'finalized';

export type TaskRepositoryPolicy = ResolvedCollaborationRepositoryPolicy;
export type TaskCollaborationBindingSnapshot = CollaborationBindingSnapshot;

export const TASK_CONTAINER_MANIFEST_RECORD_VERSION = 1;

export interface TaskContainerManifestEntryRecord {
  container: ChannelTaskContainerIdentity;
  generation: number;
  state: ChannelTaskContainerState;
  logical_repository: ChannelLogicalRepositoryBinding | null;
  resolved_repository: TaskRepositoryPolicy | null;
  resolution: ChannelTaskRepositoryResolution;
  tombstoned_at: number | null;
}

export interface TaskContainerManifestRecord {
  version: typeof TASK_CONTAINER_MANIFEST_RECORD_VERSION;
  revision: number;
  digest: string;
  applied_at: number;
  entries: TaskContainerManifestEntryRecord[];
}

export interface TaskContainerManifestApplyCandidate {
  manifest: ChannelTaskContainerManifest;
  digest: string;
  entries: TaskContainerManifestEntryRecord[];
}

export type RuntimeSubmissionState =
  | 'intent'
  | 'accepted'
  | 'settled'
  | 'in_doubt';

export type RuntimeSubmissionKind = 'root' | 'completion' | 'spawn' | 'send';

export interface RuntimeSubmissionRecord {
  operation_id: string;
  input_digest: string;
  kind: RuntimeSubmissionKind;
  parent_operation_id: string | null;
  tool_call_id: string;
  tool_call_ordinal: number;
  runtime_id: string | null;
  runtime_role: TaskRuntimeRole;
  durability_namespace: string | null;
  delivery: AgentRuntimeDurableSubmissionDelivery;
  effect: TaskRuntimeEffect;
  turn_id: string | null;
  state: RuntimeSubmissionState;
  runtime_revision: number;
  settlement: AgentRuntimeDurableSettlement | null;
  settlement_acknowledged_revision: number;
  created_at: number;
  updated_at: number;
}

export interface RuntimeSubmissionDerivedView {
  active_operation_ids: string[];
  last_leader_operation_id: string | null;
  quiescent: boolean;
}

export interface TaskTargetRecord {
  version: typeof TASK_TARGET_RECORD_VERSION;
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  target_id: string;
  canonical_target_key: string;
  attempt: ChannelTaskAttemptIdentity;
  container: {
    container_type: string;
    container_key: string;
  };
  manifest_revision: number;
  container_generation: number;
  logical_repository: ChannelLogicalRepositoryBinding | null;
  resolved_repository: TaskRepositoryPolicy | null;
  repository_binding: Pick<
    TaskRepositoryPolicy,
    'source' | 'logical_key' | 'binding_revision' | 'fingerprint'
  >;
  request_fingerprint: string;
  receipt: ChannelTaskReceipt;
  title: string | null;
  turn: InboundTurnInput | null;
  phase: TaskTargetPhase;
  revision: number;
  binding: TaskCollaborationBindingSnapshot | null;
  team: {
    team_name: string;
    leader_name: string | null;
    worktree_slug: string;
    route_claim_id: string;
    route_reconciled_at: number | null;
  };
  submissions: RuntimeSubmissionRecord[];
  submission_view: RuntimeSubmissionDerivedView;
  terminal: ChannelTaskTerminalResult | null;
  terminal_revision: number;
  blocked: null | {
    from_phase: TaskTargetPhase;
    code: ChannelTaskBlockedCode;
    retryable: boolean;
    at: number;
  };
  finalizer: null | {
    step: 'pending' | 'route_released' | 'team_closed' | 'completed';
    attempts: number;
    last_error_code: string | null;
    cleanup_status?: 'deleted' | 'retained';
    cleanup_reason?: 'dirty' | 'unmerged' | 'unique_commits' | 'cleanup_error';
  };
  created_at: number;
  updated_at: number;
  /** Last stream sequence whose event reflects this aggregate revision. */
  last_host_sequence: number;
  tombstone: boolean;
}

export interface TaskTargetClaimInput {
  dispatcherId: string;
  channelId: string;
  provider: string;
  targetId: string;
  canonicalTargetKey: string;
  attempt: ChannelTaskAttemptIdentity;
  container: TaskTargetRecord['container'];
  manifestRevision: number;
  containerGeneration: number;
  logicalRepository: ChannelLogicalRepositoryBinding | null;
  resolvedRepository: TaskRepositoryPolicy;
  requestFingerprint: string;
  receipt: ChannelTaskReceipt;
  title: string | null;
  turn: InboundTurnInput;
  teamName: string;
  worktreeSlug: string;
  routeClaimId: string;
}

export interface TaskStoreEventInput {
  payload: ChannelTaskHostEventPayload;
  occurredAt?: number;
}

export class TaskTargetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskTargetConflictError';
  }
}

export class TaskTargetRevisionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`task target revision mismatch: expected ${expected}, found ${actual}`);
    this.name = 'TaskTargetRevisionError';
  }
}

export class TaskManifestFenceError extends Error {
  constructor(
    readonly code:
      | 'TASK_CONTAINER_MANIFEST_NOT_APPLIED'
      | 'TASK_CONTAINER_NOT_AUTHORIZED'
      | 'TASK_CONTAINER_GENERATION_MISMATCH'
      | 'TASK_DEFAULT_BINDING_DISABLED'
      | 'TASK_REPOSITORY_BINDING_MISSING'
      | 'TASK_REPOSITORY_BINDING_MISMATCH'
      | 'TASK_REPOSITORY_NOT_MANAGED',
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'TaskManifestFenceError';
  }
}

export class TaskManifestApplyError extends Error {
  constructor(
    readonly code: 'TASK_MANIFEST_STALE' | 'TASK_MANIFEST_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'TaskManifestApplyError';
  }
}
