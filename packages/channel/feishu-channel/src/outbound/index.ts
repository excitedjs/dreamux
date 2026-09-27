/**
 * Every message this Channel sends, in one place.
 *
 * A reply, a card, a reaction, a repaint, a locate-by-message-id, and a
 * best-effort notification are the whole of what this session puts onto the
 * platform. Keeping them on one object is what lets every send read its own
 * landing chat/topic straight off Feishu's create/reply response, instead of
 * a session-local ledger guessing it from whichever message this instance
 * last happened to see in that conversation — a guess that is wrong the
 * moment two conversations interleave.
 *
 * `sendText` alone carries product policy beyond "send it": inside a
 * Collaboration Space chat, a reply with no `message_id` must not silently
 * open a brand new topic on the caller's behalf, so it is routed to the
 * caller's own bound topic when exactly one exists, and refused otherwise.
 * Every other method is a thin, logged wrapper over the transport.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { errorInfo, PublicInvokeFailure } from '@excitedjs/dreamux-utils';
import type {
  FeishuSendResult,
  FeishuSentMessage,
  OutboundTarget,
} from '@excitedjs/feishu-transport';

import type { FeishuBot } from '../bot.js';
import {
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from '../feishu-bounded-operation.js';
import { errorMessage } from '../feishu-submit.js';
import type {
  FeishuInboundRoute,
  FeishuInboundTargeting,
} from '../inbound/target.js';
import type { FeishuRouting } from '../routing/index.js';
import type { FeishuLifecycle } from '../session/lifecycle.js';

const FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS = 20_000;

/**
 * The routing facts `sendText`'s Collaboration Space guard needs, and no
 * more.
 */
type FeishuOutboundRouting = Pick<
  FeishuRouting,
  'spaceForContainer' | 'topicBindingsFor'
>;

/** `locate`'s own inbound-projection need, and no more. */
type FeishuOutboundTargeting = Pick<FeishuInboundTargeting, 'project'>;

export interface FeishuOutboundOptions {
  readonly bot: FeishuBot;
  readonly log: DreamuxLogger;
  readonly dispatcherId: string;
  /** This handle's session lifecycle; a send after it ends aborts. */
  readonly lifecycle: FeishuLifecycle;
  readonly routing: FeishuOutboundRouting;
  readonly targetRouter: FeishuOutboundTargeting;
}

export class FeishuOutbound {
  constructor(private readonly opts: FeishuOutboundOptions) {}

  /**
   * Send a reply, or, with no `message_id`, a fresh top-level message —
   * except inside a Collaboration Space chat, where a fresh top-level message
   * would open a new topic on the caller's behalf. There, a `reply` with no
   * `message_id` lands under the caller's own bound topic when exactly one
   * exists with a known root, and is refused otherwise: zero or several
   * candidate topics, or one with no root yet, are all cases a guess would
   * pick the wrong conversation for.
   */
  async sendText(input: {
    chatId: string;
    text: string;
    messageId?: string | undefined;
    /** The calling Team, or `null` for the Dispatcher Agent. */
    callerTeamName: string | null;
  }): Promise<{ messages: readonly FeishuSentMessage[] }> {
    const target = this.sendTextTarget(
      input.chatId,
      input.messageId,
      input.callerTeamName,
    );
    let result: FeishuSendResult;
    try {
      result = await this.opts.bot.send(target, input.text);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: input.chatId,
          message_id: input.messageId,
          err: errorInfo(err),
        },
        'feishu send failed',
      );
      throw err;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        message_ids: result.messages.map((m) => m.messageId),
      },
      'feishu message sent',
    );
    return result;
  }

  private sendTextTarget(
    chatId: string,
    messageId: string | undefined,
    callerTeamName: string | null,
  ): OutboundTarget {
    if (messageId !== undefined) return { chatId, replyToMessageId: messageId };
    if (this.opts.routing.spaceForContainer(chatId) === undefined) {
      return { chatId };
    }
    const rows = this.opts.routing.topicBindingsFor(chatId, callerTeamName);
    const only = rows.length === 1 ? rows[0] : undefined;
    if (only !== undefined && only.root_message_id !== null) {
      return { chatId, replyToMessageId: only.root_message_id };
    }
    throw new PublicInvokeFailure(
      'This Feishu chat is a Collaboration Space. Replying with no ' +
        'message_id only works inside your own bound topic in it, and none ' +
        'was found. Pass the message_id you are answering.',
    );
  }

  async sendCard(input: {
    target: OutboundTarget;
    card: unknown;
    signal?: AbortSignal;
    mode?: 'inbound' | 'background';
  }): Promise<{ messages: readonly FeishuSentMessage[] }> {
    this.opts.lifecycle.assertLive();
    let result: FeishuSendResult;
    try {
      result = await this.opts.bot.sendCard(
        input.target,
        input.card,
        input.signal !== undefined ? { signal: input.signal } : undefined,
      );
    } catch (err) {
      if (input.mode !== 'background') {
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            chat_id: input.target.chatId,
            message_id: input.target.replyToMessageId,
            err: errorInfo(err),
          },
          'feishu sendCard failed',
        );
      }
      throw err;
    }
    this.opts.lifecycle.assertLive();
    if (input.mode !== 'background') {
      this.opts.log.info(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: input.target.chatId,
          message_id: input.target.replyToMessageId,
          message_ids: result.messages.map((m) => m.messageId),
        },
        'feishu interactive card sent',
      );
    }
    return result;
  }

  async react(input: {
    messageId: string;
    emoji: string;
    chatId?: string | undefined;
  }): Promise<string> {
    let reactionId: string;
    try {
      reactionId = await this.opts.bot.addReaction(
        input.messageId,
        input.emoji,
      );
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          message_id: input.messageId,
          err: errorInfo(err),
        },
        'feishu add-reaction failed',
      );
      throw err;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: input.chatId,
        message_id: input.messageId,
        emoji: input.emoji,
        reaction_id: reactionId,
      },
      'feishu reaction added',
    );
    return reactionId;
  }

  async editCard(messageId: string, card: unknown): Promise<void> {
    await this.opts.bot.editCard(messageId, card);
  }

  /**
   * Where a card actually is, asked of Feishu rather than assumed.
   *
   * A message sent as a reply lives in the replied-to message's topic, which
   * only Feishu can report. Every caller this exists for names a card it did
   * not just send in this same call, so it has no landing to read off a send
   * response instead: an extension's card-action forward always resolves
   * whichever card the click came from this way, as does the
   * extension-facing `readMessageRoute` capability naming an arbitrary
   * message id. An ask-user settlement falls back to this only when its own
   * round never recorded a landing (the send reported no message at all) —
   * ordinarily it already knows from `activate()` and skips this. A message
   * this fails to locate is a failed delivery — the chat is a guess, and a
   * guess puts one conversation's answer in front of another.
   */
  async locate(messageId: string): Promise<FeishuInboundRoute> {
    const read = await this.opts.bot.readMessage?.({ messageId });
    const message = read?.items.find((item) => item.messageId === messageId);
    if (message === undefined || message.chatId === '') {
      throw new Error(`Feishu reported no chat for message ${messageId}`);
    }
    return this.opts.targetRouter.project({
      chatId: message.chatId,
      threadId: message.threadId,
    });
  }

  /**
   * Send one binding-notification card, best effort: bounded, retried once,
   * and silent once the session lifecycle that asked for it has ended. Where
   * it lands is entirely `input.target`'s: the caller resolves that from
   * persisted routing state before calling this, which only sends and never
   * guesses a landing place of its own.
   */
  async sendNotification(input: {
    target: OutboundTarget;
    card: unknown;
    logFields: Record<string, unknown>;
  }): Promise<string | undefined> {
    const { lifecycle } = this.opts;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!lifecycle.isLive()) return undefined;
      const requestController = new AbortController();
      const abortRequest = (): void => requestController.abort();
      lifecycle.signal.addEventListener('abort', abortRequest, { once: true });
      if (lifecycle.signal.aborted) abortRequest();
      try {
        const result = await runFeishuBoundedOperation({
          signal: lifecycle.signal,
          deadlineAt: Date.now() + FEISHU_BINDING_NOTIFICATION_SEND_TIMEOUT_MS,
          operation: () =>
            this.sendCard({
              target: input.target,
              card: input.card,
              signal: requestController.signal,
              mode: 'background',
            }),
        });
        return result.messages[0]?.messageId;
      } catch (err) {
        if (isFeishuOperationError(err, 'aborted')) return undefined;
        requestController.abort();
        const retrying = attempt === 1 && lifecycle.isLive();
        this.opts.log.warn(
          {
            ...input.logFields,
            attempt,
            err: { message: errorMessage(err) },
          },
          retrying
            ? 'Feishu binding notification failed; retrying once'
            : 'Feishu binding notification failed after retry',
        );
        if (!retrying) return undefined;
      } finally {
        lifecycle.signal.removeEventListener('abort', abortRequest);
      }
    }
    return undefined;
  }
}
