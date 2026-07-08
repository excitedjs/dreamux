import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface CollaborationSpaceMcpOptions {
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

export async function runCollaborationSpaceMcp(
  opts: CollaborationSpaceMcpOptions,
): Promise<void> {
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
      log(`collaboration-space-mcp: ${parseMessage(err)}`);
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
          serverInfo: { name: 'dreamux-collaboration-space', version: '0.3.0' },
        }));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: collaborationSpaceTools() }));
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

export function collaborationSpaceTools(): Array<Record<string, unknown>> {
  return [
    tool('bind', 'Bind an existing external collaboration space to a repository. If the space is unknown, pass container to register its provider-owned opaque container selector. bind does not create the external group and does not create a Team immediately; future targets in the bound space create Teams automatically.', {
      channel_id: { type: 'string', minLength: 1, maxLength: 64 },
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
      container: {
        type: 'object',
        additionalProperties: false,
        properties: {
          container_type: { type: 'string', minLength: 1, maxLength: 128 },
          container_key: { type: 'string', minLength: 1, maxLength: 512 },
          display: { type: 'string', minLength: 1, maxLength: 512 },
          canonical_url: { type: 'string', minLength: 1, maxLength: 2048 },
          meta: { type: 'object' },
        },
        required: ['container_type', 'container_key'],
      },
      display: { type: 'string', minLength: 1, maxLength: 512 },
      repo: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', minLength: 1, maxLength: 4096 },
          base_ref: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['cwd'],
      },
      leader_agent_runtime: { type: 'string', minLength: 1, maxLength: 128 },
      identity: { type: 'string', minLength: 1, maxLength: 4000 },
    }, ['space_name', 'repo', 'leader_agent_runtime']),
    tool('dissolve', 'Unbind a collaboration space from Dreamux routing and provisioning. The external space remains in the provider, already-created Teams are not dissolved, and later deliveries fall back to the dispatcher unless the space is bound again.', {
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['space_name', 'note']),
    tool('status', 'Read one collaboration space and a compact summary of its provisioned targets.', {
      space_name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['space_name']),
    tool('list', 'List known collaboration spaces and their current binding state.', {}, []),
  ];
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
      {
        dispatcher_id: ctx.dispatcherId,
        ...mapped.params,
      },
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

function mapToolCall(
  call: ToolCall,
): { method: string; params: Record<string, unknown> } {
  switch (call.name) {
    case 'bind':
      return { method: 'mcp.collaboration_space.bind', params: bindArgs(call.arguments) };
    case 'dissolve':
      return { method: 'mcp.collaboration_space.dissolve', params: dissolveArgs(call.arguments) };
    case 'status':
      return { method: 'mcp.collaboration_space.status', params: spaceNameArgs(call.arguments) };
    case 'list':
      return { method: 'mcp.collaboration_space.list', params: {} };
    default:
      throw new Error(`unknown collaboration_space tool '${String(call.name)}'`);
  }
}

function bindArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'bind arguments');
  const channelId = optionalString(obj, 'channel_id');
  const container = optionalRecord(obj, 'container');
  const display = optionalString(obj, 'display');
  const identity = optionalString(obj, 'identity');
  return {
    space_name: requireString(obj, 'space_name'),
    ...(channelId !== null ? { channel_id: channelId } : {}),
    ...(container !== null ? { container: containerArgs(container) } : {}),
    ...(display !== null ? { display } : {}),
    repo: repoArgs(requireRecord(obj, 'repo')),
    leader_agent_runtime: requireString(obj, 'leader_agent_runtime'),
    ...(identity !== null ? { identity } : {}),
  };
}

function dissolveArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'dissolve arguments');
  return {
    space_name: requireString(obj, 'space_name'),
    note: requireString(obj, 'note'),
  };
}

function spaceNameArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { space_name: requireString(obj, 'space_name') };
}

function containerArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const display = optionalString(obj, 'display');
  const canonicalUrl = optionalString(obj, 'canonical_url');
  const meta = optionalRecord(obj, 'meta');
  return {
    container_type: requireString(obj, 'container_type'),
    container_key: requireString(obj, 'container_key'),
    ...(display !== null ? { display } : {}),
    ...(canonicalUrl !== null ? { canonical_url: canonicalUrl } : {}),
    ...(meta !== null ? { meta } : {}),
  };
}

function repoArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const baseRef = optionalString(obj, 'base_ref');
  return {
    cwd: requireString(obj, 'cwd'),
    ...(baseRef !== null ? { base_ref: baseRef } : {}),
  };
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

function asToolCallParams(params: unknown): ToolCall {
  const obj = asRecord(params, 'tools/call params');
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('tools/call params.name must be a non-empty string');
  }
  return { name, arguments: obj['arguments'] ?? {} };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function optionalRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
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
