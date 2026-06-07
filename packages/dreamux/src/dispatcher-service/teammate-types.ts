import type {
  TeamMateDeliveryStatus,
  TeamMateInputMode,
  TeamMateLifecycleStatus,
  TeamMateScheduleCallerKind,
  TeamMateTargetMode,
} from '../teammate/ledger.js';
import type {
  TeamMateWorkerLogStream,
  TeamMateWorkerLogStreamKind,
} from '../teammate/worker-logs.js';

export interface ServerMcpScheduleTeamMateInput {
  dispatcherId: string;
  callerKind: TeamMateScheduleCallerKind;
  title: string;
  prompt: string;
  teammateId?: string;
}

export interface ServerMcpScheduleTeamMateResult {
  status: 'accepted';
  task_id: string;
  dispatcher_id: string;
  created_at: number;
  teammate_id?: string;
}

export interface ServerTeamMateCompletionInput {
  dispatcherId: string;
  taskId: string;
  outcome: 'completed' | 'failed';
  finalText: string;
}

export interface ServerTeamMateTaskSummary {
  task_id: string;
  /** Back-compat projection of lifecycle + delivery into the v1 status enum. */
  status: string;
  lifecycle_status: TeamMateLifecycleStatus;
  delivery_status: TeamMateDeliveryStatus;
  title: string;
  teammate_id: string | null;
  provider_ref: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
  delivery_attempts: number;
  has_result: boolean;
}

export interface ServerTeamMatePullResult {
  task_id: string;
  status: string;
  lifecycle_status: TeamMateLifecycleStatus;
  delivery_status: TeamMateDeliveryStatus;
  outcome: 'completed' | 'failed';
  text: string;
  delivered: boolean;
  delivery_attempts: number;
}

export interface ServerMcpRunTeamMateTaskInput {
  dispatcherId: string;
  callerKind: TeamMateScheduleCallerKind;
  title: string;
  prompt: string;
  targetPath: string;
  teammateId?: string;
  intent?: string;
  targetMode?: TeamMateTargetMode;
  providerRef?: string;
  operationId?: string;
}

export interface ServerMcpExecuteTeamMateTaskInput {
  dispatcherId: string;
  taskId: string;
  providerRef?: string;
  targetMode?: TeamMateTargetMode;
  operationId?: string;
}

export interface ServerMcpSendTeamMateInputInput {
  dispatcherId: string;
  taskId: string;
  prompt: string;
  mode?: TeamMateInputMode;
  operationId?: string;
}

export interface ServerMcpAwaitTeamMateCompletionInput {
  dispatcherId: string;
  taskId: string;
  afterEventId?: number;
  until?: string[];
  timeoutMs?: number;
}

/**
 * Execution attempt outcome (issue #126). With no worker wired this reports
 * `provider_unavailable`; a wired worker reports the lifecycle status and
 * resolved provider ref.
 */
export interface ServerTeamMateExecutionResult {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'provider_unavailable';
  provider_ref?: string;
  reason?: string;
  code?: string;
  retryable?: boolean;
}

export interface ServerMcpRunTeamMateTaskResult {
  task: ServerTeamMateTaskSummary;
  execution: ServerTeamMateExecutionResult;
}

export interface ServerMcpSendTeamMateInputResult {
  input_id: string;
  mode: TeamMateInputMode;
  /**
   * `submitted` when a live worker session accepted the input, `queued`
   * otherwise. The input is durably recorded either way.
   */
  status: 'queued' | 'submitted';
  after_event_id: number;
  task: ServerTeamMateTaskSummary;
}

export interface ServerMcpAwaitTeamMateCompletionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'reached' | 'still_running';
  task_id: string;
  after_event_id: number;
  task: ServerTeamMateTaskSummary | null;
  result?: ServerTeamMatePullResult | null;
}

export interface ServerMcpCancelTeamMateTaskInput {
  dispatcherId: string;
  taskId: string;
  /** Optional close note recorded with the cancellation. */
  note?: string;
}

export interface ServerMcpCancelTeamMateTaskResult {
  task_id: string;
  /**
   * `cancelled` when this call closed a live/open task, `already_terminal` when
   * the task had already finished.
   */
  status: 'cancelled' | 'already_terminal';
  lifecycle_status: TeamMateLifecycleStatus;
  /** Whether a live worker session in this process was reaped by the cancel. */
  cancelled_live_session: boolean;
  after_event_id: number;
  task: ServerTeamMateTaskSummary;
}

export interface ServerMcpTeamMateTaskLogsInput {
  dispatcherId: string;
  taskId: string;
  maxBytes?: number;
  stream?: TeamMateWorkerLogStreamKind;
}

export interface ServerMcpTeamMateTaskLogsResult {
  task_id: string;
  provider_ref: string | null;
  lifecycle_status: TeamMateLifecycleStatus;
  /** Whether this task's worker has a known on-disk log layout. */
  logs_supported: boolean;
  streams: TeamMateWorkerLogStream[];
}

/** Worker capability advertisement for a built-in runtime. */
export interface ServerTeamMateProviderCapability {
  provider_ref: string;
  worker_available: boolean;
  unsupported_reason: string;
  modes: { steer: boolean; queue: boolean; interrupt: boolean };
  resume: boolean;
  logs: boolean;
}

export interface ServerTeamMateCapabilities {
  execution_available: boolean;
  wait: { default_ms: number; max_ms: number };
  target_modes: TeamMateTargetMode[];
  input_modes: TeamMateInputMode[];
  default_input_mode: TeamMateInputMode;
  providers: ServerTeamMateProviderCapability[];
}

/** Whether a worker's configured binary can be resolved in the service env. */
export interface TeamMateWorkerAvailability {
  available: boolean;
  /** Human-readable reason when `available` is false; empty otherwise. */
  reason: string;
}

/**
 * Probe whether the binary a worker provider would launch is resolvable in the
 * dispatcher service environment.
 */
export type WorkerBinaryProbe = (
  providerRef: string,
) => Promise<TeamMateWorkerAvailability>;
