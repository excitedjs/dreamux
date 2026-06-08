import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface TeamMateMcpOptions {
  dispatcherId: string;
  callerKind: 'dispatcher' | 'teammate';
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
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export async function runTeamMateMcp(opts: TeamMateMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const callerKind = validateCallerKind(opts.callerKind);
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
      await handleRequest(request, {
        dispatcherId,
        callerKind,
        socketPath,
        output,
      });
    } catch (err) {
      log(`teammate-mcp: ${parseMessage(err)}`);
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
    callerKind: 'dispatcher' | 'teammate';
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
        write(ctx.output, okResponse(request.id, initializeResult(request.params)));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: teammateTools(ctx.callerKind) }));
      }
      return;
    case 'tools/call':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, await callTool(request.params, ctx)));
      }
      return;
    default:
      if (request.id !== undefined) {
        write(
          ctx.output,
          errorResponse(request.id, -32601, `unknown MCP method '${request.method}'`),
        );
      }
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  return {
    protocolVersion: negotiateProtocolVersion(params),
    capabilities: { tools: {} },
    serverInfo: { name: 'dreamux-teammate', version: '0.3.0' },
  };
}

function teammateTools(callerKind: 'dispatcher' | 'teammate'): Array<Record<string, unknown>> {
  const readTools = [
    tool('history', 'Read the forward-only history for one TeamMate.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name']),
    tool('list', 'List this dispatcher\'s TeamMate identities.', {}, []),
    tool('status', 'Read one TeamMate identity and live runtime status.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name']),
    tool('last', 'Read the last visible result reported by one TeamMate runtime.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name']),
    tool('ctx', 'Read one TeamMate runtime context-window snapshot.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
    }, ['name']),
    tool('get_capabilities', 'List TeamMate runtime capabilities and verbs.', {}, []),
  ];
  if (callerKind !== 'dispatcher') return readTools;
  return [
    tool('spawn', 'Start a named, resumable TeamMate agent and submit its first turn.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      agent_runtime: { type: 'string' },
      cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    }, ['name', 'prompt']),
    tool('send', 'Send a follow-up turn to a running or resumable TeamMate agent.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    }, ['name', 'prompt']),
    tool('resume', 'Resume a named TeamMate session, optionally with a follow-up prompt.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
    }, ['name']),
    tool('close', 'Close a named TeamMate agent and retain its history for resume/audit.', {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      note: { type: 'string', maxLength: 2000 },
    }, ['name']),
    ...readTools,
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
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
  };
}

async function callTool(
  params: unknown,
  ctx: {
    dispatcherId: string;
    callerKind: 'dispatcher' | 'teammate';
    socketPath: string;
  },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    if (ctx.callerKind !== 'dispatcher' && isLifecycleTool(call.name)) {
      return toolError(`TeamMate tool '${call.name}' is not available to teammates`);
    }
    const mapped = mapToolCall(call);
    return forwardToolCall(
      mapped.method,
      { dispatcher_id: ctx.dispatcherId, ...mapped.params },
      ctx.socketPath,
      call.name,
    );
  } catch (err) {
    return toolError(parseMessage(err));
  }
}

function mapToolCall(call: ToolCall): {
  method: string;
  params: Record<string, unknown>;
} {
  switch (call.name) {
    case 'spawn':
      return { method: 'mcp.teammate.spawn', params: spawnArgs(call.arguments) };
    case 'send':
      return { method: 'mcp.teammate.send', params: sendArgs(call.arguments) };
    case 'resume':
      return { method: 'mcp.teammate.resume', params: resumeArgs(call.arguments) };
    case 'close':
      return { method: 'mcp.teammate.close', params: closeArgs(call.arguments) };
    case 'history':
      return { method: 'mcp.teammate.history', params: nameArgs(call.arguments) };
    case 'list':
      return { method: 'mcp.teammate.list', params: {} };
    case 'status':
      return { method: 'mcp.teammate.status', params: nameArgs(call.arguments) };
    case 'last':
      return { method: 'mcp.teammate.last', params: nameArgs(call.arguments) };
    case 'ctx':
      return { method: 'mcp.teammate.ctx', params: nameArgs(call.arguments) };
    case 'get_capabilities':
      return { method: 'mcp.teammate.capabilities', params: {} };
    default:
      throw new Error(`unknown TeamMate tool '${String(call.name)}'`);
  }
}

function isLifecycleTool(name: string): boolean {
  return name === 'spawn' || name === 'send' || name === 'resume' || name === 'close';
}

function negotiateProtocolVersion(params: unknown): string {
  const requested =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)['protocolVersion']
      : undefined;
  if (
    typeof requested === 'string' &&
    SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
  ) {
    return requested;
  }
  return DEFAULT_MCP_PROTOCOL_VERSION;
}

async function forwardToolCall(
  method: string,
  params: Record<string, unknown>,
  socketPath: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await sendAdminRequest(method, params, { socketPath });
    return {
      content: [{ type: 'text', text: `${label} forwarded to dreamux serve` }],
      structuredContent: result,
    };
  } catch (err) {
    const prefix = err instanceof AdminClientError ? `[${err.code}] ` : '';
    return toolError(`${prefix}${parseMessage(err)}`);
  }
}

function asToolCallParams(params: unknown): ToolCall {
  const obj = asRecord(params, 'tools/call params');
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('tools/call params.name must be a non-empty string');
  }
  return { name, arguments: obj['arguments'] ?? {} };
}

function spawnArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'spawn arguments');
  const agentRuntime = optionalString(obj, 'agent_runtime');
  const cwd = optionalString(obj, 'cwd');
  return {
    name: requireString(obj, 'name'),
    prompt: requireString(obj, 'prompt'),
    ...(agentRuntime !== null ? { agent_runtime: agentRuntime } : {}),
    ...(cwd !== null ? { cwd } : {}),
  };
}

function sendArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'send arguments');
  return {
    name: requireString(obj, 'name'),
    prompt: requireString(obj, 'prompt'),
  };
}

function resumeArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'resume arguments');
  const prompt = optionalString(obj, 'prompt');
  return {
    name: requireString(obj, 'name'),
    ...(prompt !== null ? { prompt } : {}),
  };
}

function closeArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'close arguments');
  const note = optionalString(obj, 'note');
  return {
    name: requireString(obj, 'name'),
    ...(note !== null ? { note } : {}),
  };
}

function nameArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { name: requireString(obj, 'name') };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
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

function errorResponse(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
): string {
  return `${JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  })}\n`;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function write(output: Writable, line: string): void {
  output.write(line);
}

function validateCallerKind(value: string): 'dispatcher' | 'teammate' {
  if (value === 'dispatcher' || value === 'teammate') return value;
  throw new Error("caller kind must be 'dispatcher' or 'teammate'");
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
