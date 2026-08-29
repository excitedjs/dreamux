/**
 * The TeamMate MCP server, implemented by the collection that owns the roster.
 *
 * One delegate serves both callers, and they are two genuinely different
 * objects rather than one object told who is asking: a Dispatcher Agent's
 * delegate holds the {@link DispatcherService} itself, a TeamLeader's holds
 * that Team's {@link TeamLeaderHandle}. The handle is what carries the Team
 * lease into every mutation, so a leader-scoped call is serialized against a
 * concurrent dissolve without this file knowing that a lease exists.
 *
 * Workflow tools live here because they are advertised on this same server:
 * they are the same caller's work, reaching the same handle's `workflows`.
 */
import { ValidationError, errorMessage } from '../../command/errors.js';
import {
  historyQuery,
  mustNonEmptyString,
  normalizeSkillSources,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  repoRequest,
  repoWorktree,
  type CommandPayload,
} from '../../command/payload.js';
import {
  ACTIVITY_PUBLIC_ERRORS,
  mapAgentActivityCommandError,
} from '../agent-entity/activity-errors.js';
import { validateLastLimit } from '../agent-entity/read-helpers.js';
import type {
  AgentEntitySendResult,
  AgentEntitySpawnResult,
} from '../agent-entity/types.js';
import type { DispatcherService } from '../dispatcher-service/index.js';
import type { TeamLeaderHandle } from '../dispatcher-service/team-leader-handle.js';
import {
  TEAMMATE_DISPATCH_SUCCESS_REMINDER,
  WORKFLOW_RUN_SUCCESS_REMINDER,
} from '../mcp/dispatch-reminders.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import { parseWorkflowMaxConcurrency } from '../workflow-service/limits.js';
import type {
  WorkflowAgentRecord,
  WorkflowRunRecord,
} from '../workflow-service/types.js';
import { teammateToolDescriptors } from './mcp-tool-descriptors.js';
import type { TeamMateWorktreeRequest } from './types.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

const IDENTITY = { name: 'dreamux-teammate', version: '0.4.0' };

/**
 * What the two callers actually operate on.
 *
 * The dispatcher scope keeps the real `DispatcherService` because its `spawn`
 * drives the collection directly; the Team scope keeps the handle because a
 * Team TeamMate is spawned into the Team's shared workspace, through the leased
 * `spawnTeamMate`.
 */
export type TeamMateMcpScope =
  | { readonly kind: 'dispatcher'; readonly dispatcher: DispatcherService }
  | {
      readonly kind: 'team_leader';
      /**
       * Resolved per call, never captured. Each handle carries a fresh Team
       * leader lease, and a lease held across calls would let a superseded
       * generation keep operating on a Team it no longer leads.
       */
      readonly team: () => Promise<TeamLeaderHandle>;
    };

const ACTIVITY_CODES = ACTIVITY_PUBLIC_ERRORS.map((entry) => entry.code);

/**
 * Failures a TeamMate or Workflow tool may show the model.
 *
 * `BAD_REQUEST` is this delegate's own argument validation. `last` additionally
 * surfaces the Activity read failures, whose public messages describe a neutral
 * state and never a path, native history layout, or scan mode.
 */
const BASE_PUBLIC_CODES = ['BAD_REQUEST', 'TEAM_NOT_FOUND'] as const;
const LAST_PUBLIC_CODES = [...BASE_PUBLIC_CODES, ...ACTIVITY_CODES];

export function createTeamMateMcpDelegate(
  scope: TeamMateMcpScope,
): McpServerDelegate {
  const tools = teammateToolDescriptors(scope.kind);
  return {
    name: TEAMMATE_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { identity: IDENTITY, tools };
    },
    async call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(
        call.name === 'last' ? LAST_PUBLIC_CODES : [...BASE_PUBLIC_CODES],
        () => serve(scope, call),
      );
    },
  };
}

/**
 * The roster operations both scopes share, spelled once.
 *
 * `TeamLeaderHandle.teammates` is deliberately a structural match for the
 * dispatcher's `teammates` on exactly these verbs, so read and send paths need
 * no branch at all — only `spawn` differs, because only `spawn` differs.
 */
async function teammates(scope: TeamMateMcpScope) {
  return scope.kind === 'dispatcher'
    ? scope.dispatcher.teammates
    : (await scope.team()).teammates;
}

async function workflows(scope: TeamMateMcpScope) {
  return scope.kind === 'dispatcher'
    ? scope.dispatcher.workflows
    : (await scope.team()).workflows;
}

async function serve(
  scope: TeamMateMcpScope,
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const args = call.arguments as CommandPayload;
  switch (call.name) {
    case 'spawn':
      return spawn(scope, args);
    case 'send':
      return send(scope, args);
    case 'close':
      return close(scope, args);
    case 'history':
      return history(scope, args);
    case 'list':
      return list(scope);
    case 'status':
      return status(scope, args);
    case 'last':
      return last(scope, args);
    case 'get_capabilities':
      return capabilities(scope);
    case 'workflow_run':
      return workflowRun(scope, args);
    case 'workflow_status':
      return workflowStatus(scope, args);
    case 'workflow_stop':
      return workflowStop(scope, args);
    case 'workflow_list':
      return workflowList(scope);
    default:
      // Unreachable: Core admits a call only against this delegate's own frozen
      // catalog, so a name that is not one of the above never arrives here.
      throw new Error(`unknown TeamMate tool '${call.name}'`);
  }
}

async function spawn(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const name = mustNonEmptyString(args, 'name_prefix');
  const prompt = mustNonEmptyString(args, 'prompt');
  const intent = mustNonEmptyString(args, 'intent');
  const agentRuntime = optionalNonBlankString(args, 'agent_runtime');
  const identity = optionalNonBlankString(args, 'identity');
  const skillSources = await normalizeSkillSources(null);
  let result: AgentEntitySpawnResult;
  if (scope.kind === 'team_leader') {
    // A Team TeamMate always inherits the Team's shared workspace, which is why
    // the leader catalog does not advertise `repo` at all.
    result = await (await scope.team()).spawnTeamMate({
      name,
      prompt,
      intent,
      ...(agentRuntime !== null ? { agentRuntime } : {}),
      ...(identity !== null ? { identity } : {}),
      ...(skillSources !== null ? { skillSources } : {}),
    });
  } else {
    const repo = repoWorktree(repoRequest(args, 'repo'));
    const cwd =
      repo === null ? null : repo.cwd ?? (await scope.dispatcher.workspace());
    const worktree: TeamMateWorktreeRequest | null = repo?.worktree ?? null;
    result = await scope.dispatcher.teammates.spawn({
      name,
      prompt,
      intent,
      ...(cwd !== null ? { cwd } : {}),
      ...(agentRuntime !== null ? { agentRuntime } : {}),
      ...(identity !== null ? { identity } : {}),
      ...(skillSources !== null ? { skillSources } : {}),
      ...(worktree !== null ? { worktree } : {}),
    });
  }
  return submissionReceipt(result);
}

async function send(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const intent = optionalNonBlankString(args, 'intent');
  const result = await (await teammates(scope)).send({
    name: mustNonEmptyString(args, 'name'),
    prompt: mustNonEmptyString(args, 'prompt'),
    ...(intent !== null ? { intent } : {}),
  });
  return submissionReceipt(result);
}

function submissionReceipt(
  result: AgentEntitySpawnResult | AgentEntitySendResult,
): McpToolSuccess {
  const structured = {
    teammate: result.teammate,
    status: result.status,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
  return {
    structured,
    ...(result.status === 'submitted'
      ? { text: TEAMMATE_DISPATCH_SUCCESS_REMINDER }
      : {}),
  };
}

async function close(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await (await teammates(scope)).close({
    name: mustNonEmptyString(args, 'name'),
    note: mustNonEmptyString(args, 'note'),
  });
  return { structured: { teammate: result.teammate } };
}

async function history(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await (await teammates(scope)).history(historyQuery(args));
  return {
    structured: {
      items: result.items,
      next_cursor: result.next_cursor ?? null,
    },
  };
}

async function list(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  return { structured: { teammates: await (await teammates(scope)).list() } };
}

async function status(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const teammate = await (await teammates(scope)).status(
    mustNonEmptyString(args, 'name'),
  );
  return { structured: { teammate } };
}

async function last(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const limit = optionalInteger(args, 'limit');
  try {
    validateLastLimit(limit ?? undefined);
  } catch {
    throw new ValidationError('last limit must be an integer in 1..200');
  }
  const cursor = optionalString(args, 'cursor');
  const includeTools = optionalBooleanField(args, 'include_tools')['include_tools'];
  try {
    const result = await (await teammates(scope)).last(mustNonEmptyString(args, 'name'), {
      ...(limit !== null ? { limit } : {}),
      ...(cursor !== null ? { cursor } : {}),
      ...(includeTools !== undefined ? { includeTools } : {}),
    });
    return {
      structured: {
        teammate: result.teammate,
        requested_records: result.requested_records,
        returned_records: result.returned_records,
        records: result.records,
        next_cursor: result.next_cursor ?? null,
        truncated: result.truncated,
      },
    };
  } catch (error) {
    // The reader's internal reason vocabulary never leaves this call; what comes
    // back is either one of the allowlisted public Activity codes or INTERNAL.
    return mapAgentActivityCommandError(error);
  }
}

async function capabilities(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  const result = await (await teammates(scope)).getCapabilities();
  return {
    structured: {
      verbs: result.verbs,
      agent_runtimes: result.agent_runtimes,
    },
  };
}

async function workflowRun(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const script = optionalNonBlankString(args, 'script');
  const scriptPath = optionalNonBlankString(args, 'scriptPath');
  if (script === null && scriptPath === null) {
    throw new ValidationError('workflow_run requires either script or scriptPath');
  }
  const rawMaxConcurrency = args['max_concurrency'];
  let maxConcurrency: number;
  try {
    maxConcurrency = parseWorkflowMaxConcurrency(rawMaxConcurrency);
  } catch (error) {
    throw new ValidationError(errorMessage(error));
  }
  const accepted = await (await workflows(scope)).run({
    ...(script !== null ? { script } : {}),
    ...(scriptPath !== null ? { scriptPath } : {}),
    ...(Object.hasOwn(args, 'args') ? { args: args['args'] } : {}),
    ...(rawMaxConcurrency !== undefined && rawMaxConcurrency !== null
      ? { max_concurrency: maxConcurrency }
      : {}),
  });
  return {
    structured: { run_id: accepted.run_id },
    text: WORKFLOW_RUN_SUCCESS_REMINDER,
  };
}

async function workflowStatus(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const record = await (await workflows(scope)).status({
    run_id: mustNonEmptyString(args, 'run_id'),
  });
  return { structured: workflowRecord(record) };
}

async function workflowStop(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await (await workflows(scope)).stop({
    run_id: mustNonEmptyString(args, 'run_id'),
  });
  return { structured: { run_id: result.run_id, status: result.status } };
}

async function workflowList(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  const result = await (await workflows(scope)).list();
  return { structured: { runs: result.runs.map(workflowRecord) } };
}

/**
 * Project one workflow run record.
 *
 * Field-by-field rather than spread: the advertised output schema is closed, so
 * an additive internal field would otherwise fail output validation instead of
 * being quietly ignored.
 */
function workflowRecord(record: WorkflowRunRecord): Record<string, unknown> {
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
    agents: record.agents.map(workflowAgent),
    result: record.result ?? null,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
    ended_at: record.ended_at,
  };
}

function workflowAgent(agent: WorkflowAgentRecord): Record<string, unknown> {
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
