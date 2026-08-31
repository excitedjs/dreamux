import { ValidationError, throwCallerMistake } from '../../command/errors.js';
import {
  mustNonEmptyString,
  optionalNonBlankString,
  type CommandPayload,
} from '../../command/payload.js';
import { parseWorkflowMaxConcurrency } from './limits.js';

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

/**
 * Read one run request, as every surface asks it.
 *
 * `max_concurrency` is bounded by the service that enforces it and says so in
 * its own words; only the type becomes the caller's, so the sentence cannot
 * drift from the bound.
 */
export function workflowRunInput(params: CommandPayload): WorkflowRunInput {
  const rawMaxConcurrency = params['max_concurrency'];
  let maxConcurrency: number;
  try {
    maxConcurrency = parseWorkflowMaxConcurrency(rawMaxConcurrency);
  } catch (error) {
    throwCallerMistake(error);
  }
  const script = optionalNonBlankString(params, 'script');
  const scriptPath = optionalNonBlankString(params, 'scriptPath');
  if (script === null && scriptPath === null) {
    throw new ValidationError('a workflow run requires either script or scriptPath');
  }
  return {
    ...(script !== null ? { script } : {}),
    ...(scriptPath !== null ? { scriptPath } : {}),
    ...(Object.hasOwn(params, 'args') ? { args: params['args'] } : {}),
    ...(rawMaxConcurrency !== undefined && rawMaxConcurrency !== null
      ? { max_concurrency: maxConcurrency }
      : {}),
  };
}

/** Read the run id every per-run operation addresses. */
export function workflowRunIdParam(params: CommandPayload): string {
  return mustNonEmptyString(params, 'run_id');
}

/**
 * Project one workflow run record.
 *
 * Field by field rather than spread, beside the record it copies: the advertised
 * output schema is closed, so an additive internal field would otherwise fail
 * output validation instead of being quietly ignored.
 */
export function workflowRunResult(record: WorkflowRunRecord): WorkflowRunRecord {
  return {
    version: record.version,
    run_id: record.run_id,
    dispatcher_id: record.dispatcher_id,
    team_id: record.team_id,
    caller_kind: record.caller_kind,
    script_hash: record.script_hash,
    status: record.status,
    max_concurrency: record.max_concurrency,
    phase: record.phase,
    last_log: record.last_log,
    agents: record.agents.map(workflowAgentResult),
    result: record.result ?? null,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ended_at: record.ended_at,
  };
}

function workflowAgentResult(agent: WorkflowAgentRecord): WorkflowAgentRecord {
  return {
    index: agent.index,
    name: agent.name,
    label: agent.label,
    phase: agent.phase,
    status: agent.status,
    result: agent.result ?? null,
    error: agent.error,
    created_at: agent.created_at,
    settled_at: agent.settled_at,
  };
}
