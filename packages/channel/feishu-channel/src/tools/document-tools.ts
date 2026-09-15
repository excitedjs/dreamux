/**
 * Document-subscription tools: follow a document's comments, release it, and
 * read what you follow.
 *
 * All three are one definition offered to both callers, which is the opposite
 * of `bind_channel`'s two, and for a structural reason: none of them takes a
 * recipient. The recipient *is* the caller — a TeamLeader's own Team, the
 * Dispatcher Agent for the Dispatcher — so there is no authority to split and
 * no argument with which a caller could name someone else. That covers the read
 * and the removal as well as the write: each caller sees and removes exactly
 * its own rows, and a row whose owner is gone is removed by the Channel itself
 * rather than left for an operator to find.
 */
import type {
  FeishuToolContext,
  FeishuToolDef,
  FeishuToolResult,
} from './types.js';
import {
  asRecord,
  closedObjectSchema,
  nonEmptyString,
  optionalString,
  requireString,
} from './schema.js';

const mutating = { readOnlyHint: false, destructiveHint: false } as const;

/**
 * What Feishu will and will not push, stated in the description so the model
 * does not promise a user something the platform never delivers. It is the
 * bot's own notification rule, not a document feed.
 */
const DELIVERY_RULE =
  'Feishu delivers a document comment to this bot only when the bot would be ' +
  'notified itself: the comment or reply @-mentions the bot, or the reply ' +
  'lands in a thread the bot has already replied in. Anything else is never ' +
  'delivered, however the subscription is written.';

const documentProperty = {
  ...nonEmptyString,
  description:
    'A Feishu document URL or a bare document token. A URL also states the ' +
    'document type; a wiki URL is resolved to the document it holds.',
};

/** The recipient this call belongs to: the caller, and never anyone else. */
function callerRecipient(ctx: FeishuToolContext): string | null {
  return ctx.caller.kind === 'team_leader' ? ctx.caller.team_name : null;
}

interface SubscribeInput {
  document: string;
  type: string | null;
}

export const subscribeDocumentDef: FeishuToolDef<SubscribeInput> = {
  name: 'subscribe_document',
  title: 'Follow a Feishu document\'s comments',
  description:
    'Follow one Feishu document so its comment events reach you. ' +
    DELIVERY_RULE +
    ' Subscribing checks that this bot can see the document and refuses when ' +
    'it cannot, because such a subscription could never fire.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema(
    {
      document: documentProperty,
      type: {
        ...nonEmptyString,
        description:
          'Document type, required only for a bare token: `docx`, `doc`, ' +
          '`sheet`, `bitable`, `mindnote`, `file`, `slides`, or `wiki`. A URL ' +
          'states it already.',
      },
    },
    ['document'],
  ),
  outputSchema: closedObjectSchema(
    {
      file_token: nonEmptyString,
      file_type: nonEmptyString,
      already_subscribed: { type: 'boolean' },
    },
    ['file_token', 'file_type', 'already_subscribed'],
  ),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'subscribe_document arguments');
    return {
      document: requireString(obj, 'document'),
      type: optionalString(obj, 'type'),
    };
  },
  async handle(ctx, input): Promise<FeishuToolResult> {
    return { ...await ctx.session.subscribeDocument({
      document: input.document,
      type: input.type,
      teamName: callerRecipient(ctx),
    }) };
  },
};

export const unsubscribeDocumentDef: FeishuToolDef<{ document: string }> = {
  name: 'unsubscribe_document',
  title: 'Stop following a Feishu document',
  description:
    'Stop receiving comment events for one Feishu document. This removes ' +
    'only your own subscription; another recipient following the same ' +
    'document keeps receiving it. A document you were not following is left ' +
    'untouched and is not a failure.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema({ document: documentProperty }, ['document']),
  outputSchema: closedObjectSchema(
    {
      file_token: nonEmptyString,
      unsubscribed: { type: 'boolean' },
    },
    ['file_token', 'unsubscribed'],
  ),
  annotations: mutating,
  parse(raw) {
    const obj = asRecord(raw, 'unsubscribe_document arguments');
    return { document: requireString(obj, 'document') };
  },
  async handle(ctx, input): Promise<FeishuToolResult> {
    return { ...await ctx.session.unsubscribeDocument({
      document: input.document,
      teamName: callerRecipient(ctx),
    }) };
  },
};

export const listSubscriptionsDef: FeishuToolDef<Record<string, never>> = {
  name: 'list_subscriptions',
  title: 'List the Feishu documents you follow',
  description:
    'List the Feishu documents whose comments reach you. It shows your own ' +
    'subscriptions only — the ones you can remove with unsubscribe_document ' +
    '— not every subscription on this channel.',
  callers: ['dispatcher', 'team_leader'],
  inputSchema: closedObjectSchema({}),
  outputSchema: closedObjectSchema(
    {
      channel_id: nonEmptyString,
      subscriptions: {
        type: 'array',
        items: closedObjectSchema(
          {
            file_token: nonEmptyString,
            file_type: nonEmptyString,
            created_at: { type: 'number' },
          },
          ['file_token', 'file_type', 'created_at'],
        ),
      },
    },
    ['channel_id', 'subscriptions'],
  ),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  parse(raw) {
    asRecord(raw ?? {}, 'list_subscriptions arguments');
    return {};
  },
  async handle(ctx): Promise<FeishuToolResult> {
    return {
      channel_id: ctx.session.channelId,
      subscriptions: ctx.session
        .listSubscriptions(callerRecipient(ctx))
        .map((row) => ({ ...row })),
    };
  },
};
