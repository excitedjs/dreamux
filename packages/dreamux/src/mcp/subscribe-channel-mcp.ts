import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';

export interface SubscribeChannelMcpOptions {
  dispatcherId: string;
  providerRef?: string;
  subscriptionId: string;
  tools?: readonly unknown[];
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

export async function runSubscribeChannelMcp(
  opts: SubscribeChannelMcpOptions,
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
      await handleRequest(request, {
        dispatcherId,
        providerRef: opts.providerRef,
        subscriptionId: opts.subscriptionId,
        tools: opts.tools ?? [],
        socketPath,
        output,
      });
    } catch (err) {
      log(`subscribe-channel-mcp: ${parseMessage(err)}`);
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
    providerRef?: string;
    subscriptionId: string;
    tools: readonly unknown[];
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
        write(ctx.output, okResponse(request.id, { tools: ctx.tools }));
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
    capabilities: { tools: {} },
    serverInfo: {
      name: 'dreamux-subscribe-channel',
      version: '0.2.0',
    },
  };
}

async function callTool(
  params: unknown,
  ctx: {
    dispatcherId: string;
    providerRef?: string;
    subscriptionId: string;
    socketPath: string;
  },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    return forwardToolCall(
      {
        dispatcher_id: ctx.dispatcherId,
        subscription_id: ctx.subscriptionId,
        name: call.name,
        arguments: call.arguments,
        ...(ctx.providerRef !== undefined ? { provider_ref: ctx.providerRef } : {}),
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
  params: Record<string, unknown>,
  socketPath: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    const result = await sendAdminRequest('subscribe_channel.invoke_tool', params, {
      socketPath,
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

function okResponse(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function write(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
