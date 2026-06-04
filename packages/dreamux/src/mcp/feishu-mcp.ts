import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  AdminClientError,
  sendAdminRequest,
} from '../admin/client.js';
import { adminSocketPath as defaultAdminSocketPath } from '../runtime/paths.js';
import { validateDispatcherId } from '../runtime/dispatcher-id.js';

export interface FeishuMcpOptions {
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

export async function runFeishuMcp(opts: FeishuMcpOptions): Promise<void> {
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
        socketPath,
        output,
      });
    } catch (err) {
      log(`feishu-mcp: ${parseMessage(err)}`);
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
        write(ctx.output, okResponse(request.id, { tools: feishuTools() }));
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
      name: 'dreamux-feishu',
      version: '0.2.0',
    },
  };
}

function feishuTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'reply',
      description: 'Send a Feishu message through this dispatcher channel.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: {
            type: 'string',
            description: 'Feishu chat id from the inbound feishu_message block.',
          },
          message_id: {
            type: 'string',
            description: 'Optional source message id to reply under.',
          },
          text: {
            type: 'string',
            description: 'Message text to send.',
          },
          mention_user_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional Feishu user ids to mention.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add a model-owned Feishu reaction through this dispatcher channel.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: {
            type: 'string',
            description: 'Feishu message id to react to.',
          },
          emoji: {
            type: 'string',
            description: 'Feishu reaction emoji key.',
          },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'list_chat_bots',
      description:
        'List the peer bots known and trusted in a Feishu group chat (names + open_ids). Use to recover bot identities after a context compaction.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: {
            type: 'string',
            description: 'Feishu chat id from the inbound feishu_message block.',
          },
        },
        required: ['chat_id'],
      },
    },
  ];
}

async function callTool(
  params: unknown,
  ctx: { dispatcherId: string; socketPath: string },
): Promise<Record<string, unknown>> {
  try {
    const call = asToolCallParams(params);
    if (call.name === 'reply') {
      return forwardToolCall(
        'mcp.reply',
        {
          dispatcher_id: ctx.dispatcherId,
          ...replyArgs(call.arguments),
        },
        ctx.socketPath,
        'reply',
      );
    }
    if (call.name === 'react') {
      return forwardToolCall(
        'mcp.react',
        {
          dispatcher_id: ctx.dispatcherId,
          ...reactArgs(call.arguments),
        },
        ctx.socketPath,
        'react',
      );
    }
    if (call.name === 'list_chat_bots') {
      return forwardToolCall(
        'mcp.list_chat_bots',
        {
          dispatcher_id: ctx.dispatcherId,
          ...listChatBotsArgs(call.arguments),
        },
        ctx.socketPath,
        'list_chat_bots',
      );
    }
    return toolError(`unknown Feishu tool '${String(call.name)}'`);
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

function replyArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'reply arguments');
  const chatId = requireString(obj, 'chat_id');
  const text = requireString(obj, 'text');
  const messageId = optionalString(obj, 'message_id');
  const mentionUserIds = optionalStringArray(obj, 'mention_user_ids');
  return {
    chat_id: chatId,
    text,
    ...(messageId !== null ? { message_id: messageId } : {}),
    ...(mentionUserIds !== null ? { mention_user_ids: mentionUserIds } : {}),
  };
}

function reactArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'react arguments');
  return {
    message_id: requireString(obj, 'message_id'),
    emoji: requireString(obj, 'emoji'),
  };
}

function listChatBotsArgs(value: unknown): Record<string, unknown> {
  const obj = asRecord(value, 'list_chat_bots arguments');
  return {
    chat_id: requireString(obj, 'chat_id'),
  };
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
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
): string[] | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
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
