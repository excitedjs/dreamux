import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface ChannelMcpOptions {
  dispatcherId: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  /**
   * The channel provider ref this shim serves (e.g. `builtin:feishu`). Advisory
   * only — core resolves the live channel session from the dispatcher id, so the
   * shim never branches on it; it is carried for diagnostics/clarity.
   */
  providerRef?: string;
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

const JSONRPC_VERSION = '2.0';
const DEFAULT_MCP_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export async function runChannelMcp(opts: ChannelMcpOptions): Promise<void> {
  const dispatcherId = validateDispatcherId(opts.dispatcherId);
  const callerKind = opts.callerKind ?? 'dispatcher';
  const socketPath = opts.adminSocketPath ?? defaultAdminSocketPath();
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((message) => console.error(message));
  const logLabel =
    opts.providerRef !== undefined && opts.providerRef !== ''
      ? `channel-mcp[${opts.providerRef}]`
      : 'channel-mcp';
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
        teamId: opts.teamId,
        leaderName: opts.leaderName,
        socketPath,
        output,
      });
    } catch (err) {
      log(`${logLabel}: ${parseMessage(err)}`);
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
    callerKind: 'dispatcher' | 'team_leader';
    teamId?: string;
    leaderName?: string;
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
        write(ctx.output, okResponse(request.id, await listTools(ctx)));
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
      name: 'dreamux-channel',
      version: '0.2.0',
    },
  };
}

/**
 * List the channel's provider-owned tools by forwarding to the generic
 * `channel.list_tools` admin method. Core (the channel provider) is the single
 * source of the tool descriptors — the shim never hardcodes a tool name or
 * schema. Returns the `{ tools }` blob verbatim for the MCP `tools/list` reply.
 */
async function listTools(ctx: {
  dispatcherId: string;
  callerKind: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  socketPath: string;
}): Promise<unknown> {
  return sendAdminRequest(
    'channel.list_tools',
    {
      dispatcher_id: ctx.dispatcherId,
      caller_kind: ctx.callerKind,
      ...(ctx.teamId !== undefined ? { team_id: ctx.teamId } : {}),
      ...(ctx.leaderName !== undefined ? { leader_name: ctx.leaderName } : {}),
    },
    { socketPath: ctx.socketPath },
  );
}

async function callTool(
  params: unknown,
  ctx: {
    dispatcherId: string;
    callerKind: 'dispatcher' | 'team_leader';
    teamId?: string;
    leaderName?: string;
    socketPath: string;
  },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    // The shim is a blind conduit: forward the raw provider-owned
    // `{ name, arguments }` to the generic `channel.invoke_tool` admin method
    // along with the caller scope. Core resolves the live session vs sessionless
    // path and the TeamLeader egress gate — the shim names no tool or selector.
    return forwardToolCall(
      'channel.invoke_tool',
      {
        dispatcher_id: ctx.dispatcherId,
        name: call.name,
        arguments: call.arguments,
        caller_kind: ctx.callerKind,
        ...(ctx.teamId !== undefined ? { team_id: ctx.teamId } : {}),
        ...(ctx.leaderName !== undefined ? { leader_name: ctx.leaderName } : {}),
      },
      ctx.socketPath,
      call.name,
    );
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

function asToolCallParams(params: unknown): { name: string; arguments: unknown } {
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toolError(message: string): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function okResponse(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message },
  };
}

function write(output: Writable, message: Record<string, unknown>): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
