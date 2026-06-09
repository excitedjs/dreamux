import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

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
    tool('create', 'Create a Team and start its TeamLeader.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      repo_cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      intent: { type: 'string', maxLength: 2000 },
      prompt: { type: 'string', maxLength: 20000 },
    }, ['name', 'repo_cwd', 'leader_agent_runtime']),
    tool('create_group', 'Create a Team, create a Feishu group, and bind that group to the TeamLeader.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      repo_cwd: { type: 'string', minLength: 1, maxLength: 4096 },
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      source_chat_id: { type: 'string', minLength: 1 },
      source_chat_type: { type: 'string', enum: ['p2p', 'group'] },
      requester_open_id: { type: 'string', minLength: 1 },
      invite_open_ids: { type: 'array', items: { type: 'string' } },
      group_name: { type: 'string', minLength: 1 },
      intent: { type: 'string', maxLength: 2000 },
      prompt: { type: 'string', maxLength: 20000 },
    }, ['name', 'repo_cwd', 'leader_agent_runtime', 'source_chat_id', 'source_chat_type', 'requester_open_id']),
    tool('list', 'List Teams owned by this dispatcher.', {}, []),
    tool('status', 'Read one Team status.', {
      team_id: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['team_id']),
    tool('ledger', 'Read one Team ledger.', {
      team_id: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['team_id']),
    tool('bind_channel', 'Bind a Feishu group chat to a TeamLeader.', {
      team_id: { type: 'string', minLength: 1, maxLength: 64 },
      chat_id: { type: 'string', minLength: 1 },
      chat_type: { type: 'string', enum: ['group', 'p2p'] },
    }, ['team_id', 'chat_id', 'chat_type']),
    tool('transfer_channel_back', 'Transfer a bound Feishu group chat back to the dispatcher.', {
      chat_id: { type: 'string', minLength: 1 },
      chat_type: { type: 'string', enum: ['group', 'p2p'] },
    }, ['chat_id', 'chat_type']),
    tool('dissolve', 'Close one Team and its agents.', {
      team_id: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', maxLength: 2000 },
    }, ['team_id']),
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
    case 'create_group':
      return { method: 'mcp.team.create_group', params: createGroupArgs(call.arguments) };
    case 'list':
      return { method: 'mcp.team.list', params: {} };
    case 'status':
      return { method: 'mcp.team.status', params: teamIdArgs(call.arguments) };
    case 'ledger':
      return { method: 'mcp.team.ledger', params: teamIdArgs(call.arguments) };
    case 'bind_channel':
      return { method: 'mcp.team.bind_channel', params: bindChannelArgs(call.arguments) };
    case 'transfer_channel_back':
      return { method: 'mcp.team.transfer_channel_back', params: channelArgs(call.arguments) };
    case 'dissolve':
      return { method: 'mcp.team.dissolve', params: dissolveArgs(call.arguments) };
    default:
      throw new Error(`unknown Team tool '${String(call.name)}'`);
  }
}

function createArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'create arguments');
  const intent = optionalString(obj, 'intent');
  const prompt = optionalString(obj, 'prompt');
  return {
    name: requireString(obj, 'name'),
    repo_cwd: requireString(obj, 'repo_cwd'),
    leader_agent_runtime: requireString(obj, 'leader_agent_runtime'),
    ...(intent !== null ? { intent } : {}),
    ...(prompt !== null ? { prompt } : {}),
  };
}

function createGroupArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'create_group arguments');
  const inviteOpenIds = optionalStringArray(obj, 'invite_open_ids');
  return {
    ...createArgs(value),
    source_chat_id: requireString(obj, 'source_chat_id'),
    source_chat_type: requireString(obj, 'source_chat_type'),
    requester_open_id: requireString(obj, 'requester_open_id'),
    ...optionalStringProp(obj, 'group_name'),
    ...(inviteOpenIds !== null ? { invite_open_ids: inviteOpenIds } : {}),
  };
}

function teamIdArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { team_id: requireString(obj, 'team_id') };
}

function dissolveArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'dissolve arguments');
  const note = optionalString(obj, 'note');
  return {
    team_id: requireString(obj, 'team_id'),
    ...(note !== null ? { note } : {}),
  };
}

function bindChannelArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'bind_channel arguments');
  return {
    team_id: requireString(obj, 'team_id'),
    ...channelArgs(value),
  };
}

function channelArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'channel arguments');
  return {
    chat_id: requireString(obj, 'chat_id'),
    chat_type: requireString(obj, 'chat_type'),
  };
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

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringProp(
  obj: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = optionalString(obj, key);
  return value === null ? {} : { [key]: value };
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
