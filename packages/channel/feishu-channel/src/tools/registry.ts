/**
 * Centralized Feishu MCP tool registry.
 *
 * Each tool ships its own:
 *   - JSON-schema descriptor (for `tools/list`)
 *   - raw-args validator / parser (pure, no state)
 *   - `handle(ctx, input)` — performs the tool action against a `FeishuToolContext`
 *
 * The `FEISHU_TOOLS` array is the single source of truth for the Feishu MCP
 * surface: `provider.ts` builds the `tools/list` catalog from it via
 * `buildToolCatalog`, and the live session in `feishu-channel.ts` dispatches
 * through it (replacing the old per-tool switch block).
 */

import type {
  ChannelToolAnnotations,
  ChannelToolDescriptor,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { PeerBot } from '../chat-bots-store.js';
import type { WireChatBot } from '../feishu-channel.js';

/** Logger shape used by the Feishu channel session — pino-style, fields-first. */
export type ChannelLogger = DreamuxLogger;

export type FeishuToolName = 'reply' | 'react' | 'list_chat_bots';

/**
 * Minimal context each tool handler runs against. The session adapter builds
 * this at invoke time, so tool definitions never import the full
 * `FeishuChannelSession` directly — keeping parse + handlers pure-unit
 * testable.
 */
export interface FeishuToolContext {
  stateDir: string;
  session: {
    logger: ChannelLogger;
    /**
     * Send a plain-text message to a Feishu chat. `rootId` (when supplied) is
     * the source message_id to thread the reply under, mirroring the SDK's
     * `root_id` / reply-in-thread semantics.
     */
    sendText: (
      chatId: string,
      text: string,
      opts?: { messageId?: string; mentionUserIds?: string[] },
    ) => Promise<{ message_ids: string[] }>;
    /**
     * Add a reaction to a Feishu message. `chatId` is optional because some
     * reaction SDK endpoints key only by message_id.
     */
    react: (chatId: string | undefined, messageId: string, emoji: string) => Promise<{ reaction_id: string }>;
    /** List the peer bots observed in a given chat (names + open_ids). */
    listKnownChatBots: (chatId: string) => Promise<FeishuMcpListChatBotsResultInternal>;
  };
}

export interface FeishuMcpListChatBotsResultInternal {
  chat_id: string;
  known: WireChatBot[];
  trusted: WireChatBot[];
}

export type FeishuToolResult =
  | { message_ids: string[] }
  | { reaction_id: string }
  | FeishuMcpListChatBotsResultInternal;

/** @deprecated Feishu tools now return their canonical result directly. */
export type FeishuToolResultEnvelope = FeishuToolResult;

export interface FeishuToolDef<TInput = unknown> {
  name: FeishuToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ChannelToolAnnotations;
  parse(raw: unknown): TInput;
  handle(ctx: FeishuToolContext, input: TInput): Promise<FeishuToolResult>;
}

const mutatingAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
} as const;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Reply
// ─────────────────────────────────────────────────────────────────────────

interface ReplyInput {
  chatId: string;
  text: string;
  messageId?: string;
  mentionUserIds?: string[];
}

const replyInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chat_id: {
      type: 'string',
      minLength: 1,
      description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
    },
    message_id: {
      type: 'string',
      minLength: 1,
      description: 'Optional source message id to reply under (threads the reply).',
    },
    text: {
      type: 'string',
      minLength: 1,
      description: 'Message text to send.',
    },
    mention_user_ids: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Optional Feishu user open_ids to @-mention inline in the reply.',
    },
  },
  required: ['chat_id', 'text'],
};

function parseReplyInput(raw: unknown): ReplyInput {
  const obj = asRecord(raw, 'reply arguments');
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

const replyDef: FeishuToolDef<ReplyInput> = {
  name: 'reply',
  title: 'Reply in Feishu',
  description: 'Send a Feishu message through this dispatcher channel.',
  inputSchema: replyInputSchema,
  outputSchema: closedObjectSchema(
    {
      message_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    ['message_ids'],
  ),
  annotations: mutatingAnnotations,
  parse: parseReplyInput,
  async handle(ctx, input) {
    const result = await ctx.session.sendText(input.chatId, input.text, {
      messageId: input.messageId,
      mentionUserIds: input.mentionUserIds,
    });
    return { message_ids: result.message_ids };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// React
// ─────────────────────────────────────────────────────────────────────────

interface ReactInput {
  chatId?: string;
  messageId: string;
  emoji: string;
}

const reactInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: {
      type: 'string',
      minLength: 1,
      description: 'Feishu message id to react to.',
    },
    chat_id: {
      type: 'string',
      minLength: 1,
      description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
    },
    emoji: {
      type: 'string',
      minLength: 1,
      description: 'Feishu reaction emoji key.',
    },
  },
  required: ['message_id', 'emoji'],
};

function parseReactInput(raw: unknown): ReactInput {
  const obj = asRecord(raw, 'react arguments');
  const chatId = optionalString(obj, 'chat_id');
  return {
    ...(chatId !== null ? { chatId } : {}),
    messageId: requireString(obj, 'message_id'),
    emoji: requireString(obj, 'emoji'),
  };
}

const reactDef: FeishuToolDef<ReactInput> = {
  name: 'react',
  title: 'React in Feishu',
  description: 'Add a model-owned Feishu reaction through this dispatcher channel.',
  inputSchema: reactInputSchema,
  outputSchema: closedObjectSchema(
    { reaction_id: { type: 'string', minLength: 1 } },
    ['reaction_id'],
  ),
  annotations: mutatingAnnotations,
  parse: parseReactInput,
  async handle(ctx, input) {
    const result = await ctx.session.react(input.chatId, input.messageId, input.emoji);
    return { reaction_id: result.reaction_id };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// list_chat_bots
// ─────────────────────────────────────────────────────────────────────────

interface ListChatBotsInput {
  chatId: string;
}

const listChatBotsInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chat_id: {
      type: 'string',
      minLength: 1,
      description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
    },
  },
  required: ['chat_id'],
};

function parseListChatBotsInput(raw: unknown): ListChatBotsInput {
  const obj = asRecord(raw, 'list_chat_bots arguments');
  return { chatId: requireString(obj, 'chat_id') };
}

const wireChatBotSchema = closedObjectSchema(
  {
    open_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
  },
  ['open_id'],
);

const listChatBotsDef: FeishuToolDef<ListChatBotsInput> = {
  name: 'list_chat_bots',
  title: 'List Feishu chat bots',
  description:
    'List the peer bots known and trusted in a Feishu group chat (names + open_ids). Use to recover bot identities after a context compaction.',
  inputSchema: listChatBotsInputSchema,
  outputSchema: closedObjectSchema(
    {
      chat_id: { type: 'string', minLength: 1 },
      known: { type: 'array', items: wireChatBotSchema },
      trusted: { type: 'array', items: wireChatBotSchema },
    },
    ['chat_id', 'known', 'trusted'],
  ),
  annotations: readOnlyAnnotations,
  parse: parseListChatBotsInput,
  async handle(ctx, input) {
    return ctx.session.listKnownChatBots(input.chatId);
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────

export const FEISHU_TOOLS: FeishuToolDef[] = [
  replyDef,
  reactDef,
  listChatBotsDef,
];

/** Project `FEISHU_TOOLS` into the neutral provider descriptor shape. */
export function buildToolCatalog(
  defs: readonly FeishuToolDef[] = FEISHU_TOOLS,
): ChannelToolDescriptor[] {
  return defs.map((d) => ({
    name: d.name,
    title: d.title,
    description: d.description,
    inputSchema: d.inputSchema,
    outputSchema: d.outputSchema,
    annotations: d.annotations,
  }));
}

function closedObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared small validators (module-private)
// ─────────────────────────────────────────────────────────────────────────

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

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}

// Re-export PeerBot/WireChatBot for downstream use where needed.
export type { PeerBot };
