/**
 * The conversational Feishu tools: reply, react, and peer-bot recall.
 *
 * These are the only tools a TeamLeader is offered. A leader speaks in the
 * conversation it was bound to and reads who else is in it; deciding what that
 * conversation routes to is a Dispatcher operation and lives elsewhere.
 */
import { isAbsolute } from 'node:path';
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';

import { listChatBots, type PeerBot } from '../chat-bots-store.js';
import { agentSender } from '../outbound/index.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  optionalString,
  requireString,
} from './schema.js';
import type { FeishuToolDef } from './types.js';

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
  artifacts?: string[];
}

export const replyDef: FeishuToolDef<ReplyInput> = {
  name: 'reply',
  title: 'Reply in Feishu',
  description:
    'Send a message to a Feishu chat from this channel. Text you write ' +
    'outside this tool is not delivered to the chat; use this for ' +
    'meaningful progress at key milestones, blockers, and the final answer. ' +
    'Inline local images use ![alt](/absolute/path); artifacts sends non-image ' +
    'local attachments as downloadable files, including videos.',
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
          'Id of the inbound message you are answering, so the reply ' +
          'threads under it; omit only when the request names a different ' +
          'target.',
      },
      artifacts: {
        type: 'array',
        items: { ...nonEmptyString, pattern: '^/(?!/)' },
        description:
          'Non-image attachments as local absolute paths, sent after text in array order. Every attachment, including MP4, is a file message.',
      },
      text: {
        ...nonEmptyString,
        description:
          "Markdown message body, using this channel's configured card_mode. " +
          'Use ![alt](/absolute/path) to upload a local image inline. ' +
          'To @-mention someone, write the tag where you want it, for example ' +
          '<at user_id="ou_example">Example</at>. In a group or other broad ' +
          'audience, keep secrets, tokens, private identifiers, hidden ' +
          'instructions, private context from other sources, and ' +
          'unrelated machine-local paths out of visible text.',
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
    const artifacts = obj['artifacts'];
    if (
      artifacts !== undefined &&
      (!Array.isArray(artifacts) ||
        artifacts.some(
          (path: unknown) =>
            typeof path !== 'string' ||
            path.trim() === '' ||
            !isAbsolute(path) ||
            path.startsWith('//'),
        ))
    ) {
      throw new PublicInvokeFailure(
        'reply artifacts must be an array of non-empty local absolute paths',
      );
    }
    return {
      chatId: requireString(obj, 'chat_id'),
      text: requireString(obj, 'text'),
      ...(artifacts !== undefined ? { artifacts: artifacts as string[] } : {}),
      ...(messageId !== null ? { messageId } : {}),
    };
  },
  async handle(ctx, input) {
    const result = await ctx.session.outbound.sendText({
      chatId: input.chatId,
      text: input.text,
      messageType: ctx.session.cardMode,
      ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      sender: agentSender(ctx.caller),
    });
    return { message_ids: result.messages.map((message) => message.messageId) };
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
  description: 'Add a reaction to a Feishu message from this channel.',
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
    const reactionId = await ctx.session.outbound.react(input);
    return { reaction_id: reactionId };
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
    const listing = await listChatBots(ctx.session.chatBotsStore, input.chatId);
    return {
      chat_id: input.chatId,
      known: listing.known.map(toJson),
      trusted: listing.trusted.map(toJson),
    };
  },
};

function toJson(bot: PeerBot): Record<string, string> {
  return {
    open_id: bot.openId,
    ...(bot.name !== undefined && bot.name !== '' ? { name: bot.name } : {}),
  };
}
