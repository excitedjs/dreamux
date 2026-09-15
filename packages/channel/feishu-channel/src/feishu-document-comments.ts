/**
 * Following a Feishu document, and delivering what Feishu pushes for it.
 *
 * Both halves live here because they are one fact seen from two sides: a
 * recipient follows a document, and a comment on that document reaches whoever
 * follows it.
 *
 * Feishu pushes these events on the bot's own notification rule, not as a
 * document feed: a comment or reply that @-mentions this bot, plus later
 * replies in a thread this bot has itself replied in. Those two are the *only*
 * shapes an event can take, which is what makes the rules below exact rather
 * than a compromise.
 *
 * A **subscribed** document is answered by its subscribers, and by nothing
 * else. No access gate runs: the gate's question is whether a chat sender may
 * make this Channel interpret a message, and the subscription is already that
 * decision, made by the recipient itself. A proof acts on one subscriber — if
 * one document carries both a Team's row and the Dispatcher's, the Team's
 * pre-admission rejection removes the Team's row and leaves the Dispatcher's
 * submission alone.
 *
 * An **unclaimed** event splits on the one fact Feishu gives us:
 *
 * - It @-mentions the bot: a person is addressing this bot in a document nobody
 *   follows. That is the cold open, and chat already answers it the same way —
 *   an unrouted conversation reaches the Dispatcher Agent. The reason a
 *   subscribed comment needs no gate is exactly why this one does: nobody
 *   subscribed, so there is no recipient decision to stand on, and the
 *   Dispatcher's trusted-human set is the authority instead. An unknown
 *   commenter is dropped and logged — a document has no chat window to send a
 *   pairing card into, and no way to answer one.
 * - It does not: Feishu would not have sent it unless the bot had already
 *   replied in that thread, so it is the tail of a subscription that was
 *   removed. Dropped and logged.
 *
 * A Dispatcher delivery of an unclaimed mention writes no row, so a rejection
 * on it has nothing to remove.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { PublicInvokeFailure } from '@excitedjs/dreamux-utils';
import {
  parseFeishuDocumentRef,
  type FeishuCommentEvent,
  type FeishuDocCommentRequest,
  type FeishuDocCommentText,
  type FeishuDocMetaResult,
  type FeishuWikiNode,
} from '@excitedjs/feishu-transport';

import { runFeishuBoundedOperation } from './feishu-bounded-operation.js';
import {
  escapeXmlAttribute,
  escapeXmlText,
  formatFeishuCreateTime,
} from './feishu-message-render.js';
import {
  DOC_COMMENT_REMINDER,
  errorMessage,
  type FeishuSubmission,
  type FeishuSubmitOutcome,
} from './feishu-submit.js';
import type { FeishuRouting } from './routing/index.js';
import type { FeishuDocSubscriptionRecord } from './routing/document.js';

/**
 * The budget both inbound enrichment reads share. The route awaits delivery
 * before the SDK acks the event, so a slow lookup costs an event Feishu will
 * consider unhandled — and neither the commenter's name nor the comment's own
 * text is worth that. They run together under one deadline, which leaves the
 * route's worst case where it already was.
 */
const ENRICHMENT_TIMEOUT_MS = 2_000;

const DOC_COMMENT_NOTE = 'read the thread and the document with lark-cli';

const DOC_COMMENT_QUOTE_NOTE = 'the document text this comment is anchored to';

export interface FeishuDocumentSubscriptionView {
  readonly file_token: string;
  readonly file_type: string;
  readonly created_at: number;
}

export interface FeishuDocumentCommentsOptions {
  readonly dispatcherId: string;
  readonly channelId: string;
  readonly log: DreamuxLogger;
  readonly routing: FeishuRouting;
  /** `null` reaches the Dispatcher Agent, exactly as it does for a chat. */
  submit(
    teamName: string | null,
    submission: FeishuSubmission,
  ): Promise<FeishuSubmitOutcome>;
  fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMetaResult>;
  resolveWikiNode(token: string): Promise<FeishuWikiNode | null>;
  /** The comment's own text; `null` when Feishu's thread does not hold it. */
  fetchDocCommentText(
    request: FeishuDocCommentRequest,
  ): Promise<FeishuDocCommentText | null>;
  /** Best-effort display name for the commenter; may answer `undefined`. */
  resolveUserName(openId: string): Promise<string | undefined>;
  /**
   * Whether this commenter is one of the Dispatcher's trusted humans. Read-only
   * and injected, so this module learns no access-state layout and the gate
   * keeps its single owner.
   */
  isTrustedUser(openId: string): Promise<boolean>;
}

export class FeishuDocumentComments {
  constructor(private readonly opts: FeishuDocumentCommentsOptions) {}

  // ── Subscribing ────────────────────────────────────────────────────────

  /**
   * Follow one document for the calling recipient.
   *
   * The order is the whole of it. A wiki reference names a node, while the
   * metadata API and every comment event name the object inside it, so the node
   * is resolved first — a row carrying a node token would check the wrong
   * document's permission and then match no event at all. The metadata read
   * that follows is a permission proof and nothing else: its answer is not
   * stored, because a title is not what a subscription is about.
   */
  async subscribe(input: {
    document: string;
    type: string | null;
    teamName: string | null;
  }): Promise<{
    file_token: string;
    file_type: string;
    already_subscribed: boolean;
  }> {
    const resolved = await this.resolveDocument(input.document, input.type);
    const fileType = resolved.type;
    if (fileType === null) {
      throw new PublicInvokeFailure(
        'A bare document token does not say what kind of document it is. ' +
          'Pass the document URL instead, or supply `type` (for example ' +
          '`docx`, `sheet`, `bitable`, `wiki`).',
      );
    }
    const meta = await this.opts.fetchDocMeta(resolved.token, fileType);
    // Only a token Feishu itself reported as unreadable may be answered with
    // "add the bot". A request failure propagates as an ordinary retryable tool
    // failure, and an unsupported type is its own answer.
    if (meta.kind === 'invisible') {
      throw new PublicInvokeFailure(
        `This bot cannot see document ${resolved.token}. Add it as a ` +
          'collaborator on the document (view permission is enough), then ' +
          'subscribe again.',
      );
    }
    if (meta.kind === 'unsupported_type') {
      throw new PublicInvokeFailure(
        `Feishu's document metadata API does not take type ` +
          `${JSON.stringify(fileType)}. Check the document's actual type.`,
      );
    }
    const { alreadySubscribed } = await this.opts.routing.subscribe({
      fileToken: resolved.token,
      fileType,
      teamName: input.teamName,
    });
    return {
      file_token: resolved.token,
      file_type: fileType,
      already_subscribed: alreadySubscribed,
    };
  }

  /**
   * Stop following one document.
   *
   * A wiki URL is resolved here too, because the string a recipient subscribed
   * with is the string it will unsubscribe with, and the row holds the object
   * token. No metadata read: removing a row proves nothing and needs nothing
   * proven.
   */
  async unsubscribe(input: {
    document: string;
    teamName: string | null;
  }): Promise<{ file_token: string; unsubscribed: boolean }> {
    const resolved = await this.resolveDocument(input.document, null);
    const unsubscribed = await this.opts.routing.unsubscribe(
      resolved.token,
      input.teamName,
    );
    return { file_token: resolved.token, unsubscribed };
  }

  listSubscriptions(
    teamName: string | null,
  ): readonly FeishuDocumentSubscriptionView[] {
    return this.opts.routing.listSubscriptions(teamName).map((row) => ({
      file_token: row.file_token,
      file_type: row.file_type,
      created_at: row.created_at,
    }));
  }

  private async resolveDocument(
    document: string,
    declaredType: string | null,
  ): Promise<{ token: string; type: string | null }> {
    const ref = parseFeishuDocumentRef(document);
    if (ref === null) {
      throw new PublicInvokeFailure(
        '`document` must be a Feishu document URL or a document token.',
      );
    }
    const type = ref.type ?? declaredType;
    if (type !== 'wiki') return { token: ref.token, type };
    const node = await this.opts.resolveWikiNode(ref.token);
    if (node === null) {
      throw new PublicInvokeFailure(
        `This bot cannot see wiki node ${ref.token}. Add it as a ` +
          'collaborator on that wiki page (view permission is enough), then ' +
          'try again.',
      );
    }
    return { token: node.objToken, type: node.objType };
  }

  // ── Delivery ───────────────────────────────────────────────────────────

  /**
   * Deliver one comment event to every recipient following that document.
   *
   * Submissions run concurrently: one subscriber's failure must not hold up
   * the others, and the route awaits this whole call before the SDK acks, so N
   * submissions in sequence — each of which may start a runtime — would be an
   * avoidable ACK timeout.
   */
  async deliver(event: FeishuCommentEvent): Promise<void> {
    const subscribers = this.opts.routing.subscribersFor(event.fileToken);
    if (subscribers.length === 0) {
      await this.deliverUnclaimed(event);
      return;
    }
    const submission = await this.submissionFor(event);
    await Promise.all(
      subscribers.map((row) => this.deliverTo(row, event, submission)),
    );
  }

  /**
   * The one submission an event produces, with both enrichment reads done.
   *
   * They run only here, so they run once per *delivered* event: a drop never
   * spends a platform call on a comment nobody will read.
   */
  private async submissionFor(
    event: FeishuCommentEvent,
  ): Promise<FeishuSubmission> {
    const deadlineAt = Date.now() + ENRICHMENT_TIMEOUT_MS;
    const [senderName, comment] = await Promise.all([
      this.senderName(event.commenterId, deadlineAt),
      this.commentText(event, deadlineAt),
    ]);
    return documentCommentSubmission(event, senderName, comment);
  }

  /**
   * What happens to an event nobody follows.
   *
   * The two drops carry different reasons on purpose: one says the bot was not
   * addressed, the other says it was addressed by someone this Dispatcher does
   * not trust, and only the second is something an operator can act on.
   */
  private async deliverUnclaimed(event: FeishuCommentEvent): Promise<void> {
    if (!event.mentionedBot) {
      this.opts.log.info(
        { ...this.scope(event), reason: 'no_subscriber' },
        'feishu document comment reached no subscriber; dropped',
      );
      return;
    }
    if (!(await this.opts.isTrustedUser(event.commenterId))) {
      this.opts.log.info(
        { ...this.scope(event), reason: 'commenter_not_trusted' },
        'feishu document comment mentioned the bot in an unfollowed document, ' +
          'from a commenter this dispatcher does not trust; dropped',
      );
      return;
    }
    const submission = await this.submissionFor(event);
    // No row is written and none is removed: this delivery is a cold open, not
    // a subscription, so a rejection on it has nothing to reconcile.
    const outcome = await this.opts.submit(null, submission);
    this.opts.log.info(
      { ...this.scope(event), status: outcome.status },
      'delivered an unfollowed Feishu document mention to the Dispatcher Agent',
    );
  }

  private async deliverTo(
    row: FeishuDocSubscriptionRecord,
    event: FeishuCommentEvent,
    submission: FeishuSubmission,
  ): Promise<void> {
    const scope = { ...this.scope(event), team_name: row.team_name };
    const outcome = await this.opts.submit(row.team_name, submission);
    if (outcome.status !== 'rejected') {
      this.opts.log.info(
        { ...scope, status: outcome.status },
        'feishu document comment delivered',
      );
      return;
    }
    // The same proof, and the same commit path, that removes a stale binding:
    // Core resolved the recipient and refused before creating anything. It
    // removes this subscriber's row and no other.
    try {
      await this.opts.routing.unsubscribe(event.fileToken, row.team_name);
      this.opts.log.info(
        { ...scope, code: outcome.code },
        'removed a Feishu document subscription whose Team can no longer answer',
      );
    } catch (error) {
      this.opts.log.warn(
        { ...scope, err: { message: errorMessage(error) } },
        'could not commit the removal of a Feishu document subscription',
      );
    }
  }

  private scope(event: FeishuCommentEvent): Record<string, unknown> {
    return {
      dispatcher_id: this.opts.dispatcherId,
      channel_id: this.opts.channelId,
      file_token: event.fileToken,
      file_type: event.fileType,
      comment_id: event.commentId,
      reply_id: event.replyId,
    };
  }

  private async senderName(
    openId: string,
    deadlineAt: number,
  ): Promise<string> {
    try {
      return await runFeishuBoundedOperation({
        deadlineAt,
        operation: () => this.opts.resolveUserName(openId),
      }) ?? '';
    } catch {
      // The name is decoration on an event that is already identified by ids.
      return '';
    }
  }

  /**
   * What the commenter actually wrote, or `null`.
   *
   * Every way of coming back empty is the same fact to this caller — there is
   * no text to show — so it is one value and not a discriminated result, and
   * it never costs the event: the ids in the body still address the thread, so
   * the delivery goes ahead without the text and the failure is logged instead.
   */
  private async commentText(
    event: FeishuCommentEvent,
    deadlineAt: number,
  ): Promise<FeishuDocCommentText | null> {
    try {
      const comment = await runFeishuBoundedOperation({
        deadlineAt,
        operation: () => this.opts.fetchDocCommentText({
          fileToken: event.fileToken,
          fileType: event.fileType,
          commentId: event.commentId,
          replyId: event.replyId,
        }),
      });
      if (comment !== null) return comment;
      this.opts.log.info(
        this.scope(event),
        'feishu holds no text for this document comment; delivering its ids alone',
      );
      return null;
    } catch (error) {
      this.opts.log.warn(
        { ...this.scope(event), err: { message: errorMessage(error) } },
        'could not read a feishu document comment; delivering its ids alone',
      );
      return null;
    }
  }
}

/**
 * The one submission a comment event produces, shared by every subscriber.
 *
 * `sourceId` carries the reply id as well as the comment id, and that is
 * load-bearing: `comment_id` names a whole thread, every reply in it repeats
 * that id, and Core's admission ledger would return `duplicate` for every reply
 * after the first — silently killing the case the feature exists for. The file
 * token is carried too, so the id needs no assumption about comment ids being
 * unique across documents. The recipient is already part of Core's ledger key,
 * so one id reaching two subscribers is two keys and both are admitted.
 */
export function documentCommentSubmission(
  event: FeishuCommentEvent,
  senderName: string,
  comment: FeishuDocCommentText | null,
): FeishuSubmission {
  const attrs: Record<string, string> = {
    source: 'feishu',
    sender_id: event.commenterId,
  };
  if (senderName !== '') attrs['sender_name'] = senderName;
  const createTime = formatFeishuCreateTime(String(event.timestamp));
  if (createTime !== '') attrs['create_time'] = createTime;
  return {
    kind: 'doc_comment',
    attrs,
    text: documentCommentBody(event, comment),
    reminder: DOC_COMMENT_REMINDER,
    sourceId: `${event.fileToken}:${event.commentId}:${event.replyId}`,
  };
}

/**
 * One element: the ids that address the comment, and what it says.
 *
 * The text is element content rather than an attribute, escaped exactly once
 * the way a chat message's `<content>` is, so a comment reaches the model as
 * written. The anchor quote sits beside it because a comment on a selection is
 * about that selection, and without it the model is told a document is being
 * discussed but not which part — it carries a note because `quote` alone reads
 * just as easily as text quoted from an earlier reply.
 *
 * Neither is invented when Feishu did not answer with it: the element falls
 * back to the ids alone, which still address the thread.
 *
 * `notice_type` is not read off the payload. The SDK's decoder does not surface
 * it, and it is not independent of what is here: Feishu sends `add_comment`
 * only with an empty `reply_id` and `add_reply` only with a non-empty one.
 */
function documentCommentBody(
  event: FeishuCommentEvent,
  comment: FeishuDocCommentText | null,
): string {
  const attributes: Array<[string, string]> = [
    ['file_token', event.fileToken],
    ['file_type', event.fileType],
    ['comment_id', event.commentId],
    ['reply_id', event.replyId],
    ['notice_type', event.replyId === '' ? 'add_comment' : 'add_reply'],
    ['mentioned', event.mentionedBot ? 'true' : 'false'],
    ['note', DOC_COMMENT_NOTE],
  ];
  const rendered = attributes
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(' ');
  const blocks: string[] = [];
  if (comment !== null && comment.quote !== '') {
    blocks.push(
      `<quote note="${escapeXmlAttribute(DOC_COMMENT_QUOTE_NOTE)}">\n` +
        `${escapeXmlText(comment.quote)}\n</quote>`,
    );
  }
  if (comment !== null && comment.text !== '') {
    blocks.push(`<content>\n${escapeXmlText(comment.text)}\n</content>`);
  }
  if (blocks.length === 0) return `<doc-comment ${rendered} />`;
  return `<doc-comment ${rendered}>\n${blocks.join('\n')}\n</doc-comment>`;
}
