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
 *
 * It is written as a rule with examples rather than as a set, because what
 * satisfies the rule is the platform's to decide: an earlier wording listed
 * the two cases known then and closed with "anything else is never
 * delivered", which a document the bot owns falsifies.
 *
 * Ownership is stated rather than left implicit for two reasons. It is the
 * only known way to receive a document's comments as a whole, which is what a
 * caller needs to know before deciding who writes a document; and it is not a
 * permission a caller can be granted afterwards, so mistaking it for one — a
 * full-access collaborator receives none of it — ends in a subscription that
 * looks correct and never fires.
 *
 * The last sentence is the reason this tool exists at all: the platform side
 * of the rule decides what arrives, and a subscription decides who reads it.
 */
const DELIVERY_RULE =
  'Feishu delivers a document comment to this bot only when the bot would be ' +
  'notified itself, and what satisfies that is the platform\'s rule rather ' +
  'than a list this tool holds. One case delivers all of a document\'s ' +
  'comments: a document written under this bot\'s identity. Every comment on ' +
  'it arrives — mentioned or not, anchored to a passage or on the whole ' +
  'document, opening a thread or replying in one — because the bot owns it, ' +
  'and ownership is what decides: collaborator access on someone else\'s ' +
  'document, even full access, delivers none of that. What has been observed ' +
  'on a document someone else wrote is narrower: a comment or reply that ' +
  '@-mentions this bot while the app has permission on the document, or a ' +
  'reply in a thread this bot has already replied in. Subscribing widens none ' +
  'of this; it decides who receives what already arrives. Until this tool is ' +
  'called for a document, nothing Feishu pushes for it reaches a recipient, ' +
  'except a mention of this bot from a commenter the Dispatcher already ' +
  'trusts, which reaches the Dispatcher Agent.';

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
