import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import { optionalRepoInput, repoInputSchema } from './teammate-mcp.js';

export interface TeamMcpOptions {
  dispatcherId: string;
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

const JSONRPC_VERSION = '2.0';
const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05';

export async function runTeamMcp(opts: TeamMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
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
      await handleRequest(request, { dispatcherId, socketPath, output });
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
  ctx: { dispatcherId: string; socketPath: string; output: Writable },
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
        write(ctx.output, okResponse(request.id, { tools: teamTools() }));
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

function teamTools(): Array<Record<string, unknown>> {
  return [
    tool('create', 'Create a Team and start its TeamLeader. team_name is the concrete Team key used by all later status/history/dissolve/bind_group calls. intent is required: it is the durable recovery subject for the Team. repo is optional: omit it to run the TeamLeader and members in a plain shared work directory under the dispatcher workspace (.workspace/work/<team_name>/ — the dispatcher cwd need not be a git repo), or pass { mode: reuse-cwd | managed, path?, base_ref?, branch?, slug?, cleanup? } — managed creates a git worktree. Optionally bind an existing Feishu group chat at create time via bind_group.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      repo: repoInputSchema(),
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      intent: { type: 'string', minLength: 1, maxLength: 2000 },
      prompt: { type: 'string', maxLength: 20000 },
      bind_group: {
        type: 'object',
        additionalProperties: false,
        properties: { chat_id: { type: 'string', minLength: 1 } },
        required: ['chat_id'],
      },
    }, ['team_name', 'leader_agent_runtime', 'intent']),
    tool('list', 'List Teams owned by this dispatcher (compact scan rows: team_name, status, intent, repo, leader, member count, bound group).', {}, []),
    tool('status', 'Read one Team\'s detailed current status by its team_name (record, TeamLeader status, member count, active bound group).', {
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
    tool('bind_group', 'Bind an existing Feishu group chat to a Team by team_name (group chats only).', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      chat_id: { type: 'string', minLength: 1 },
    }, ['team_name', 'chat_id']),
    tool('transfer_channel_back', 'Transfer a bound Feishu group chat back to the dispatcher.', {
      chat_id: { type: 'string', minLength: 1 },
    }, ['chat_id']),
    tool('dissolve', 'Close one Team (by team_name) and its agents. note is required: it records why a recoverable Team was stopped.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['team_name', 'note']),
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
  ctx: { dispatcherId: string; socketPath: string },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    const mapped = mapToolCall(call);
    const result = await sendAdminRequest(
      mapped.method,
      { dispatcher_id: ctx.dispatcherId, ...mapped.params },
      { socketPath: ctx.socketPath },
    );
    return {
      content: [{ type: 'text', text: `${call.name} forwarded to dreamux serve` }],
      structuredContent: result,
    };
  } catch (err) {
    const prefix = err instanceof AdminClientError ? `[${err.code}] ` : '';
    return { content: [{ type: 'text', text: `${prefix}${parseMessage(err)}` }], isError: true };
  }
}

function mapToolCall(call: ToolCall): { method: string; params: Record<string, unknown> } {
  switch (call.name) {
    case 'create':
      return { method: 'mcp.team.create', params: createArgs(call.arguments) };
    case 'list':
      return { method: 'mcp.team.list', params: {} };
    case 'status':
      return { method: 'mcp.team.status', params: teamNameArgs(call.arguments) };
    case 'history':
      return { method: 'mcp.team.history', params: historyArgs(call.arguments) };
    case 'bind_group':
      return { method: 'mcp.team.bind_group', params: bindGroupArgs(call.arguments) };
    case 'transfer_channel_back':
      return { method: 'mcp.team.transfer_channel_back', params: transferArgs(call.arguments) };
    case 'dissolve':
      return { method: 'mcp.team.dissolve', params: dissolveArgs(call.arguments) };
    default:
      throw new Error(`unknown Team tool '${String(call.name)}'`);
  }
}

function createArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'create arguments');
  const prompt = optionalString(obj, 'prompt');
  // Optional: bind an existing Feishu group at create time (issue #182 PR-8).
  const bindGroupRaw = obj['bind_group'];
  let bindGroup: { chat_id: string } | null = null;
  if (bindGroupRaw !== undefined && bindGroupRaw !== null) {
    const bindObj = asRecord(bindGroupRaw, 'bind_group');
    bindGroup = { chat_id: requireString(bindObj, 'chat_id') };
  }
  // #199 Slice 2: the public work-directory input is a single optional `repo`
  // object (replacing the old required `repo_cwd`). Omitted → a plain shared
  // .workspace/work/<team_name>/ dir (no git worktree, issue #199).
  const repo = optionalRepoInput(obj, 'repo');
  return {
    team_name: requireString(obj, 'team_name'),
    leader_agent_runtime: requireString(obj, 'leader_agent_runtime'),
    // Required recovery subject (issue #182 PR-3).
    intent: requireString(obj, 'intent'),
    ...(repo !== null ? { repo } : {}),
    ...(prompt !== null ? { prompt } : {}),
    ...(bindGroup !== null ? { bind_group: bindGroup } : {}),
  };
}

function teamNameArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { team_name: requireString(obj, 'team_name') };
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

function bindGroupArgs(value: unknown): Record<string, unknown> {
  // #182 PR-7: bind an existing Feishu group by team_name + chat id. Group-only,
  // so no `chat_type` is accepted (the binding store rejects non-group anyway).
  const obj = asRecord(value, 'bind_group arguments');
  return {
    team_name: requireString(obj, 'team_name'),
    chat_id: requireString(obj, 'chat_id'),
  };
}

function transferArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'transfer arguments');
  return { chat_id: requireString(obj, 'chat_id') };
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
