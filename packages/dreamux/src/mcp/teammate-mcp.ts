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
      name: 'run_task',
      description:
        'Create and execute a server-hosted TeamMate task in a local target. ' +
        'Returns once the task is created and a worker session is started; the ' +
        'execution sub-result reports running (then completed/failed via the ' +
        'ledger). The default Codex worker executes for real. If no worker is ' +
        'wired or the chosen provider is unavailable, the execution sub-result ' +
        'reports provider_unavailable (retryable) while the task is still ' +
        'created durably.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          prompt: { type: 'string', minLength: 1, maxLength: 20000 },
          target: {
            type: 'object',
            additionalProperties: false,
            description:
              'Local execution target. path may be absolute or relative to ' +
              'the dispatcher directory; it is resolved and confined there.',
            properties: {
              kind: { type: 'string', enum: ['path'] },
              path: { type: 'string', minLength: 1, maxLength: 4096 },
            },
            required: ['path'],
          },
          teammate_id: {
            type: 'string',
            description: 'Optional stable TeamMate id for cross-task identity.',
          },
          intent: { type: 'string', maxLength: 200 },
          target_mode: {
            type: 'string',
            enum: ['managed_worktree', 'in_place'],
          },
          provider_ref: {
            type: 'string',
            description:
              'Worker to execute on; defaults to builtin:codex. Pin ' +
              'builtin:claude-code to run on the Claude Code worker. Consult ' +
              "get_capabilities for each worker's advertised modes " +
              '(builtin:claude-code is single-turn, steer:false).',
          },
          operation_id: {
            type: 'string',
            description: 'Idempotency key; replaying returns the prior task.',
          },
        },
        required: ['title', 'prompt', 'target'],
      },
    },
    {
      name: 'execute_task',
      description:
        'Start or retry execution for an accepted TeamMate task. Reports ' +
        'running once a worker session is live (the default Codex worker runs ' +
        'for real); a task with no worker wired or an unavailable provider ' +
        'reports provider_unavailable (retryable).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          provider_ref: {
            type: 'string',
            description:
              'Worker to execute on; defaults to builtin:codex. Pin ' +
              'builtin:claude-code to run on the Claude Code worker (see ' +
              'get_capabilities).',
          },
          target_mode: {
            type: 'string',
            enum: ['managed_worktree', 'in_place'],
          },
          operation_id: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'send_input',
      description:
        'Send a follow-up input to a steerable TeamMate task session. Default ' +
        'mode is steer; queue and interrupt are explicit. On a worker that ' +
        'advertises steer (builtin:codex) it folds into the live turn and is ' +
        'submitted; on a single-turn worker (builtin:claude-code, steer:false) ' +
        'or with no live session the input is recorded as queued for a future ' +
        'worker. See get_capabilities.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          prompt: { type: 'string', minLength: 1, maxLength: 20000 },
          mode: { type: 'string', enum: ['steer', 'queue', 'interrupt'] },
          operation_id: { type: 'string' },
        },
        required: ['task_id', 'prompt'],
      },
    },
    // No await_completion tool: normal orchestration is run_task → the dispatcher
    // turn ends → the server delivers/wakes the dispatcher into a new turn. The
    // dispatcher must not poll or hold a turn open waiting (issue #126 PR8). The
    // ledger read tools (get_task / pull_result) are the recovery path; the
    // server keeps an internal wait primitive for its own use and tests only.
    {
      name: 'cancel_task',
      description:
        'Cancel a TeamMate task without shelling out to kill a worker process. ' +
        'A live worker is stopped and its resources reaped; a not-yet-running or ' +
        'orphaned task is closed in the ledger. An already-finished task is an ' +
        'idempotent no-op (status already_terminal). The task closes as ' +
        'cancelled; pass note for a short reason.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          note: {
            type: 'string',
            maxLength: 2000,
            description: 'Optional short reason recorded with the cancellation.',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'get_task_logs',
      description:
        'Read a bounded tail of a TeamMate worker\'s diagnostic logs to inspect ' +
        'a slow or failed worker without tailing a file in a shell. Returns ' +
        'worker stderr and, for builtin:codex, app-server stdout protocol frames ' +
        'plus an "events" trace of the Codex turn notification stream (the ' +
        'actionable diagnostic when a turn stalls after submission) — NOT the ' +
        'clean result, which comes from get_task / pull_result. Streams are ' +
        'empty until the worker has run.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          max_bytes: {
            type: 'number',
            description:
              'Bytes to return per stream (tail). Defaults to 16384; capped at ' +
              '131072.',
          },
          stream: {
            type: 'string',
            enum: ['stdout', 'stderr', 'events'],
            description: 'Restrict to one stream; default returns all available.',
          },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'get_capabilities',
      description:
        'List server and runtime TeamMate capabilities (read-only). Each ' +
        'provider reports whether worker execution is available and its modes; ' +
        'the builtin:codex (steer) and builtin:claude-code (single-turn, ' +
        'steer:false) workers are available by default, while a runtime without ' +
        'a worker (or an explicitly empty catalog) reports it unavailable.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
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
    if (call.name === 'run_task') {
      return forwardToolCall(
        'mcp.teammate.run',
        {
          dispatcher_id: ctx.dispatcherId,
          caller_kind: ctx.callerKind,
          ...runArgs(call.arguments),
        },
        ctx.socketPath,
        'run_task',
      );
    }
    if (call.name === 'execute_task') {
      return forwardToolCall(
        'mcp.teammate.execute',
        { dispatcher_id: ctx.dispatcherId, ...executeArgs(call.arguments) },
        ctx.socketPath,
        'execute_task',
      );
    }
    if (call.name === 'send_input') {
      return forwardToolCall(
        'mcp.teammate.send_input',
        { dispatcher_id: ctx.dispatcherId, ...sendInputArgs(call.arguments) },
        ctx.socketPath,
        'send_input',
      );
    }
    if (call.name === 'cancel_task') {
      return forwardToolCall(
        'mcp.teammate.cancel',
        { dispatcher_id: ctx.dispatcherId, ...cancelArgs(call.arguments) },
        ctx.socketPath,
        'cancel_task',
      );
    }
    if (call.name === 'get_task_logs') {
      return forwardToolCall(
        'mcp.teammate.logs',
        { dispatcher_id: ctx.dispatcherId, ...logsArgs(call.arguments) },
        ctx.socketPath,
        'get_task_logs',
      );
    }
    if (call.name === 'get_capabilities') {
      return forwardToolCall(
        'mcp.teammate.capabilities',
        { dispatcher_id: ctx.dispatcherId },
        ctx.socketPath,
        'get_capabilities',
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
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  try {
    const result = await sendAdminRequest(method, params, {
      socketPath,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
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

function runArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'run_task arguments');
  const target = asRecord(obj['target'], 'run_task target');
  const teammateId = optionalString(obj, 'teammate_id');
  const intent = optionalString(obj, 'intent');
  const targetMode = optionalString(obj, 'target_mode');
  const providerRef = optionalString(obj, 'provider_ref');
  const operationId = optionalString(obj, 'operation_id');
  return {
    title: requireString(obj, 'title'),
    prompt: requireString(obj, 'prompt'),
    target_path: requireString(target, 'path'),
    ...(teammateId !== null ? { teammate_id: teammateId } : {}),
    ...(intent !== null ? { intent } : {}),
    ...(targetMode !== null ? { target_mode: targetMode } : {}),
    ...(providerRef !== null ? { provider_ref: providerRef } : {}),
    ...(operationId !== null ? { operation_id: operationId } : {}),
  };
}

function executeArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'execute_task arguments');
  const providerRef = optionalString(obj, 'provider_ref');
  const targetMode = optionalString(obj, 'target_mode');
  const operationId = optionalString(obj, 'operation_id');
  return {
    task_id: requireString(obj, 'task_id'),
    ...(providerRef !== null ? { provider_ref: providerRef } : {}),
    ...(targetMode !== null ? { target_mode: targetMode } : {}),
    ...(operationId !== null ? { operation_id: operationId } : {}),
  };
}

function sendInputArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'send_input arguments');
  const mode = optionalString(obj, 'mode');
  const operationId = optionalString(obj, 'operation_id');
  return {
    task_id: requireString(obj, 'task_id'),
    prompt: requireString(obj, 'prompt'),
    ...(mode !== null ? { mode } : {}),
    ...(operationId !== null ? { operation_id: operationId } : {}),
  };
}

function cancelArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'cancel_task arguments');
  const note = optionalString(obj, 'note');
  return {
    task_id: requireString(obj, 'task_id'),
    ...(note !== null ? { note } : {}),
  };
}

function logsArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'get_task_logs arguments');
  const maxBytes = optionalNumber(obj, 'max_bytes');
  const stream = optionalString(obj, 'stream');
  return {
    task_id: requireString(obj, 'task_id'),
    ...(maxBytes !== null ? { max_bytes: maxBytes } : {}),
    ...(stream !== null ? { stream } : {}),
  };
}


function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
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
