/**
 * Request readers and result projections shared by Command and MCP.
 *
 * `workflow.run`/`workflow.status`/`workflow.list` Commands and the TeamMate
 * MCP delegate's own workflow tools ask for the same run request and read the
 * same record shape, so both surfaces read them from here rather than each
 * keeping its own copy.
 *
 * These readers are shape only: the domain bound on `max_concurrency` is the
 * service's own rule, checked once by `WorkflowService.createRun`
 * (`index.ts`), not re-checked here.
 */
import {
  mustNonEmptyString,
  optionalInteger,
  optionalNonBlankString,
  type CommandPayload,
} from '../../command/payload.js';
import type {
  WorkflowAgentRecord,
  WorkflowRunInput,
  WorkflowRunRecord,
} from './types.js';

/** Read one run request, as every surface asks it. */
export function workflowRunInput(params: CommandPayload): WorkflowRunInput {
  const script = optionalNonBlankString(params, 'script');
  const scriptPath = optionalNonBlankString(params, 'scriptPath');
  const maxConcurrency = optionalInteger(params, 'max_concurrency');
  return {
    ...(script !== null ? { script } : {}),
    ...(scriptPath !== null ? { scriptPath } : {}),
    ...(Object.hasOwn(params, 'args') ? { args: params['args'] } : {}),
    ...(maxConcurrency !== null ? { max_concurrency: maxConcurrency } : {}),
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
export function workflowRunResult(
  record: WorkflowRunRecord,
): WorkflowRunRecord {
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
