export type WorkflowCallerKind = 'dispatcher' | 'team_leader';

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type WorkflowTerminalStatus = Exclude<WorkflowRunStatus, 'running'>;

export type WorkflowAgentStatus = 'queued' | WorkflowRunStatus;

export interface WorkflowAgentRecord {
  index: number;
  name: string | null;
  label: string | null;
  phase: string | null;
  turn_id: string | null;
  status: WorkflowAgentStatus;
  created_at: number;
  settled_at: number | null;
}

/** Durable, versioned read model for one workflow run. */
export interface WorkflowRunRecord {
  version: 1;
  run_id: string;
  dispatcher_id: string;
  team_id: string | null;
  caller_kind: WorkflowCallerKind;
  script_hash: string;
  status: WorkflowRunStatus;
  max_concurrency: number;
  phase: string | null;
  last_log: string | null;
  agents: WorkflowAgentRecord[];
  result: unknown | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

export interface WorkflowRunInput {
  script: string;
  args?: unknown;
  max_concurrency?: number;
}

export interface WorkflowRunAccepted {
  run_id: string;
}

export interface WorkflowStatusInput {
  run_id: string;
}

export interface WorkflowStopInput {
  run_id: string;
}

export interface WorkflowStopResult {
  run_id: string;
  status: WorkflowRunStatus;
}

export interface WorkflowListResult {
  runs: WorkflowRunRecord[];
}
