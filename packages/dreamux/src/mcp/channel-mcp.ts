/**
 * Core-hosted Channel MCP stdio shim (issue #209 slice 8).
 *
 * The generic Channel MCP surface owned by Dreamux core. It exposes the
 * channel-binding operations that used to live on the Feishu-specific Team MCP
 * (`team.bind_group` / `team.transfer_channel_back`, now removed without
 * aliases): `bind_channel` hands a chat to a Team, `transfer_back` returns it to
 * the dispatcher. Binding state, routing, and authorization stay core-owned —
 * this shim only forwards a tool call to core's admin socket; the
 * implementation behind `mcp.channel.*` is the same core binding store the Team
 * service uses.
 *
 * Scope note: only the user-facing Channel MCP selector remains Feishu
 * `chat_id` based for now (group chats, plus the optional `channel_id`). Core's
 * channel-neutral v2 target model — provider-owned `resolveTarget`, the
 * `(channel_id, target_key)` binding store, and routing/authorization — is
 * implemented (issue #209 binding store v2); `list_peers` is still unimplemented
 * and `reply` / `react` stay on the provider-owned `feishu` MCP server for now.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface ChannelMcpOptions {
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

export async function runChannelMcp(opts: ChannelMcpOptions): Promise<void> {
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
      log(`channel-mcp: ${parseMessage(err)}`);
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
          serverInfo: { name: 'dreamux-channel', version: '0.1.0' },
        }));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: channelTools() }));
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

function channelTools(): Array<Record<string, unknown>> {
  return [
    tool('bind_channel', 'Bind an existing Feishu group chat to a Team by team_name (group chats only). After binding, inbound from that chat routes to the Team\'s TeamLeader. channel_id is optional and defaults to the dispatcher\'s configured channel.', {
      team_name: { type: 'string', minLength: 1, maxLength: 64 },
      chat_id: { type: 'string', minLength: 1 },
      channel_id: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['team_name', 'chat_id']),
    tool('transfer_back', 'Return a bound Feishu group chat (by chat_id) to the dispatcher, deactivating the Team binding. channel_id is optional and defaults to the dispatcher\'s configured channel.', {
      chat_id: { type: 'string', minLength: 1 },
      channel_id: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['chat_id']),
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
    case 'bind_channel':
      return { method: 'mcp.channel.bind_channel', params: bindChannelArgs(call.arguments) };
    case 'transfer_back':
      return { method: 'mcp.channel.transfer_back', params: transferArgs(call.arguments) };
    default:
      throw new Error(`unknown Channel tool '${String(call.name)}'`);
  }
}

function bindChannelArgs(value: unknown): Record<string, unknown> {
  // Group-only bind by team_name + Feishu chat id; no `chat_type` (binding is
  // group-only). channel_id is optional (defaults to the sole configured
  // channel); core resolves the (channel_id, target_key) v2 binding key.
  const obj = asRecord(value, 'bind_channel arguments');
  return {
    team_name: requireString(obj, 'team_name'),
    chat_id: requireString(obj, 'chat_id'),
    ...optionalChannelId(obj),
  };
}

function transferArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'transfer_back arguments');
  return { chat_id: requireString(obj, 'chat_id'), ...optionalChannelId(obj) };
}

function optionalChannelId(obj: Record<string, unknown>): Record<string, unknown> {
  const value = obj['channel_id'];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value === '') {
    throw new Error('channel_id must be a non-empty string');
  }
  return { channel_id: value };
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
