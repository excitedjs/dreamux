import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '../../agent-runtime/types.js';

export const FEISHU_MCP_SERVER_NAME = 'feishu';

export interface FeishuMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export type FeishuMcpToolName = 'reply' | 'react' | 'list_chat_bots';

export interface FeishuMcpReplyInput {
  chatId: string;
  text: string;
  messageId?: string;
  mentionUserIds?: string[];
}

export interface FeishuMcpReactInput {
  chatId?: string;
  messageId: string;
  emoji: string;
}

export interface FeishuMcpListChatBotsInput {
  chatId: string;
}

export type FeishuMcpToolInput =
  | { toolName: 'reply'; input: FeishuMcpReplyInput }
  | { toolName: 'react'; input: FeishuMcpReactInput }
  | { toolName: 'list_chat_bots'; input: FeishuMcpListChatBotsInput };

export function feishuMcpServerDescriptor(
  opts: FeishuMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: FEISHU_MCP_SERVER_NAME,
    command,
    args: [
      'feishu-mcp',
      '--dispatcher',
      opts.dispatcherId,
      ...(opts.callerKind !== undefined ? ['--caller', opts.callerKind] : []),
      ...(opts.teamId !== undefined ? ['--team-id', opts.teamId] : []),
      ...(opts.leaderName !== undefined ? ['--leader-name', opts.leaderName] : []),
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}

export function feishuMcpTools(): Array<Record<string, unknown>> {
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
            description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
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
          chat_id: {
            type: 'string',
            description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
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
            description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
          },
        },
        required: ['chat_id'],
      },
    },
  ];
}

export function parseFeishuMcpToolInput(
  toolName: string,
  value: unknown,
): FeishuMcpToolInput {
  if (toolName === 'reply') {
    return { toolName, input: replyArgs(value) };
  }
  if (toolName === 'react') {
    return { toolName, input: reactArgs(value) };
  }
  if (toolName === 'list_chat_bots') {
    return { toolName, input: listChatBotsArgs(value) };
  }
  throw new Error(`unknown Feishu tool '${toolName}'`);
}

export function feishuMcpAdminMethod(toolName: FeishuMcpToolName): string {
  switch (toolName) {
    case 'reply':
      return 'mcp.reply';
    case 'react':
      return 'mcp.react';
    case 'list_chat_bots':
      return 'mcp.list_chat_bots';
  }
}

export function feishuMcpAdminLabel(toolName: FeishuMcpToolName): string {
  return toolName === 'list_chat_bots' ? 'list_chat_bots' : toolName;
}

export function feishuMcpAdminParams(
  dispatcherId: string,
  parsed: FeishuMcpToolInput,
): Record<string, unknown> {
  switch (parsed.toolName) {
    case 'reply':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
        text: parsed.input.text,
        ...(parsed.input.messageId !== undefined
          ? { message_id: parsed.input.messageId }
          : {}),
        ...(parsed.input.mentionUserIds !== undefined
          ? { mention_user_ids: parsed.input.mentionUserIds }
          : {}),
      };
    case 'react':
      return {
        dispatcher_id: dispatcherId,
        ...(parsed.input.chatId !== undefined ? { chat_id: parsed.input.chatId } : {}),
        message_id: parsed.input.messageId,
        emoji: parsed.input.emoji,
      };
    case 'list_chat_bots':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
      };
  }
}

function replyArgs(value: unknown): FeishuMcpReplyInput {
  const obj = asRecord(value, 'reply arguments');
  const chatId = requireString(obj, 'chat_id');
  const text = requireString(obj, 'text');
  const messageId = optionalString(obj, 'message_id');
  const mentionUserIds = optionalStringArray(obj, 'mention_user_ids');
  return {
    chatId,
    text,
    ...(messageId !== null ? { messageId } : {}),
    ...(mentionUserIds !== null ? { mentionUserIds } : {}),
  };
}

function reactArgs(value: unknown): FeishuMcpReactInput {
  const obj = asRecord(value, 'react arguments');
  const chatId = optionalString(obj, 'chat_id');
  return {
    ...(chatId !== null ? { chatId } : {}),
    messageId: requireString(obj, 'message_id'),
    emoji: requireString(obj, 'emoji'),
  };
}

function listChatBotsArgs(value: unknown): FeishuMcpListChatBotsInput {
  const obj = asRecord(value, 'list_chat_bots arguments');
  return {
    chatId: requireString(obj, 'chat_id'),
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
