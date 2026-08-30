/**
 * The Team MCP server, implemented by the Team collection that owns it.
 *
 * Two callers see two catalogs from one delegate: the Dispatcher Agent gets the
 * full Team surface, a TeamLeader gets only what it may do to its own Team. The
 * caller is bound at construction, never sent by the model and never carried in
 * a payload — which is why the leader-scoped tools take no `team_name` at all
 * and cannot be pointed at another Team.
 *
 * Every tool reaches {@link DispatcherService} directly. `team.create` /
 * `team.submit` / … remain the shared `admin.sock` and Channel-to-Core surface
 * and are untouched by this file; both surfaces call the same methods, and the
 * projections they share live here and in the Command module beside it.
 */
import { randomUUID } from 'node:crypto';

import { normalizeSkillSources } from '../../agent-runtime/skill-sources.js';
import {
  mustNonBlankString,
  mustNonEmptyString,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import {
  repoRequest,
  repoWorktree,
} from '../worktree/repo-request.js';
import { runDelegateTool, type McpToolSuccess } from '../mcp/projection.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  SUBMISSION_STATUS_SCHEMA,
  arrayOf,
  closedObjectSchema,
  repoInputSchema,
  toolMetadata,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from '../mcp/tool-metadata.js';
import type {
  McpDelegateCall,
  McpDelegateDescription,
  McpDelegateResult,
  McpServerDelegate,
} from '../mcp/types.js';
import { TEAM_DISPATCH_SUCCESS_REMINDER } from '../mcp/dispatch-reminders.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import type { DispatcherService } from '../dispatcher-service/index.js';
import {
  TEAM_LEADER_REQUIRED_SKILL_SOURCES,
  teamCreatePayloadHash,
} from './create-request.js';
import { throwPublicDissolveError } from './errors.js';
import { teamSubmitResult } from './projections.js';
import { optionalTeamStatus } from './types.js';

/** Who this delegate serves. Bound once, at runtime construction. */
export type TeamMcpCaller =
  | { readonly kind: 'dispatcher' }
  | {
      readonly kind: 'team_leader';
      readonly teamId: string;
      readonly leaderName: string;
    };

export const TEAM_MCP_SERVER_NAME = 'team';

const IDENTITY = { name: 'dreamux-team', version: '0.4.0' };

/**
 * Failures a Team tool may show the model, per tool.
 *
 * `BAD_REQUEST` is this delegate's own argument validation — the model can fix
 * it. The rest are Team facts a caller can act on: a Team that is gone or
 * closed, and a replayed creation request. A dissolve answers with a receipt,
 * so nothing about how the dissolve itself goes can appear here.
 */
const PUBLIC_CODES: Readonly<Record<string, readonly string[]>> = {
  create: ['BAD_REQUEST', 'IDEMPOTENCY_CONFLICT'],
  send: ['BAD_REQUEST', 'TEAM_NOT_FOUND', 'TEAM_CLOSED'],
  list: ['BAD_REQUEST'],
  status: ['BAD_REQUEST'],
  history: ['BAD_REQUEST'],
  dissolve: ['BAD_REQUEST', 'TEAM_NOT_FOUND'],
};

export function createTeamMcpDelegate(input: {
  dispatcher: DispatcherService;
  caller: TeamMcpCaller;
}): McpServerDelegate {
  const tools = teamToolDescriptors(input.caller.kind);
  return {
    name: TEAM_MCP_SERVER_NAME,
    describe(): McpDelegateDescription {
      return { identity: IDENTITY, tools };
    },
    async call(call: McpDelegateCall): Promise<McpDelegateResult> {
      return runDelegateTool(PUBLIC_CODES[call.name] ?? ['BAD_REQUEST'], () =>
        serve(input.dispatcher, input.caller, call),
      );
    },
  };
}

async function serve(
  dispatcher: DispatcherService,
  caller: TeamMcpCaller,
  call: McpDelegateCall,
): Promise<McpToolSuccess> {
  const args = call.arguments as CommandPayload;
  switch (call.name) {
    case 'create':
      return create(dispatcher, args);
    case 'send':
      return send(dispatcher, args);
    case 'list':
      return list(dispatcher);
    case 'status':
      return status(dispatcher, args);
    case 'history':
      return history(dispatcher, args);
    case 'dissolve':
      return dissolve(dispatcher, caller, args);
    default:
      // Unreachable: Core admits a call only against this delegate's own frozen
      // catalog, so a name that is not one of the above never arrives here.
      throw new Error(`unknown Team tool '${call.name}'`);
  }
}

async function create(
  dispatcher: DispatcherService,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const namePrefix = mustNonEmptyString(args, 'name_prefix');
  const intent = mustNonEmptyString(args, 'intent');
  const agentRuntime = mustNonEmptyString(args, 'leader_agent_runtime');
  const identityPrompt = optionalNonBlankString(args, 'identity');
  const prompt = optionalString(args, 'prompt');
  const repo = repoWorktree(repoRequest(args, 'repo'));
  const skillSources = await normalizeSkillSources(null, {
    requiredSources: TEAM_LEADER_REQUIRED_SKILL_SOURCES,
  });
  // A named repository request without an explicit path resolves to the
  // dispatcher's own workspace, exactly as the Command path does.
  const repoCwd = repo === null ? null : repo.cwd ?? (await dispatcher.workspace());
  const result = await dispatcher.createTeam({
    // A tool call is one live request with no durable retry of its own, so the
    // request identity is minted per call: it gets the Team's duplicate
    // protection for concurrent repeats without inventing a model-facing input.
    requestId: randomUUID(),
    // Hashed over the caller's own arguments, without Core's injected
    // TeamLeader requirements: those change with a Dreamux upgrade and would
    // otherwise turn a legitimate replay into a conflict.
    payloadHash: teamCreatePayloadHash({
      name_prefix: namePrefix,
      intent,
      leader: {
        agent_runtime: agentRuntime,
        ...(identityPrompt !== null ? { identity: identityPrompt } : {}),
        ...(prompt !== null ? { prompt } : {}),
      },
      ...(args['repo'] !== undefined ? { repo: args['repo'] } : {}),
    }),
    options: {
      namePrefix,
      intent,
      leaderAgentRuntime: agentRuntime,
      ...(repoCwd !== null ? { repoCwd } : {}),
      ...(repo !== null ? { worktree: repo.worktree } : {}),
      ...(prompt !== null ? { prompt } : {}),
      ...(identityPrompt !== null ? { identity: identityPrompt } : {}),
      ...(skillSources !== null ? { skillSources } : {}),
    },
  });
  return {
    structured: {
      status: result.status,
      team_name: result.team_name,
      leader_name: result.leader_name,
    },
  };
}

async function send(
  dispatcher: DispatcherService,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const teamName = mustNonEmptyString(args, 'team_name');
  const prompt = mustNonEmptyString(args, 'prompt');
  const intent = optionalNonBlankString(args, 'intent');
  const admission = await dispatcher.submitToTeamLeader({
    teamId: teamName,
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

async function list(dispatcher: DispatcherService): Promise<McpToolSuccess> {
  return { structured: { teams: await dispatcher.listTeams() } };
}

async function status(
  dispatcher: DispatcherService,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const summary = await dispatcher.getTeamStatus(
    mustNonEmptyString(args, 'team_name'),
  );
  return {
    structured: {
      team: summary.team,
      leader: summary.leader ?? null,
      member_count: summary.member_count,
    },
  };
}

async function history(
  dispatcher: DispatcherService,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const name = optionalString(args, 'team_name');
  const teamStatus = optionalTeamStatus(args, 'status');
  const repo = optionalString(args, 'repo');
  const grep = optionalString(args, 'grep');
  const since = optionalInteger(args, 'since');
  const until = optionalInteger(args, 'until');
  const limit = optionalInteger(args, 'limit');
  const cursor = optionalString(args, 'cursor');
  const result = await dispatcher.getTeamHistory({
    ...(name !== null ? { name } : {}),
    ...(teamStatus !== null ? { status: teamStatus } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
  });
  return {
    structured: {
      items: result.items,
      next_cursor: result.next_cursor ?? null,
    },
  };
}

async function dissolve(
  dispatcher: DispatcherService,
  caller: TeamMcpCaller,
  args: CommandPayload,
): Promise<McpToolSuccess> {
  const note = mustNonBlankString(args, 'note');
  const force = args['force'] === true;
  try {
    const dissolved =
      caller.kind === 'team_leader'
        ? await dispatcher.dissolveTeamForLeader({
            // The Team is the caller's own, from the descriptor that launched
            // this server — never a name the model supplied.
            teamId: caller.teamId,
            note,
            force,
          })
        : await dispatcher.dissolveTeam({
            teamId: mustNonEmptyString(args, 'team_name'),
            note,
            force,
          });
    return {
      structured: {
        accepted: dissolved.accepted,
        team_name: dissolved.team_name,
        status: dissolved.status,
      },
    };
  } catch (error) {
    throwPublicDissolveError(error);
  }
}

function teamToolDescriptors(
  callerKind: TeamMcpCaller['kind'],
): McpToolDescriptor[] {
  if (callerKind === 'team_leader') {
    return [
      tool(
        'dissolve',
        'Submit a dissolve of this descriptor-bound Team. It returns a receipt as soon as the request is accepted ({ accepted, team_name, status: submitted }) and never reports how the dissolve went: the Team\'s Workflow, TeamMates, and this TeamLeader are stopped behind that receipt, so expect this call to lose its response. note is required and records why the Team stopped. Uncommitted, untracked, or unmerged work in the managed worktree leaves the Team open and running instead of closing it. force: true discards that local work so the managed checkout can be removed; it never deletes the branch, its commits, a reused directory, or the source repository.',
        {
          note: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
          force: { type: 'boolean' },
        },
        ['note'],
        {
          title: 'Dissolve this Team',
          output: dissolveReceiptSchema(),
          annotations: DESTRUCTIVE_ANNOTATIONS,
        },
      ),
    ];
  }
  return [
    tool(
      'create',
      'Create a Team and start its TeamLeader. name_prefix is only a requested label; create RETURNS a concrete, never-reused team_name with a 4-8 character random suffix, and every later status/history/dissolve/send call MUST use that returned team_name. intent is required: it is the durable recovery subject for the Team. repo is optional: omit it to let Dreamux allocate a plain shared work directory for the Team, or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } to choose an existing path or create a managed git worktree. prompt is optional: when supplied it is delivered as the TeamLeader\'s first turn; when omitted the leader starts idle and waits for bound-channel inbound or a later Team MCP send. Routing a channel conversation to the Team is the channel\'s own decision, made with that channel\'s tools.',
      {
        name_prefix: { type: 'string', minLength: 1, maxLength: 64 },
        repo: repoInputSchema(),
        leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
        intent: { type: 'string', minLength: 1, maxLength: 2000 },
        identity: { type: 'string', minLength: 1, maxLength: 4000 },
        prompt: { type: 'string', maxLength: 20000 },
      },
      ['name_prefix', 'leader_agent_runtime', 'intent'],
      {
        title: 'Create a Team',
        output: teamCreateSchema(),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool(
      'send',
      'Submit a follow-up turn to a Team\'s TeamLeader by team_name. This targets the TeamLeader agent only; it does not send to Team members and does not bind or post to a channel.',
      {
        team_name: { type: 'string', minLength: 1, maxLength: 64 },
        prompt: { type: 'string', minLength: 1, maxLength: 20000 },
        intent: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      ['team_name', 'prompt'],
      {
        title: 'Send a TeamLeader turn',
        output: closedObjectSchema(
          {
            status: SUBMISSION_STATUS_SCHEMA,
            turn_id: { type: 'string' },
            error: closedObjectSchema(
              { code: { type: 'string' }, message: { type: 'string' } },
              ['code', 'message'],
            ),
          },
          ['status'],
        ),
        annotations: MUTATING_ANNOTATIONS,
      },
    ),
    tool(
      'list',
      'List Teams owned by this dispatcher (compact scan rows: team_name, status, intent, repo, leader, and member count). Where a Team is reachable from the outside is a channel fact; ask the channel that owns the route.',
      {},
      [],
      {
        title: 'List Teams',
        output: closedObjectSchema({ teams: arrayOf(OPEN_OBJECT) }, ['teams']),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'status',
      'Read one Team\'s detailed current status by its team_name (record, TeamLeader status, and member count).',
      { team_name: { type: 'string', minLength: 1, maxLength: 64 } },
      ['team_name'],
      {
        title: 'Read Team status',
        output: closedObjectSchema(
          {
            team: OPEN_OBJECT,
            leader: { type: ['object', 'null'] },
            member_count: { type: 'integer' },
          },
          ['team', 'leader', 'member_count'],
        ),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'history',
      'Search Teams for recovery (closed included) by team_name, status, repo, intent text, and time range. A compact recovery list, not a raw event timeline. Returns { items, next_cursor }.',
      {
        team_name: { type: 'string', minLength: 1, maxLength: 64 },
        status: { type: 'string', enum: ['starting', 'running', 'closed'] },
        repo: { type: 'string', minLength: 1, maxLength: 4096 },
        grep: { type: 'string', minLength: 1, maxLength: 500 },
        since: { type: 'integer' },
        until: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      [],
      {
        title: 'Search Teams',
        output: closedObjectSchema(
          {
            items: arrayOf(OPEN_OBJECT),
            next_cursor: { type: ['string', 'null'] },
          },
          ['items', 'next_cursor'],
        ),
        annotations: READ_ONLY_ANNOTATIONS,
      },
    ),
    tool(
      'dissolve',
      'Submit a dissolve of one Team (by team_name) and its agents. It returns a receipt as soon as the request is accepted ({ accepted, team_name, status: submitted }); the Team is stopped and closed behind that receipt, so this call never reports the outcome. note is required: it records why a recoverable Team was stopped. Uncommitted, untracked, or unmerged work in the managed worktree leaves the Team open and running instead of closing it, so read the Team\'s status afterwards to see what happened. force: true discards that local work so the managed checkout can be removed; it never deletes the branch, its commits, a reused directory, or the source repository.',
      {
        team_name: { type: 'string', minLength: 1, maxLength: 64 },
        note: { type: 'string', minLength: 1, maxLength: 2000 },
        force: { type: 'boolean' },
      },
      ['team_name', 'note'],
      {
        title: 'Dissolve a Team',
        output: dissolveReceiptSchema(),
        annotations: DESTRUCTIVE_ANNOTATIONS,
      },
    ),
  ];
}

function dissolveReceiptSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      accepted: { type: 'boolean' },
      team_name: { type: 'string' },
      status: { type: 'string' },
    },
    ['accepted', 'team_name', 'status'],
  );
}

function teamCreateSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      status: { type: 'string', enum: ['created', 'existing', 'closed'] },
      team_name: { type: 'string' },
      leader_name: { type: 'string' },
    },
    ['status', 'team_name', 'leader_name'],
  );
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolAnnotations;
  },
): McpToolDescriptor {
  return toolMetadata({
    name,
    title: meta.title,
    description,
    properties,
    required,
    outputSchema: meta.output,
    annotations: meta.annotations,
  });
}
