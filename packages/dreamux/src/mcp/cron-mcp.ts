import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { AdminClientError, sendAdminRequest } from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface CronMcpOptions {
  dispatcherId: string;
  teamId?: string;
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

export async function runCronMcp(opts: CronMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const teamId = opts.teamId;
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
      await handleRequest(request, { dispatcherId, teamId, socketPath, output });
    } catch (err) {
      log(`cron-mcp: ${parseMessage(err)}`);
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
    teamId: string | undefined;
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
          serverInfo: { name: 'dreamux-cron', version: '0.3.0' },
        }));
      }
      return;
    case 'initialized':
    case 'notifications/initialized':
      return;
    case 'tools/list':
      if (request.id !== undefined) {
        write(ctx.output, okResponse(request.id, { tools: cronTools() }));
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

export function cronTools(): Array<Record<string, unknown>> {
  return [
    tool('cron_create', 'Create a durable Dreamux cron job for this agent. cron is a standard 5-field local-time expression (M H DoM Mon DoW); prefer off-:00/:30 minutes for approximate schedules. prompt is the text injected into this dispatcher or TeamLeader agent. recurring defaults to true; use recurring:false for one-shot reminders. dreamux jobs are always persisted and do not auto-expire. tz is resolved and stored. Cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.', {
      cron: { type: 'string', minLength: 1, maxLength: 200 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      recurring: { type: 'boolean' },
      tz: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: 'string', minLength: 1, maxLength: 200 },
    }, ['cron', 'prompt']),
    tool('cron_list', 'List durable cron jobs for this agent.', {}, []),
    tool('cron_delete', 'Delete a cron job by id.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['id']),
    tool('cron_update', 'Update a cron job by id. Same behavior as cron_create: cron jobs inject prompts back into this agent; they do not deliver channel messages or spawn agents.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
      cron: { type: 'string', minLength: 1, maxLength: 200 },
      prompt: { type: 'string', minLength: 1, maxLength: 20000 },
      recurring: { type: 'boolean' },
      tz: { type: 'string', minLength: 1, maxLength: 100 },
      title: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
      enabled: { type: 'boolean' },
    }, ['id']),
    tool('cron_run_now', 'Fire one cron job once now, still respecting defer-until-idle.', {
      id: { type: 'string', minLength: 1, maxLength: 128 },
    }, ['id']),
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
  ctx: { dispatcherId: string; teamId: string | undefined; socketPath: string },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    const mapped = mapToolCall(call);
    // The cron target is descriptor-bound, NOT model-supplied: strip any
    // dispatcher_id/team_id the tool arguments tried to inject, then apply the
    // process-scoped binding LAST so it always wins. Otherwise a TeamLeader cron
    // MCP could pass an extra team_id (or any cron MCP an extra dispatcher_id) to
    // reach another scheduler, breaking the per-conversational-agent boundary.
    const safeParams = { ...mapped.params };
    delete safeParams['dispatcher_id'];
    delete safeParams['team_id'];
    const result = await sendAdminRequest(
      mapped.method,
      {
        ...safeParams,
        dispatcher_id: ctx.dispatcherId,
        ...(ctx.teamId !== undefined ? { team_id: ctx.teamId } : {}),
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

function mapToolCall(call: ToolCall): { method: string; params: Record<string, unknown> } {
  switch (call.name) {
    case 'cron_create':
      return { method: 'scheduler.cron.create', params: asRecord(call.arguments, 'cron_create arguments') };
    case 'cron_list':
      return { method: 'scheduler.cron.list', params: {} };
    case 'cron_delete':
      return { method: 'scheduler.cron.delete', params: idArgs(call.arguments) };
    case 'cron_update':
      return { method: 'scheduler.cron.update', params: asRecord(call.arguments, 'cron_update arguments') };
    case 'cron_run_now':
      return { method: 'scheduler.cron.run_now', params: idArgs(call.arguments) };
    default:
      throw new Error(`unknown cron tool '${String(call.name)}'`);
  }
}

function idArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'arguments');
  return { id: requireString(obj, 'id') };
}

function asToolCallParams(params: unknown): ToolCall {
  const obj = asRecord(params, 'tools/call params');
  const name = requireString(obj, 'name');
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
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function okResponse(id: string | number | null, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result })}\n`;
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): string {
  return `${JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  })}\n`;
}

function write(output: Writable, line: string): void {
  output.write(line);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
