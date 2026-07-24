import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import {
  appendTaskDispatchSuccessReminder,
  appendStructuredTaskDispatchSuccessReminder,
  TEAM_DISPATCH_SUCCESS_REMINDER,
} from './task-dispatch-reminder.js';
import { optionalRepoInput, repoInputSchema } from './teammate-mcp.js';

export type TeamMcpCallerKind = 'dispatcher' | 'team_leader';

export interface TeamMcpOptions {
  dispatcherId: string;
  callerKind?: TeamMcpCallerKind;
  teamId?: string;
  leaderName?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolCall {
  name: string;
  arguments: unknown;
}

type TeamMcpCaller =
  | { kind: 'dispatcher' }
  | { kind: 'team_leader'; teamId: string; leaderName: string };

const JSONRPC_VERSION = '2.0';
const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05';

export async function runTeamMcp(opts: TeamMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const caller = teamMcpCaller(opts);
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((message) => console.error(message));
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      write(output, errorResponse(null, -32700, parseMessage(err)));
      continue;
    }
    try {
      await handleRequest(request, { dispatcherId, socketPath, output, caller });
    } catch (err) {
      log(`team-mcp: ${parseMessage(err)}`);
      if (request.id !== undefined) {
        write(output, errorResponse(request.id, -32603, parseMessage(err)));
      }
    }
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  ctx: {
    dispatcherId: string;
    socketPath: string;
    output: Writable;
    caller: TeamMcpCaller;
  },
): Promise<void> {
  if (typeof request.method !== 'string') {
    if (request.id !== undefined) {
      write(ctx.output, errorResponse(request.id, -32600, 'missing method'));
    }
    return;
  }
  switch (request.method) {
    case 'initialize':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, {
          protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'dreamux-team', version: '0.3.0' },
        }));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: teamTools(ctx.caller.kind) }));
      }
      return;
    case 'tools/call':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, await callTool(request.params, ctx)));
      }
      return;
    default:
      if (request.id !== undefined) {
        write(ctx.output, errorResponse(request.id, -32601, `unknown MCP method '${request.method}'`));
      }
  }
}

export function teamTools(
  callerKind: TeamMcpCallerKind = 'dispatcher',
): Array<Record<string, unknown>> {
  const bindChannelTool = callerKind === 'team_leader'
    ? tool(
        'bind_channel',
        'Bind the selected unowned channel target to this Team. The exact same explicit binding is idempotent; targets owned by another Team or managed by a collaboration route are refused. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.',
        {
          channel_id: { type: 'string', minLength: 1, maxLength: 64 },
          meta: { type: 'object' },
        },
        ['meta'],
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
      );
  const transferBackDescription = callerKind === 'team_leader'
    ? 'Release this Team\'s binding for the selected channel target. This is a routing-only state change with no channel-message side effect. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.'
    : 'Release a bound channel target from a Team so future inbound for that target is no longer routed to the Team. channel_id selects the configured channel (optional; defaults to the sole channel). meta carries the provider-defined channel target selector that Dreamux normalizes through the channel provider.';
  const transferBackTool = tool('transfer_back', transferBackDescription, {
    channel_id: { type: 'string', minLength: 1, maxLength: 64 },
    meta: { type: 'object' },
  }, ['meta']);
  if (callerKind === 'team_leader') return [bindChannelTool, transferBackTool];
  return [
    tool('create', 'Create a Team and start its TeamLeader. name_prefix is only a requested label; create RETURNS a concrete, never-reused team.team_name with a 4-8 character random suffix, and every later status/history/dissolve/send/bind_channel call MUST use that returned team_name. intent is required: it is the durable recovery subject for the Team. repo is optional: omit it to let Dreamux allocate a plain shared work directory for the Team, or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } to choose an existing path or create a managed git worktree. prompt is optional: when supplied it is delivered as the TeamLeader\'s first turn; when omitted the leader starts idle and waits for bound-channel inbound or a later Team MCP send. To route a channel target to the Team, bind it after create with the team bind_channel tool.', {
      name_prefix: { type: 'string', minLength: 1, maxLength: 64 },
      repo: repoInputSchema(),
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
      identity: { type: 'string', minLength: 1, maxLength: 4000 },
      prompt: { type: 'string', maxLength: 20000 },
    }, ['name_prefix', 'leader_agent_runtime', 'intent']),
    tool('send', 'Submit a follow-up turn to a Team\'s TeamLeader by team_name. This targets the TeamLeader agent only; it does not send to Team members and does not bind or post to a channel.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['team_name', 'prompt']),
    tool('list', 'List Teams owned by this dispatcher (compact scan rows: team_name, status, intent, repo, leader, member count, bound channel target).', {}, []),
    tool('status', 'Read one Team\'s detailed current status by its team_name (record, TeamLeader status, member count, active bound target).', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['team_name']),
    tool('history', 'Search Teams for recovery (closed included) by team_name, status, repo, intent text, and time range. A compact recovery list, not a raw event timeline. Returns { items, next_cursor }.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      status: { type: 'string', enum: ['starting', 'running', 'closed'] },
      repo: { type: 'string', minLength: 1, maxLength: 4096 },
      grep: { type: 'string', minLength: 1, maxLength: 500 },
      since: { type: 'integer' },
      until: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 1000 },
    }, []),
    tool('dissolve', 'Close one Team (by team_name) and its agents. note is required: it records why a recoverable Team was stopped.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['team_name', 'note']),
    bindChannelTool,
    transferBackTool,
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema: { type: 'object', additionalProperties: false, properties, required },
  };
}

async function callTool(
  params: unknown,
  ctx: { dispatcherId: string; socketPath: string; caller: TeamMcpCaller },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    const mapped = mapToolCall(call, ctx.caller.kind);
    const result = await sendAdminRequest(
      mapped.method,
      {
        dispatcher_id: ctx.dispatcherId,
        ...callerParams(ctx.caller),
        ...mapped.params,
      },
      { socketPath: ctx.socketPath },
    );
    return {
      content: [{
        type: 'text',
        text: appendTaskDispatchSuccessReminder(
          `${call.name} forwarded to dreamux serve`,
          result,
          TEAM_DISPATCH_SUCCESS_REMINDER,
        ),
      }],
      structuredContent: appendStructuredTaskDispatchSuccessReminder(
        result,
        TEAM_DISPATCH_SUCCESS_REMINDER,
      ),
    };
  } catch (err) {
    const prefix = err instanceof AdminClientError ? `[${err.code}] ` : '';
    return { content: [{ type: 'text', text: `${prefix}${parseMessage(err)}` }], isError: true };
  }
}

function mapToolCall(
  call: ToolCall,
  callerKind: TeamMcpCallerKind,
): { method: string; params: Record<string, unknown> } {
  if (
    callerKind === 'team_leader' &&
    call.name !== 'bind_channel' &&
    call.name !== 'transfer_back'
  ) {
    throw new Error(
      `Team tool '${String(call.name)}' is not available in this context. ` +
        'Available Team tools: bind_channel, transfer_back.',
    );
  }
  switch (call.name) {
    case 'create':
      return { method: 'team.create', params: createArgs(call.arguments) };
    case 'send':
      return { method: 'team.send', params: sendArgs(call.arguments) };
    case 'list':
      return { method: 'team.list', params: {} };
    case 'status':
      return { method: 'team.status', params: teamNameArgs(call.arguments) };
    case 'history':
      return { method: 'team.history', params: historyArgs(call.arguments) };
    case 'dissolve':
      return { method: 'team.dissolve', params: dissolveArgs(call.arguments) };
    case 'bind_channel':
      return {
        method: 'team.bind_channel',
        params: bindChannelArgs(call.arguments, callerKind),
      };
    case 'transfer_back':
      return { method: 'team.transfer_back', params: transferBackArgs(call.arguments) };
    default:
      throw new Error(`unknown Team tool '${String(call.name)}'`);
  }
}

function createArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'create arguments');
  const prompt = optionalString(obj, 'prompt');
  const identity = optionalString(obj, 'identity');
  // #199 Slice 2: the public work-directory input is a single optional `repo`
  // object (replacing the old required `repo_cwd`). Omitted → a plain shared
  // dispatcher-default workspace (no git worktree, issue #199).
  const repo = optionalRepoInput(obj, 'repo');
  return {
    name_prefix: requireString(obj, 'name_prefix'),
    leader_agent_runtime: requireString(obj, 'leader_agent_runtime'),
    // Required recovery subject (issue #182 PR-3).
    intent: requireString(obj, 'intent'),
    ...(repo !== null ? { repo } : {}),
    ...(prompt !== null ? { prompt } : {}),
    ...(identity !== null ? { identity } : {}),
  };
}

function teamNameArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { team_name: requireString(obj, 'team_name') };
}

function sendArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'send arguments');
  const intent = optionalString(obj, 'intent');
  return {
    team_name: requireString(obj, 'team_name'),
    prompt: requireString(obj, 'prompt'),
    ...(intent !== null ? { intent } : {}),
  };
}

function historyArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'history arguments');
  const teamName = optionalString(obj, 'team_name');
  const status = optionalString(obj, 'status');
  const repo = optionalString(obj, 'repo');
  const grep = optionalString(obj, 'grep');
  const since = optionalInteger(obj, 'since');
  const until = optionalInteger(obj, 'until');
  const limit = optionalInteger(obj, 'limit');
  const cursor = optionalString(obj, 'cursor');
  return {
    ...(teamName !== null ? { team_name: teamName } : {}),
    ...(status !== null ? { status } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
  };
}

function dissolveArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'dissolve arguments');
  // Required dissolve reason (issue #182 PR-3).
  return {
    team_name: requireString(obj, 'team_name'),
    note: requireString(obj, 'note'),
  };
}

function bindChannelArgs(
  value: unknown,
  callerKind: TeamMcpCallerKind,
): Record<string, unknown> {
  const obj = asRecord(value, 'bind_channel arguments');
  if (callerKind === 'team_leader' && Object.hasOwn(obj, 'team_name')) {
    throw new Error('team_name is not accepted for TeamLeader bind_channel');
  }
  return {
    ...(callerKind === 'dispatcher'
      ? { team_name: requireString(obj, 'team_name') }
      : {}),
    meta: requireRecord(obj, 'meta'),
    ...optionalChannelId(obj),
  };
}

function transferBackArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'transfer_back arguments');
  return { meta: requireRecord(obj, 'meta'), ...optionalChannelId(obj) };
}

function optionalChannelId(obj: Record<string, unknown>): Record<string, unknown> {
  const value = obj['channel_id'];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value === '') {
    throw new Error('channel_id must be a non-empty string');
  }
  return { channel_id: value };
}

function requireRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = obj[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asToolCallParams(params: unknown): ToolCall {
  const obj = asRecord(params, 'tools/call params');
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') throw new Error('tools/call params.name must be a non-empty string');
  return { name, arguments: obj['arguments'] ?? {} };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function optionalInteger(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
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

function okResponse(id: JsonRpcRequest['id'], result: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })}\n`;
}

function errorResponse(id: JsonRpcRequest['id'], code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } })}\n`;
}

function write(output: Writable, line: string): void {
  output.write(line);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
