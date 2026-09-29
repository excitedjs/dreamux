/**
 * The Team MCP server, implemented by the Team collection that owns it.
 *
 * The Dispatcher Agent's catalog operates on addressed Teams. A TeamLeader's
 * bound dissolve tool belongs to its actual Team in `leader-mcp.ts`.
 *
 * Every tool reaches {@link TeamsPort} directly. `team.create` /
 * `team.submit` / … remain the shared `admin.sock` and Channel-to-Core surface
 * and are untouched by this file; both surfaces call the same port, and what
 * they share — reading a `team_name`, reading a history query, and the one
 * submission receipt that is more than a copy — belongs to the Team and lives in
 * its own `requests.ts`. What stays here is this surface's:
 * Agent provenance, the advertised catalog, and the model-facing text a tool
 * chooses to say.
 *
 * Failures are thrown, not classified: a Team failure states its own reason and
 * next step, and the admission boundary every delegate is reached through
 * renders it. Nothing here decides what a model may read about a failure.
 */
import { randomUUID } from 'node:crypto';

import type { TeamCreateCommand } from '@excitedjs/dreamux-types';

import {
  mustNonBlankString,
  mustNonEmptyString,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { OBJECT, arrayOf, objectSchema } from '../../command/schema.js';
import { TEAM_DISPATCH_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  tool,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import { REPO_REQUEST_SCHEMA, repoRequest } from '../worktree/repo-request.js';
import { teamCreatePayloadHash } from './create-request.js';
import {
  dissolveReceiptSchema,
  teamHistoryQuery,
  teamNameParam,
  teamSubmitResult,
  teamSubmitResultOutput,
} from './requests.js';
import type { TeamsPort } from './teams-port.js';

export const TEAM_MCP_SERVER_NAME = 'team';

/** One tool this delegate advertises, paired with the handler that serves it. */
interface TeamMcpToolRecord {
  readonly descriptor: McpToolDescriptor;
  readonly execute: (args: CommandPayload) => Promise<McpToolSuccess>;
}

export function createTeamMcpDelegate(input: {
  teams: TeamsPort;
}): McpServerDelegate {
  const records = teamToolRecords(input.teams);
  const tools = records.map((record) => record.descriptor);
  return {
    name: TEAM_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { tools };
    },
    call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(() => callTool(records, call));
    },
  };
}

async function callTool(
  records: readonly TeamMcpToolRecord[],
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const record = records.find(
    (candidate) => candidate.descriptor.name === call.name,
  );
  if (record === undefined) {
    // Unreachable: Core admits a call only against this delegate's own frozen
    // catalog, so a name that is not in this delegate's own records never
    // arrives here.
    throw new Error(`unknown Team tool '${call.name}'`);
  }
  return record.execute(call.arguments as CommandPayload);
}

async function create(
  teams: TeamsPort,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const namePrefix = mustNonBlankString(args, 'name_prefix');
  const intent = mustNonBlankString(args, 'intent');
  const agentRuntime = mustNonEmptyString(args, 'leader_agent_runtime');
  const identityPrompt = optionalNonBlankString(args, 'identity');
  const prompt = optionalString(args, 'prompt');
  const repo = repoRequest(args, 'repo');
  const command: TeamCreateCommand = {
    // A tool call is one live request with no durable retry of its own, so the
    // request identity is minted per call: it gets the Team's duplicate
    // protection for concurrent repeats without inventing a model-facing input.
    request_id: randomUUID(),
    name_prefix: namePrefix,
    intent,
    leader: {
      agent_runtime: agentRuntime,
      ...(identityPrompt !== null ? { identity: identityPrompt } : {}),
      ...(prompt !== null ? { prompt } : {}),
    },
    ...(repo !== null ? { repo } : {}),
  };
  const result = await teams.createFromRequest({
    requestId: command.request_id,
    // Hashed over the caller's own arguments, without Core's injected
    // TeamLeader requirements: those change with a Dreamux upgrade and would
    // otherwise turn a legitimate replay into a conflict.
    payloadHash: teamCreatePayloadHash(command),
    command,
    // The Dispatcher Agent is waiting for this Team's answer, so Core delivers
    // the leader's first-turn completion back to it, same as `send` below.
    deliverCompletionToDispatcher: true,
  });
  return {
    structured: result,
    // A create that carried a prompt handed work down: the TeamLeader's first
    // turn was submitted behind this receipt, and its result arrives later.
    // This delegate mints a fresh request id for every call. A successful
    // prompt-bearing create therefore submitted the first turn; replays belong
    // to callers that supply their own durable request identity.
    ...(prompt !== null ? { text: TEAM_DISPATCH_SUCCESS_REMINDER } : {}),
  };
}

async function send(
  teams: TeamsPort,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const teamName = teamNameParam(args, 'team_name');
  const prompt = mustNonEmptyString(args, 'prompt');
  const intent = optionalNonBlankString(args, 'intent');
  const admission = await teams.submitToLeader(teamName, {
    text: prompt,
    ...(intent !== null ? { intent } : {}),
    // This is one Agent handing work to another, so it reaches the TeamLeader
    // as `task` provenance — not as `channel`, which is what the Command
    // surface means. Owning the source is exactly what the delegate boundary
    // is for; before it, both paths had to share one Command's answer.
    source: AGENT_TASK_SOURCE,
    // The Dispatcher Agent is waiting for this Team's answer, so Core delivers
    // the leader's completion back to it.
    deliverCompletionToDispatcher: true,
  });
  const structured = teamSubmitResult(admission);
  return {
    structured,
    ...(structured.status === 'submitted'
      ? { text: TEAM_DISPATCH_SUCCESS_REMINDER }
      : {}),
  };
}

async function list(teams: TeamsPort): Promise<McpToolSuccess> {
  return { structured: { teams: await teams.list() } };
}

async function status(
  teams: TeamsPort,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: await teams.summary(teamNameParam(args, 'team_name')),
  };
}

async function history(
  teams: TeamsPort,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  return {
    structured: await teams.history(teamHistoryQuery(args)),
  };
}

async function dissolve(
  teams: TeamsPort,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const note = mustNonBlankString(args, 'note');
  const force = args['force'] === true;
  const dissolved = await teams.dissolve(teamNameParam(args, 'team_name'), {
    note,
    force,
  });
  return { structured: dissolved };
}

function teamToolRecords(teams: TeamsPort): TeamMcpToolRecord[] {
  return [
    {
      descriptor: tool(
        'create',
        "The bundled `dispatcher-workflow` skill covers how to brief a TeamMate or a Team. Create a Team with its TeamLeader. name_prefix is only a requested label; create RETURNS a concrete, never-reused team_name with a 4-8 character random suffix, and every later status/history/dissolve/send call MUST use that returned team_name. intent is required: it is the durable recovery subject for the Team. repo is optional: omit it to let Dreamux allocate the Team's work directory by the dispatcher's workspace policy (a fresh shared directory, or the dispatcher's own directory when workspace isolation is disabled), or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, cleanup? } to choose an existing path or create a managed git worktree. prompt is optional: when supplied it is delivered as the TeamLeader's first turn; when omitted no TeamLeader process starts until bound-channel inbound or a later Team MCP send arrives. Routing a channel conversation to the Team is the channel's own decision, made with that channel's tools. With `prompt`, returns a receipt at once and the TeamLeader's completion is pushed later as a new message; without it, the Team is created and nothing is submitted.",
        {
          name_prefix: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description:
              'Requested label; the concrete team_name comes back in the result.',
          },
          repo: {
            ...REPO_REQUEST_SCHEMA,
            description:
              "Where the Team works; omit for the dispatcher's workspace default: a fresh shared directory, or the dispatcher's own directory when workspace isolation is disabled.",
          },
          leader_agent_runtime: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description:
              'Agent runtime id for the TeamLeader, from ' +
              'get_capabilities.agent_runtimes[].id on the teammate server.',
          },
          intent: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description:
              "One-line subject of the Team's work; shown in list and history and " +
              'kept for recovery.',
          },
          identity: {
            type: 'string',
            minLength: 1,
            maxLength: 4000,
            description:
              "Standing role and boundaries appended to the TeamLeader's system " +
              'prompt for every turn.',
          },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description:
              "The TeamLeader's first turn; omit it and no TeamLeader process " +
              'starts until a routed inbound or a later send arrives.',
          },
        },
        ['name_prefix', 'leader_agent_runtime', 'intent'],
        {
          title: 'Create a Team',
          output: OBJECT,
          annotations: MUTATING_ANNOTATIONS,
        },
      ),
      execute: (args) => create(teams, args),
    },
    {
      descriptor: tool(
        'send',
        "The bundled `dispatcher-workflow` skill covers how to brief a TeamMate or a Team. Submit a follow-up turn to a Team's TeamLeader by team_name. This targets the TeamLeader agent only; it does not send to Team members and does not bind or post to a channel. Returns a receipt at once; the completion is pushed later as a new message.",
        {
          team_name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete team_name returned by create.',
          },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description: 'The next turn for the TeamLeader.',
          },
          intent: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description:
              "Replaces the Team's recorded subject before the turn.",
          },
        },
        ['team_name', 'prompt'],
        {
          title: 'Send a TeamLeader turn',
          output: teamSubmitResultOutput,
          annotations: MUTATING_ANNOTATIONS,
        },
      ),
      execute: (args) => send(teams, args),
    },
    {
      descriptor: tool(
        'list',
        'List Teams owned by this dispatcher (compact scan rows: team_name, status, intent, repo, leader, and member count). Where a Team is reachable from the outside is a channel fact; ask the channel that owns the route.',
        {},
        [],
        {
          title: 'List Teams',
          output: objectSchema({ teams: arrayOf(OBJECT) }, ['teams']),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: () => list(teams),
    },
    {
      descriptor: tool(
        'status',
        "Read one Team's current summary by its team_name, using the same fields returned by create.",
        {
          team_name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete team_name returned by create.',
          },
        },
        ['team_name'],
        {
          title: 'Read Team status',
          output: OBJECT,
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => status(teams, args),
    },
    {
      descriptor: tool(
        'history',
        'Search Teams for recovery (closed included) by team_name, status, repo, intent text, and time range. A compact recovery list, not a raw event timeline. Returns { items, next_cursor }.',
        {
          team_name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'Exact concrete team_name.',
          },
          status: {
            type: 'string',
            enum: ['starting', 'running', 'closed'],
            description: 'Filter by Team status: starting, running, or closed.',
          },
          repo: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description:
              'Case-insensitive substring of the source repository path.',
          },
          grep: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description:
              'Case-insensitive substring over team_name, intent, source ' +
              'repository, leader name, and close note.',
          },
          since: {
            type: 'integer',
            description:
              "Epoch milliseconds; lower bound on a record's last update.",
          },
          until: {
            type: 'integer',
            description:
              "Epoch milliseconds; upper bound on a record's last update.",
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Rows per page; default 20, max 100.',
          },
          cursor: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description: 'next_cursor from the previous page.',
          },
        },
        [],
        {
          title: 'Search Teams',
          output: objectSchema(
            {
              items: arrayOf(OBJECT),
              next_cursor: { type: ['string', 'null'] },
            },
            ['items', 'next_cursor'],
          ),
          annotations: READ_ONLY_ANNOTATIONS,
        },
      ),
      execute: (args) => history(teams, args),
    },
    {
      descriptor: tool(
        'dissolve',
        "Submit a dissolve of one Team (by team_name) and its agents. It returns a receipt as soon as the request is accepted ({ accepted, team_name, status: submitted }); the Team is stopped and closed behind that receipt, so this call never reports the outcome. note is required: it records why a recoverable Team was stopped. team.status reports the Team's worktree_mode and worktree_cleanup_mode; only a managed delete-on-close worktree is removed. A non-forced request checks such a worktree before it accepts: uncommitted, untracked, or unmerged work is refused with the blocking reason, and the Team stays open and running. force: true only overrides a delete-on-close removal blocked by uncommitted, untracked, or unmerged work, by discarding that work; under cleanup: keep the checkout and its changes are retained; never the branch, its commits, a reused directory, or the source repository; deleting them is a separate decision that is the user's.",
        {
          team_name: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The concrete team_name returned by create.',
          },
          note: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'Why the Team stops; recorded on it.',
          },
          force: {
            type: 'boolean',
            description:
              'Only overrides a delete-on-close removal blocked by uncommitted, ' +
              'untracked, or unmerged work, by discarding that work; under ' +
              'cleanup: keep the checkout and its changes are retained; never ' +
              'the branch, its commits, a reused directory, or the source ' +
              'repository.',
          },
        },
        ['team_name', 'note'],
        {
          title: 'Dissolve a Team',
          output: dissolveReceiptSchema(),
          annotations: DESTRUCTIVE_ANNOTATIONS,
        },
      ),
      execute: (args) => dissolve(teams, args),
    },
  ];
}
