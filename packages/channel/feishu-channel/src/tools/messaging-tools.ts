/**
 * The conversational Feishu tools: reply, react, and peer-bot recall.
 *
 * These are the only tools a TeamLeader is offered. A leader speaks in the
 * conversation it was bound to and reads who else is in it; deciding what that
 * conversation routes to is a Dispatcher operation and lives elsewhere.
 */
import type { FeishuToolDef } from './types.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  optionalString,
  optionalStringArray,
  requireString,
} from './schema.js';

const mutating = { readOnlyHint: false, destructiveHint: false } as const;
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

interface ReplyInput {
  chatId: string;
  text: string;
  messageId?: string;
  mentionUserIds?: string[];
}

export const replyDef: FeishuToolDef<ReplyInput> = {
  name: 'reply',
  title: 'Reply in Feishu',
  description: 'Send a Feishu message through this dispatcher channel.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema(
    {
      chat_id: {
        ...nonEmptyString,
        description:
          'Feishu chat id from the inbound <channel source="feishu"> block.',
      },
      message_id: {
        ...nonEmptyString,
        description:
          'Optional source message id to reply under (threads the reply).',
      },
      text: { ...nonEmptyString, description: 'Message text to send.' },
      mention_user_ids: {
        type: 'array',
        items: nonEmptyString,
        description:
          'Optional Feishu user open_ids to @-mention inline in the reply.',
      },
    },
    ['chat_id', 'text'],
  ),
  outputSchema: closedObjectSchema(
    { message_ids: { type: 'array', minItems: 1, items: nonEmptyString } },
    ['message_ids'],
  ),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'reply arguments');
    const messageId = optionalString(obj, 'message_id');
    const mentionUserIds = optionalStringArray(obj, 'mention_user_ids');
    return {
      chatId: requireString(obj, 'chat_id'),
      text: requireString(obj, 'text'),
      ...(messageId !== null ? { messageId } : {}),
      ...(mentionUserIds !== null ? { mentionUserIds } : {}),
    };
  },
  async handle(ctx, input) {
    const result = await ctx.session.sendText(input.chatId, input.text, {
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(input.mentionUserIds !== undefined
        ? { mentionUserIds: input.mentionUserIds }
        : {}),
    });
    return { message_ids: result.message_ids };
  },
};

interface ReactInput {
  chatId?: string;
  messageId: string;
  emoji: string;
}

export const reactDef: FeishuToolDef<ReactInput> = {
  name: 'react',
  title: 'React in Feishu',
  description:
    'Add a model-owned Feishu reaction through this dispatcher channel.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema(
    {
      message_id: {
        ...nonEmptyString,
        description: 'Feishu message id to react to.',
      },
      chat_id: {
        ...nonEmptyString,
        description:
          'Feishu chat id from the inbound <channel source="feishu"> block.',
      },
      emoji: { ...nonEmptyString, description: 'Feishu reaction emoji key.' },
    },
    ['message_id', 'emoji'],
  ),
  outputSchema: closedObjectSchema({ reaction_id: nonEmptyString }, [
    'reaction_id',
  ]),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'react arguments');
    const chatId = optionalString(obj, 'chat_id');
    return {
      ...(chatId !== null ? { chatId } : {}),
      messageId: requireString(obj, 'message_id'),
      emoji: requireString(obj, 'emoji'),
    };
  },
  async handle(ctx, input) {
    const result = await ctx.session.react(
      input.chatId,
      input.messageId,
      input.emoji,
    );
    return { reaction_id: result.reaction_id };
  },
};

const wireChatBotSchema = closedObjectSchema(
  { open_id: nonEmptyString, name: nonEmptyString },
  ['open_id'],
);

export const listChatBotsDef: FeishuToolDef<{ chatId: string }> = {
  name: 'list_chat_bots',
  title: 'List Feishu chat bots',
  description:
    'List the peer bots known and trusted in a Feishu group chat (names + ' +
    'open_ids). Use to recover bot identities after a context compaction.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema(
    {
      chat_id: {
        ...nonEmptyString,
        description:
          'Feishu chat id from the inbound <channel source="feishu"> block.',
      },
    },
    ['chat_id'],
  ),
  outputSchema: closedObjectSchema(
    {
      chat_id: nonEmptyString,
      known: { type: 'array', items: wireChatBotSchema },
      trusted: { type: 'array', items: wireChatBotSchema },
    },
    ['chat_id', 'known', 'trusted'],
  ),
  annotations: readOnly,
  parse(raw) {
    const obj = asRecord(raw, 'list_chat_bots arguments');
    return { chatId: requireString(obj, 'chat_id') };
  },
  async handle(ctx, input) {
    const listing = await ctx.session.listKnownChatBots(input.chatId);
    return {
      chat_id: listing.chat_id,
      known: listing.known.map(toJson),
      trusted: listing.trusted.map(toJson),
    };
  },
};

function toJson(
  bot: { open_id: string; name?: string },
): Record<string, string> {
  return {
    open_id: bot.open_id,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}
