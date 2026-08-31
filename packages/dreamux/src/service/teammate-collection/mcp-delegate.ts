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
 *
 * The input codecs and the two record projections belong to the owning domains
 * and live with the types and records they read; what stays here is this
 * surface's: the two scopes, the advertised catalog, and the model-facing text a
 * tool chooses to say.
 *
 * Failures are thrown, not classified: each domain's failures state their own
 * reason and next step, and the admission boundary every delegate is reached
 * through renders them.
 */
import {
  mustNonBlankString,
  mustNonEmptyString,
  optionalNonBlankString,
  type CommandPayload,
} from '../../command/payload.js';
import { historyQuery } from '../agent-entity/history-query.js';
import {
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import { mapAgentActivityCommandError } from '../agent-entity/activity-errors.js';
import type { AgentEntitySpawnResult } from '../agent-entity/types.js';
import type { DispatcherService } from '../dispatcher-service/index.js';
import type { TeamLeaderHandle } from '../dispatcher-service/team-leader-handle.js';
import {
  TEAMMATE_DISPATCH_SUCCESS_REMINDER,
  WORKFLOW_RUN_SUCCESS_REMINDER,
} from '../mcp/dispatch-reminders.js';
import { MCP_IDENTITY_VERSION } from '../mcp/identity-version.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import {
  workflowRunIdParam,
  workflowRunInput,
  workflowRunResult,
} from '../workflow-service/types.js';
import { teammateToolDescriptors } from './mcp-tool-descriptors.js';
import {
  agentEntityLastQuery,
  agentEntityNameParam,
} from '../agent-entity/read-helpers.js';
import type { TeamMateWorktreeRequest } from './types.js';

export const TEAMMATE_MCP_SERVER_NAME = 'teammate';

const IDENTITY = { name: 'dreamux-teammate', version: MCP_IDENTITY_VERSION };

/**
 * What the two callers actually operate on.
 *
 * The dispatcher scope keeps the real `DispatcherService` because its `spawn`
 * drives the collection directly; the Team scope keeps the handle because a
 * Team TeamMate is spawned into the Team's shared workspace, through the
 * handle's own `spawnTeamMate`.
 */
export type TeamMateMcpScope =
  | { readonly kind: 'dispatcher'; readonly dispatcher: DispatcherService }
  | {
      readonly kind: 'team_leader';
      /**
       * Resolved per call, never captured. A handle held across calls would
       * keep answering for a Team object that has since closed, instead of
       * reaching whichever Team currently holds that id.
       */
      readonly team: () => Promise<TeamLeaderHandle>;
    };

export function createTeamMateMcpDelegate(
  scope: TeamMateMcpScope,
): McpServerDelegate {
  const tools = teammateToolDescriptors(scope.kind);
  return {
    name: TEAMMATE_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { identity: IDENTITY, tools };
    },
    call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(() => serve(scope, call));
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
  const name = mustNonBlankString(args, 'name_prefix');
  const prompt = mustNonEmptyString(args, 'prompt');
  const intent = mustNonBlankString(args, 'intent');
  const agentRuntime = optionalNonBlankString(args, 'agent_runtime');
  const identity = optionalNonBlankString(args, 'identity');
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
    name: agentEntityNameParam(args, 'name'),
    prompt: mustNonEmptyString(args, 'prompt'),
    ...(intent !== null ? { intent } : {}),
  });
  return submissionReceipt(result);
}

function submissionReceipt(result: AgentEntitySpawnResult): McpToolSuccess {
  return {
    structured: result,
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
    name: agentEntityNameParam(args, 'name'),
    note: mustNonBlankString(args, 'note'),
  });
  return { structured: result };
}

async function history(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: await (await teammates(scope)).history(historyQuery(args)),
  };
}

async function list(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  return { structured: { teammates: await (await teammates(scope)).list() } };
}

async function status(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: {
      teammate: await (await teammates(scope)).status(
        agentEntityNameParam(args, 'name'),
      ),
    },
  };
}

async function last(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const name = agentEntityNameParam(args, 'name');
  const query = agentEntityLastQuery(args);
  try {
    return { structured: await (await teammates(scope)).last(name, query) };
  } catch (error) {
    // The reader's internal reason vocabulary never leaves this call: a
    // recognized reason becomes the Activity failure that states its own next
    // step, and anything else passes through with the type and message it
    // already had.
    return mapAgentActivityCommandError(error);
  }
}

async function capabilities(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  return { structured: await (await teammates(scope)).getCapabilities() };
}

async function workflowRun(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const accepted = await (await workflows(scope)).run(workflowRunInput(args));
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
    run_id: workflowRunIdParam(args),
  });
  return { structured: workflowRunResult(record) };
}

async function workflowStop(
  scope: TeamMateMcpScope,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const result = await (await workflows(scope)).stop({
    run_id: workflowRunIdParam(args),
  });
  return { structured: { run_id: result.run_id, status: result.status } };
}

async function workflowList(scope: TeamMateMcpScope): Promise<McpToolSuccess> {
  const result = await (await workflows(scope)).list();
  return { structured: { runs: result.runs.map(workflowRunResult) } };
}
