import type { Readable, Writable } from 'node:stream';

import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  runMcpServer,
  PublicToolError,
  type McpToolDefinition,
  type McpToolMetadata,
  type RunMcpServerOptions,
} from './server.js';
import {
  DESTRUCTIVE_ANNOTATIONS,
  MUTATING_ANNOTATIONS,
  OPEN_OBJECT,
  READ_ONLY_ANNOTATIONS,
  SUBMISSION_ERROR_SCHEMA,
  SUBMISSION_STATUS_SCHEMA,
  arrayOf,
  closedObjectSchema,
  forwardAdmin,
  publicErrorRules,
  toolMetadata,
  type PublicErrorRule,
} from './tool-catalog.js';
import { repoInputSchema } from './teammate-mcp.js';
import { teamDispatchSuccessText } from './task-dispatch-reminder.js';

export type TeamMcpCallerKind = 'dispatcher' | 'team_leader';

export interface TeamMcpOptions {
  dispatcherId: string;
  callerKind?: TeamMcpCallerKind;
  teamId?: string;
  leaderName?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  transport?: RunMcpServerOptions['transport'];
  log?: (message: string) => void;
}

type TeamMcpCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

interface TeamMcpScope {
  dispatcherId: string;
  caller: TeamMcpCaller;
  socketPath: string;
}

const SERVER_IDENTITY = { name: 'dreamux-team', version: '0.3.0' };

const TEAM_BINDING_RESULT_DESCRIPTION =
  'Results expose every active binding in bound_targets. bound_target remains ' +
  'the first array item, or null when the array is empty, for compatibility.';

/**
 * Admin errors whose message is safe to surface. The dissolve-blocked reason
 * and bind conflicts are actionable public guidance; the catch-all `*_FAILED`
 * and `INTERNAL` codes are never surfaced.
 */
const PUBLIC_ERRORS: readonly PublicErrorRule[] = [
  ...publicErrorRules(
    [
      'team.create',
      'team.send',
      'team.list',
      'team.status',
      'team.history',
      'team.dissolve',
      'team.bind_channel',
      'team.transfer_back',
    ],
    ['BAD_REQUEST', 'DISPATCHER_NOT_FOUND'],
  ),
  ...publicErrorRules(
    ['team.send', 'team.dissolve', 'team.bind_channel', 'team.transfer_back'],
    ['TEAM_NOT_FOUND'],
  ),
  { method: 'team.dissolve', code: 'TEAM_DISSOLVE_BLOCKED' },
];

export async function runTeamMcp(opts: TeamMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const caller = teamMcpCaller(opts);
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const scope: TeamMcpScope = { dispatcherId, caller, socketPath };
  await runMcpServer({
    identity: SERVER_IDENTITY,
    tools: teamToolDefinitions(scope),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}

export function teamTools(
  callerKind: TeamMcpCallerKind = 'dispatcher',
): Array<Record<string, unknown>> {
  return teamToolMetadata(callerKind) as unknown as Array<Record<string, unknown>>;
}

function teamToolMetadata(callerKind: TeamMcpCallerKind): McpToolMetadata[] {
  const bindReceipt = closedObjectSchema(
    {
      channel_id: { type: 'string' },
      provider: { type: 'string' },
      target_type: { type: 'string' },
      target_key: { type: 'string' },
      display: { type: ['string', 'null'] },
      canonical_url: { type: ['string', 'null'] },
    },
    ['channel_id', 'provider', 'target_type', 'target_key', 'display', 'canonical_url'],
  );
  const transferReceipt = closedObjectSchema(
    {
      transferred: { type: 'boolean' },
      binding: { type: ['object', 'null'] },
      message: { type: 'string' },
    },
    ['transferred', 'binding', 'message'],
  );
  const bindChannelTool = callerKind === 'team_leader'
    ? tool(
        'bind_channel',
        'Bind the selected unowned channel target to this Team. The exact same explicit binding is idempotent; targets owned by another Team or managed by a collaboration route are refused. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.',
        {
          channel_id: { type: 'string', minLength: 1, maxLength: 64 },
          meta: { type: 'object' },
        },
        ['meta'],
        { title: 'Bind a channel target', output: bindReceipt, annotations: MUTATING_ANNOTATIONS },
      )
    : tool(
        'bind_channel',
        'Bind a configured channel target to a Team by team_name so inbound from that target routes to the Team\'s TeamLeader. channel_id selects the configured channel (optional; defaults to the dispatcher\'s sole channel). meta carries the provider-defined channel target selector.',
        {
          team_name: { type: 'string', minLength: 1, maxLength: 64 },
          channel_id: { type: 'string', minLength: 1, maxLength: 64 },
          meta: { type: 'object' },
        },
        ['team_name', 'meta'],
        { title: 'Bind a channel target', output: bindReceipt, annotations: MUTATING_ANNOTATIONS },
      );
  const transferBackDescription = callerKind === 'team_leader'
    ? 'Release this Team\'s binding for the selected channel target. This is a routing-only state change with no channel-message side effect. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.'
    : 'Release a bound channel target from a Team so future inbound for that target is no longer routed to the Team. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.';
  const transferBackTool = tool('transfer_back', transferBackDescription, {
    channel_id: { type: 'string', minLength: 1, maxLength: 64 },
    meta: { type: 'object' },
  }, ['meta'], {
    title: 'Release a channel target',
    output: transferReceipt,
    annotations: DESTRUCTIVE_ANNOTATIONS,
  });
  if (callerKind === 'team_leader') {
    return [
      tool(
        'dissolve',
        'Dissolve this descriptor-bound Team after preserving its work. note is required and records why the Team stopped.',
        {
          note: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            pattern: '\\S',
          },
        },
        ['note'],
        {
          title: 'Dissolve this Team',
          output: dissolveReceiptSchema(),
          annotations: DESTRUCTIVE_ANNOTATIONS,
        },
      ),
      bindChannelTool,
      transferBackTool,
    ];
  }
  return [
    tool('create', 'Create a Team and start its TeamLeader. name_prefix is only a requested label; create RETURNS a concrete, never-reused team.team_name with a 4-8 character random suffix, and every later status/history/dissolve/send/bind_channel call MUST use that returned team_name. intent is required: it is the durable recovery subject for the Team. repo is optional: omit it to let Dreamux allocate a plain shared work directory for the Team, or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } to choose an existing path or create a managed git worktree. prompt is optional: when supplied it is delivered as the TeamLeader\'s first turn; when omitted the leader starts idle and waits for bound-channel inbound or a later Team MCP send. To route a channel target to the Team, bind it after create with the team bind_channel tool.', {
      name_prefix: { type: 'string', minLength: 1, maxLength: 64 },
      repo: repoInputSchema(),
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
      identity: { type: 'string', minLength: 1, maxLength: 4000 },
      prompt: { type: 'string', maxLength: 20000 },
    }, ['name_prefix', 'leader_agent_runtime', 'intent'], {
      title: 'Create a Team',
      output: teamCreateSchema(),
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('send', 'Submit a follow-up turn to a Team\'s TeamLeader by team_name. This targets the TeamLeader agent only; it does not send to Team members and does not bind or post to a channel.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['team_name', 'prompt'], {
      title: 'Send a TeamLeader turn',
      output: closedObjectSchema(
        {
          team: OPEN_OBJECT,
          leader: OPEN_OBJECT,
          status: SUBMISSION_STATUS_SCHEMA,
          error: SUBMISSION_ERROR_SCHEMA,
        },
        ['team', 'leader', 'status'],
      ),
      annotations: MUTATING_ANNOTATIONS,
    }),
    tool('list', `List Teams owned by this dispatcher (compact scan rows: team_name, status, intent, repo, leader, member count, and active bound channel targets). ${TEAM_BINDING_RESULT_DESCRIPTION}`, {}, [], {
      title: 'List Teams',
      output: closedObjectSchema({ teams: arrayOf(OPEN_OBJECT) }, ['teams']),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('status', `Read one Team's detailed current status by its team_name (record, TeamLeader status, member count, and active bound channel targets). ${TEAM_BINDING_RESULT_DESCRIPTION}`, {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['team_name'], {
      title: 'Read Team status',
      output: closedObjectSchema(
        {
          team: OPEN_OBJECT,
          leader: { type: ['object', 'null'] },
          member_count: { type: 'integer' },
          bound_target: { type: ['object', 'null'] },
          bound_targets: arrayOf(OPEN_OBJECT),
        },
        ['team', 'leader', 'member_count', 'bound_target', 'bound_targets'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('history', `Search Teams for recovery (closed included) by team_name, status, repo, intent text, and time range. A compact recovery list, not a raw event timeline. Returns { items, next_cursor }. ${TEAM_BINDING_RESULT_DESCRIPTION}`, {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      status: { type: 'string', enum: ['starting', 'running', 'closed'] },
      repo: { type: 'string', minLength: 1, maxLength: 4096 },
      grep: { type: 'string', minLength: 1, maxLength: 500 },
      since: { type: 'integer' },
      until: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 1000 },
    }, [], {
      title: 'Search Teams',
      output: closedObjectSchema(
        { items: arrayOf(OPEN_OBJECT), next_cursor: { type: ['string', 'null'] } },
        ['items', 'next_cursor'],
      ),
      annotations: READ_ONLY_ANNOTATIONS,
    }),
    tool('dissolve', 'Close one Team (by team_name) and its agents. note is required: it records why a recoverable Team was stopped.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['team_name', 'note'], {
      title: 'Dissolve a Team',
      output: dissolveReceiptSchema(),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    }),
    bindChannelTool,
    transferBackTool,
  ];
}

function dissolveReceiptSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      accepted: { type: 'boolean' },
      team_name: { type: 'string' },
      status: { type: 'string' },
      bound_target: { type: ['object', 'null'] },
      bound_targets: arrayOf(OPEN_OBJECT),
    },
    ['accepted', 'team_name', 'status', 'bound_target', 'bound_targets'],
  );
}

function teamCreateSchema(): Record<string, unknown> {
  return closedObjectSchema(
    {
      team: OPEN_OBJECT,
      leader: { type: ['object', 'null'] },
      member_count: { type: 'integer' },
      status: { anyOf: [{ type: 'null' }, SUBMISSION_STATUS_SCHEMA] },
      error: SUBMISSION_ERROR_SCHEMA,
      bound_target: { type: ['object', 'null'] },
      bound_targets: arrayOf(OPEN_OBJECT),
    },
    ['team', 'leader', 'member_count', 'status', 'bound_target', 'bound_targets'],
  );
}

function teamToolDefinitions(scope: TeamMcpScope): McpToolDefinition[] {
  return teamToolMetadata(scope.caller.kind).map((metadata) => {
    const selectsSuccessText =
      metadata.name === 'create' || metadata.name === 'send';
    return {
      ...metadata,
      ...(selectsSuccessText
        ? { successText: teamDispatchSuccessText }
        : {}),
      handler: (args) => callTool(metadata.name, args, scope),
    };
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  scope: TeamMcpScope,
): Promise<Record<string, unknown>> {
  const mapped = mapToolCall(name, args, scope.caller.kind);
  return forwardAdmin({
    method: mapped.method,
    params: {
      dispatcher_id: scope.dispatcherId,
      ...mapped.params,
      ...callerParams(scope.caller),
    },
    socketPath: scope.socketPath,
    publicErrors: PUBLIC_ERRORS,
    project: mapped.project,
  });
}

type ProjectFn = (value: unknown) => Record<string, unknown>;

function mapToolCall(
  name: string,
  args: Record<string, unknown>,
  callerKind: TeamMcpCallerKind,
): { method: string; params: Record<string, unknown>; project: ProjectFn } {
  if (
    callerKind === 'team_leader' &&
    name !== 'dissolve' &&
    name !== 'bind_channel' &&
    name !== 'transfer_back'
  ) {
    throw new PublicToolError(
      `Team tool '${String(name)}' is not available in this context. ` +
        'Available Team tools: dissolve, bind_channel, transfer_back.',
    );
  }
  switch (name) {
    case 'create':
      return { method: 'team.create', params: args, project: projectTeamCreate };
    case 'send':
      return { method: 'team.send', params: args, project: projectTeamSend };
    case 'list':
      return { method: 'team.list', params: {}, project: projectTeamList };
    case 'status':
      return { method: 'team.status', params: args, project: projectTeamStatus };
    case 'history':
      return { method: 'team.history', params: args, project: projectTeamHistory };
    case 'dissolve':
      return {
        method: 'team.dissolve',
        params: args,
        project: projectDissolve,
      };
    case 'bind_channel':
      return {
        method: 'team.bind_channel',
        params: args,
        project: projectBinding,
      };
    case 'transfer_back':
      return {
        method: 'team.transfer_back',
        params: args,
        project: projectTransfer,
      };
    default:
      throw new Error(`unknown Team tool '${String(name)}'`);
  }
}

function projectTeamCreate(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team create result');
  return {
    team: obj['team'],
    leader: obj['leader'] ?? null,
    member_count: obj['member_count'],
    status: obj['status'] ?? null,
    ...(obj['error'] !== undefined ? { error: obj['error'] } : {}),
    bound_target: obj['bound_target'] ?? null,
    bound_targets: obj['bound_targets'] ?? [],
  };
}

function projectTeamSend(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team send result');
  return {
    team: obj['team'],
    leader: obj['leader'],
    status: obj['status'],
    ...(obj['error'] !== undefined ? { error: obj['error'] } : {}),
  };
}

function projectTeamList(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team list result');
  return { teams: obj['teams'] ?? [] };
}

function projectTeamStatus(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team status result');
  return {
    team: obj['team'],
    leader: obj['leader'] ?? null,
    member_count: obj['member_count'],
    bound_target: obj['bound_target'] ?? null,
    bound_targets: obj['bound_targets'] ?? [],
  };
}

function projectTeamHistory(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team history result');
  return { items: obj['items'] ?? [], next_cursor: obj['next_cursor'] ?? null };
}

function projectDissolve(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'team dissolve result');
  return {
    accepted: obj['accepted'],
    team_name: obj['team_name'],
    status: obj['status'],
    bound_target: obj['bound_target'] ?? null,
    bound_targets: obj['bound_targets'] ?? [],
  };
}

function projectTransfer(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'transfer_back result');
  return {
    transferred: obj['transferred'],
    binding: obj['binding'] ?? null,
    message: obj['message'],
  };
}

function projectBinding(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'bind_channel result');
  return {
    channel_id: obj['channel_id'],
    provider: obj['provider'],
    target_type: obj['target_type'],
    target_key: obj['target_key'],
    display: obj['display'] ?? null,
    canonical_url: obj['canonical_url'] ?? null,
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  meta: {
    title: string;
    output: Record<string, unknown>;
    annotations: McpToolMetadata['annotations'];
  },
): McpToolMetadata {
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function teamMcpCaller(opts: TeamMcpOptions): TeamMcpCaller {
  const kind = opts.callerKind ?? 'dispatcher';
  if (kind === 'dispatcher') return { kind };
  if (kind === 'team_leader') {
    return {
      kind,
      teamId: requireOption(opts.teamId, 'teamId'),
      leaderName: requireOption(opts.leaderName, 'leaderName'),
    };
  }
  throw new Error(`unknown Team MCP caller kind '${String(kind)}'`);
}

function callerParams(caller: TeamMcpCaller): Record<string, unknown> {
  if (caller.kind === 'dispatcher') return { caller_kind: 'dispatcher' };
  return {
    caller_kind: 'team_leader',
    team_id: caller.teamId,
    leader_name: caller.leaderName,
  };
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when the Team MCP runs for a TeamLeader`);
  }
  return value;
}
