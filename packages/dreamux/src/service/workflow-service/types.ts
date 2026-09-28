import type {
  CreateLockedTeammateOptions,
  LockedTeammate,
} from '../agent/service-types.js';
import type { SpawnTeamMateRequest } from '../agent/types.js';

export type WorkflowCallerKind = 'dispatcher' | 'team_leader';

/** How a Workflow run materializes the locked TeamMate one of its agent
 * calls needs — implemented by whichever collection owns this scope
 * (`TeammateCollection` for a dispatcher scope, a Team's own workspace-loan
 * closure for a Team scope). */
export interface WorkflowTeammateFactory {
  createLocked(
    input: SpawnTeamMateRequest,
    options?: CreateLockedTeammateOptions,
  ): Promise<LockedTeammate>;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type WorkflowTerminalStatus = Exclude<WorkflowRunStatus, 'running'>;

export type WorkflowAgentStatus = 'queued' | WorkflowRunStatus;

export interface WorkflowAgentRecord {
  index: number;
  name: string | null;
  label: string | null;
  phase: string | null;
  status: WorkflowAgentStatus;
  result: unknown | null;
  error: string | null;
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
  script?: string;
  scriptPath?: string;
  args?: unknown;
  max_concurrency?: number | undefined;
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
