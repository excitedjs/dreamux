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

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { listChatBots, type PeerBot } from '../chat-bots-store.js';
import type { WireChatBot } from '../feishu-channel.js';
import { toWireChatBot } from '../feishu-channel.js';

/** Logger shape used by the Feishu channel session — pino-style, fields-first. */
export type ChannelLogger = DreamuxLogger;

export type FeishuToolName = 'reply' | 'react' | 'list_chat_bots' | 'access';

export interface FeishuToolResultEnvelope {
  status: 'ok' | 'not_found' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

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
    /** P3 stub: approve a pairing code presented by an operator. */
    approvePairingByCode?: (code: string) => Promise<FeishuToolResultEnvelope>;
  };
}

export interface FeishuMcpListChatBotsResultInternal {
  chat_id: string;
  known: WireChatBot[];
  trusted: WireChatBot[];
}

export interface FeishuToolDef<TInput = unknown> {
  name: FeishuToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  parse(raw: unknown): TInput;
  handle(ctx: FeishuToolContext, input: TInput): Promise<FeishuToolResultEnvelope>;
}

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
      description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
    },
    message_id: {
      type: 'string',
      description: 'Optional source message id to reply under (threads the reply).',
    },
    text: {
      type: 'string',
      description: 'Message text to send.',
    },
    mention_user_ids: {
      type: 'array',
      items: { type: 'string' },
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
  description: 'Send a Feishu message through this dispatcher channel.',
  inputSchema: replyInputSchema,
  parse: parseReplyInput,
  async handle(ctx, input) {
    const result = await ctx.session.sendText(input.chatId, input.text, {
      messageId: input.messageId,
      mentionUserIds: input.mentionUserIds,
    });
    return {
      status: 'ok',
      message: 'reply sent',
      details: { message_ids: result.message_ids },
    };
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
  description: 'Add a model-owned Feishu reaction through this dispatcher channel.',
  inputSchema: reactInputSchema,
  parse: parseReactInput,
  async handle(ctx, input) {
    const result = await ctx.session.react(input.chatId, input.messageId, input.emoji);
    return {
      status: 'ok',
      message: 'reaction added',
      details: { reaction_id: result.reaction_id },
    };
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
      description: 'Feishu chat id from the inbound <channel source="feishu"> block.',
    },
  },
  required: ['chat_id'],
};

function parseListChatBotsInput(raw: unknown): ListChatBotsInput {
  const obj = asRecord(raw, 'list_chat_bots arguments');
  return { chatId: requireString(obj, 'chat_id') };
}

interface ListChatBotsDetails {
  chat_id: string;
  known: Array<{ open_id: string; name?: string }>;
  trusted: Array<{ open_id: string; name?: string }>;
}

const listChatBotsDef: FeishuToolDef<ListChatBotsInput> = {
  name: 'list_chat_bots',
  description:
    'List the peer bots known and trusted in a Feishu group chat (names + open_ids). Use to recover bot identities after a context compaction.',
  inputSchema: listChatBotsInputSchema,
  parse: parseListChatBotsInput,
  async handle(ctx, input) {
    // `listChatBots` resolves against the session state dir. The session
    // adapter also exposes a direct method for the same projection; going
    // through the state dir here keeps tool handlers independent of
    // session-private caches.
    const listing = await listChatBots(ctx.stateDir, input.chatId);
    const details: ListChatBotsDetails = {
      chat_id: input.chatId,
      known: listing.known.map(toWireChatBot),
      trusted: listing.trusted.map(toWireChatBot),
    };
    // Include the raw listing in the top-level `details` *and* flattened, so
    // the envelope mirrors the legacy `{ chat_id, known, trusted }` wire shape
    // callers already depend on.
    return {
      status: 'ok',
      message: 'chat bots listed',
      details: details as unknown as Record<string, unknown>,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// access (P3 stub)
// ─────────────────────────────────────────────────────────────────────────

interface AccessInput {
  code: string;
}

const accessInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      description: '6-hex pairing code presented by the operator to approve pairing.',
      pattern: '^[0-9a-fA-F]{6}$',
      minLength: 6,
      maxLength: 6,
    },
  },
  required: ['code'],
};

const ACCESS_CODE_RE = /^[0-9a-fA-F]{6}$/;

function parseAccessInput(raw: unknown): AccessInput {
  const obj = asRecord(raw, 'access arguments');
  const code = requireString(obj, 'code');
  if (!ACCESS_CODE_RE.test(code)) {
    throw new Error('code must be a 6-character hex string');
  }
  return { code };
}

const accessDef: FeishuToolDef<AccessInput> = {
  name: 'access',
  description:
    'Approve a pending pairing by its 6-hex pairing code. Adds the DM sender or group chat to the dispatcher allowlists. Idempotent on membership.',
  inputSchema: accessInputSchema,
  parse: parseAccessInput,
  async handle(ctx, input) {
    if (ctx.session.approvePairingByCode === undefined) {
      return {
        status: 'error',
        message: 'approvePairingByCode not wired',
        details: { code: input.code },
      };
    }
    return ctx.session.approvePairingByCode(input.code);
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────

export const FEISHU_TOOLS: FeishuToolDef[] = [
  replyDef,
  reactDef,
  listChatBotsDef,
  accessDef,
];

/** Project `FEISHU_TOOLS` into the `{name, description, inputSchema}` shape `tools/list` returns. */
export function buildToolCatalog(
  defs: FeishuToolDef[] = FEISHU_TOOLS,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
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
