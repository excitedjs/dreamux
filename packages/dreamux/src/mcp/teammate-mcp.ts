import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../runtime/paths.js';
import { validateDispatcherId } from '../runtime/dispatcher-id.js';
import type { TeamMateScheduleCallerKind } from '../teammate/ledger.js';

export interface TeamMateMcpOptions {
  dispatcherId: string;
  callerKind: TeamMateScheduleCallerKind;
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

interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
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
    callerKind: TeamMateScheduleCallerKind;
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
        write(
          ctx.output,
          okResponse(request.id, initializeResult(request.params)),
        );
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: teammateTools() }));
      }
      return;
    case 'tools/call':
      if (request.id !== undefined) {
        write(
          ctx.output,
          okResponse(request.id, await callTool(request.params, ctx)),
        );
      }
      return;
    default:
      if (request.id !== undefined) {
        write(
          ctx.output,
          errorResponse(
            request.id,
            -32601,
            `unknown MCP method '${request.method}'`,
          ),
        );
      }
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  return {
    protocolVersion: negotiateProtocolVersion(params),
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'dreamux-teammate',
      version: '0.2.0',
    },
  };
}

function teammateTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'schedule',
      description:
        'Accept a server-hosted TeamMate task for this dispatcher and return immediately with a task id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Short task title for the server ledger.',
          },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description: 'Task brief for the TeamMate.',
          },
          teammate_id: {
            type: 'string',
            description: 'Optional stable TeamMate id requested by the dispatcher.',
          },
        },
        required: ['title', 'prompt'],
      },
    },
    {
      name: 'list_tasks',
      description:
        'List this dispatcher\'s TeamMate tasks and their statuses (no result bodies).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'get_task',
      description:
        'Fetch one TeamMate task in full, including its result, delivery state, and history.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', description: 'The task id to fetch.' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'pull_result',
      description:
        'Pull a retained TeamMate result — the fallback when push delivery failed. ' +
        'Omit task_id for the latest result-bearing task.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: {
            type: 'string',
            description: 'Optional task id; defaults to the latest result.',
          },
        },
      },
    },
  ];
}

async function callTool(
  params: unknown,
  ctx: {
    dispatcherId: string;
    callerKind: TeamMateScheduleCallerKind;
    socketPath: string;
  },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    if (call.name === 'schedule') {
      return forwardToolCall(
        'mcp.teammate.schedule',
        {
          dispatcher_id: ctx.dispatcherId,
          caller_kind: ctx.callerKind,
          ...scheduleArgs(call.arguments),
        },
        ctx.socketPath,
        'schedule',
      );
    }
    if (call.name === 'list_tasks') {
      return forwardToolCall(
        'mcp.teammate.list',
        { dispatcher_id: ctx.dispatcherId },
        ctx.socketPath,
        'list_tasks',
      );
    }
    if (call.name === 'get_task') {
      return forwardToolCall(
        'mcp.teammate.get',
        { dispatcher_id: ctx.dispatcherId, ...getTaskArgs(call.arguments) },
        ctx.socketPath,
        'get_task',
      );
    }
    if (call.name === 'pull_result') {
      return forwardToolCall(
        'mcp.teammate.pull',
        { dispatcher_id: ctx.dispatcherId, ...pullArgs(call.arguments) },
        ctx.socketPath,
        'pull_result',
      );
    }
    return toolError(`unknown TeamMate tool '${String(call.name)}'`);
  } catch (err) {
    return toolError(parseMessage(err));
  }
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

function asToolCallParams(params: unknown): Required<ToolCallParams> {
  const obj = asRecord(params, 'tools/call params');
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    throw new Error('tools/call params.name must be a non-empty string');
  }
  return {
    name,
    arguments: obj['arguments'] ?? {},
  };
}

function scheduleArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'schedule arguments');
  const teammateId = optionalString(obj, 'teammate_id');
  return {
    title: requireString(obj, 'title'),
    prompt: requireString(obj, 'prompt'),
    ...(teammateId !== null ? { teammate_id: teammateId } : {}),
  };
}

function getTaskArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'get_task arguments');
  return { task_id: requireString(obj, 'task_id') };
}

function pullArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'pull_result arguments');
  const taskId = optionalString(obj, 'task_id');
  return taskId !== null ? { task_id: taskId } : {};
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function validateCallerKind(
  value: TeamMateScheduleCallerKind,
): TeamMateScheduleCallerKind {
  if (value === 'dispatcher' || value === 'teammate') return value;
  throw new Error(`unsupported TeamMate MCP caller kind: ${String(value)}`);
}

function okResponse(
  id: string | number | null,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function toolError(message: string): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function write(output: Writable, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
