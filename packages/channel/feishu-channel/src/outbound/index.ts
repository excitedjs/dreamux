/**
 * Every message this Channel sends, in one place.
 *
 * A reply, a card, a reaction, a locate-by-message-id, and a best-effort
 * notification are the whole of what this session puts onto the platform.
 * Keeping them on one object is what lets every send read its own landing
 * chat/topic straight off Feishu's create/reply response, instead of a
 * session-local ledger guessing it from whichever message this instance last
 * happened to see in that conversation — a guess that is wrong the moment two
 * conversations interleave. A card repaint (`editCard`) is not one of these:
 * it takes an already-known message id and returns nothing to read a landing
 * off, so callers that hold a `FeishuBot` reach it there directly.
 *
 * Where a message lands is decided in one place, `resolveTarget`, for every
 * send that puts a message into a chat: `sendText` and `sendCard` both go
 * through it, and so do the notices `notify` sends. A send that names a
 * message replies under it as is. One that names none is a fresh top-level
 * message, except that an agent sending it into a Collaboration Space chat
 * must not silently open a brand new topic on its behalf: it is routed to the
 * calling Team's own bound topic when exactly one exists, and refused
 * otherwise. The Channel's own sends (a notice, an answer to an inbound
 * message) name their conversation themselves and are never re-addressed.
 * `notify` adds one policy of its own: a notice into a topic replies under
 * that topic's root, and when its caller has none the root is asked of Feishu
 * and remembered on the route. Every other method is a thin, logged wrapper
 * over the transport.
 */
import { describeTarget, type FeishuTarget } from '../routing/target.js';
import type { ChannelMcpCaller, DreamuxLogger } from '@excitedjs/dreamux-types';
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
const FEISHU_TOPIC_ROOT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Who a send speaks for, which decides what an omitted message address means.
 *
 * An agent — a TeamLeader, or the Dispatcher Agent, which owns no Team — that
 * leaves the message out has not chosen a conversation, so in a Collaboration
 * Space chat its address is derived from its own binding. The Channel itself
 * never derives one: a notice or an answer to an inbound message names its
 * conversation with what it sends, and a chat-level message is then exactly
 * what was asked for.
 */
export type FeishuSender =
  | { readonly kind: 'channel' }
  | { readonly kind: 'agent'; readonly teamName: string | null };

export const CHANNEL_SENDER: FeishuSender = { kind: 'channel' };

/**
 * The sender behind an MCP call. A call with no caller (an extension's
 * background work) is an agent with no Team: it derives nothing, so in a
 * Collaboration Space chat it has to name its message.
 */
export function agentSender(
  caller: ChannelMcpCaller | undefined,
): FeishuSender {
  return {
    kind: 'agent',
    teamName: caller?.kind === 'team_leader' ? caller.team_name : null,
  };
}

/**
 * The routing facts address resolution needs, and the one write a notification
 * makes when it learns a topic's root from the platform.
 */
type FeishuOutboundRouting = Pick<
  FeishuRouting,
  'spaceForContainer' | 'topicBindingsFor' | 'fillTopicRoot'
>;

/** `locate`'s own inbound-projection need, and no more. */
type FeishuOutboundTargeting = Pick<FeishuInboundTargeting, 'project'>;

export interface FeishuOutboundOptions {
  readonly bot: FeishuBot;
  readonly log: DreamuxLogger;
  readonly dispatcherId: string;
  readonly channelId: string;
  /** This handle's session lifecycle; a send after it ends aborts. */
  readonly lifecycle: FeishuLifecycle;
  readonly routing: FeishuOutboundRouting;
  readonly targetRouter: FeishuOutboundTargeting;
}

export class FeishuOutbound {
  constructor(private readonly opts: FeishuOutboundOptions) {}

  /**
   * Announce a route or space change, best effort, and never awaited by the
   * change that caused it.
   *
   * `onSent` is told the id of the card only after the platform accepted it:
   * a notice that was skipped, failed, or outlived its session never calls
   * it, so a caller can act on "the card is on screen" and on nothing weaker.
   */
  notify(
    target: FeishuTarget,
    card: unknown,
    replyTo: string | null,
    onSent?: (messageId: string) => void,
  ): void {
    if (!this.opts.lifecycle.isLive()) return;
    void this.opts.lifecycle
      .track(this.sendBindingNotification(target, card, replyTo, onSent))
      .catch(() => undefined);
  }

  private async sendBindingNotification(
    target: FeishuTarget,
    card: unknown,
    replyTo: string | null,
    onSent: ((messageId: string) => void) | undefined,
  ): Promise<void> {
    let replyRoot = replyTo;
    if (target.kind === 'topic' && replyRoot === null) {
      // The caller has no root for this topic: a manual bind never supplies
      // one, and a row from before roots were persisted has none until a
      // message arrives in it. Replying under nothing would land in the wrong
      // place (a fresh top-level message opens a topic of its own), so the
      // platform is asked instead, and the notice is dropped only when it
      // cannot answer.
      replyRoot = await this.readTopicRoot(target);
      if (replyRoot === null) {
        this.opts.log.info(
          {
            dispatcher_id: this.opts.dispatcherId,
            channel_id: this.opts.channelId,
            target: describeTarget(target),
          },
          'Feishu binding notification skipped: no root message could be established for the topic',
        );
        return;
      }
    }
    const messageId = await this.sendNotification({
      target: {
        chatId: target.chatId,
        ...(replyRoot !== null ? { replyToMessageId: replyRoot } : {}),
      },
      card,
      logFields: {
        dispatcher_id: this.opts.dispatcherId,
        channel_id: this.opts.channelId,
        target: describeTarget(target),
      },
    });
    if (messageId !== undefined) onSent?.(messageId);
  }

  /**
   * A topic's root, asked of Feishu by topic id, and remembered on its route.
   *
   * Best effort: a transport that cannot read it, a read that fails, and a
   * topic that lists no message all answer `null`, and the caller drops the
   * notice rather than guess where in the topic to land. What was learned is
   * written back through the routing service, which fills only a row that
   * still lacks a root — the row of a route that was just removed is gone, and
   * that write finds nothing to fill. A write that fails does not cost the
   * notice its landing.
   */
  private async readTopicRoot(target: FeishuTarget): Promise<string | null> {
    const read = this.opts.bot.readThreadRoot;
    const { threadId } = target;
    if (read === undefined || threadId === undefined) return null;
    let root: string | undefined;
    try {
      root = await runFeishuBoundedOperation({
        signal: this.opts.lifecycle.signal,
        deadlineAt: Date.now() + FEISHU_TOPIC_ROOT_LOOKUP_TIMEOUT_MS,
        operation: () => read.call(this.opts.bot, threadId),
      });
    } catch (err) {
      if (isFeishuOperationError(err, 'aborted')) throw err;
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          target: describeTarget(target),
          err: { message: errorMessage(err) },
        },
        'could not read the root message of a Feishu topic',
      );
      return null;
    }
    if (root === undefined) return null;
    try {
      await this.opts.routing.fillTopicRoot(target, root);
    } catch (err) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          channel_id: this.opts.channelId,
          target: describeTarget(target),
          err: { message: errorMessage(err) },
        },
        'could not record the root message read for a Feishu topic',
      );
    }
    return root;
  }

  /**
   * Send a message as a card whose body is Markdown text. Where it lands is
   * `resolveTarget`'s decision; see there for what an omitted `messageId`
   * means.
   */
  async sendText(input: {
    chatId: string;
    text: string;
    messageId?: string | undefined;
    sender: FeishuSender;
  }): Promise<{ messages: readonly FeishuSentMessage[] }> {
    const target = this.resolveTarget(
      {
        chatId: input.chatId,
        ...(input.messageId !== undefined
          ? { replyToMessageId: input.messageId }
          : {}),
      },
      input.sender,
    );
    let result: FeishuSendResult;
    try {
      result = await this.opts.bot.send(target, input.text);
    } catch (err) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          chat_id: target.chatId,
          message_id: target.replyToMessageId,
          err: errorInfo(err),
        },
        'feishu send failed',
      );
      throw err;
    }
    this.opts.log.info(
      {
        dispatcher_id: this.opts.dispatcherId,
        chat_id: target.chatId,
        message_id: target.replyToMessageId,
        message_ids: result.messages.map((m) => m.messageId),
      },
      'feishu message sent',
    );
    return result;
  }

  /**
   * Where a message lands: the one place an address is decided, for text and
   * cards alike.
   *
   * A message the sender named is answered under as is. Without one a send is
   * a fresh top-level message — except when an agent sends it into a
   * Collaboration Space chat, where that would open a new topic on the
   * caller's behalf. There it lands under the calling Team's own bound topic
   * when exactly one exists with a known root, and is refused otherwise: zero
   * or several candidate topics, one with no root yet, and a sender with no
   * Team are all cases a guess would pick the wrong conversation for. The
   * Channel's own sends never derive: a notice into a chat, `bind_space`'s
   * among them, is chat-level because that is the conversation it names.
   */
  private resolveTarget(
    target: OutboundTarget,
    sender: FeishuSender,
  ): OutboundTarget {
    if (target.replyToMessageId !== undefined) return target;
    if (sender.kind === 'channel') return target;
    const { chatId } = target;
    if (this.opts.routing.spaceForContainer(chatId) === undefined) {
      return target;
    }
    const rows = this.opts.routing.topicBindingsFor(chatId, sender.teamName);
    const only = rows.length === 1 ? rows[0] : undefined;
    if (only !== undefined && only.root_message_id !== null) {
      return { chatId, replyToMessageId: only.root_message_id };
    }
    throw new PublicInvokeFailure(
      'This Feishu chat is a Collaboration Space. A send with no ' +
        'message_id only works inside your own bound topic in it, and no ' +
        'such topic with a known root message was found. Pass the ' +
        'message_id you are answering.',
    );
  }

  async sendCard(input: {
    target: OutboundTarget;
    sender: FeishuSender;
    card: unknown;
    signal?: AbortSignal;
    mode?: 'inbound' | 'background';
  }): Promise<{ messages: readonly FeishuSentMessage[] }> {
    this.opts.lifecycle.assertLive();
    const target = this.resolveTarget(input.target, input.sender);
    let result: FeishuSendResult;
    try {
      result = await this.opts.bot.sendCard(
        target,
        input.card,
        input.signal !== undefined ? { signal: input.signal } : undefined,
      );
    } catch (err) {
      if (input.mode !== 'background') {
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            chat_id: target.chatId,
            message_id: target.replyToMessageId,
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
          chat_id: target.chatId,
          message_id: target.replyToMessageId,
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
   * persisted routing state before calling this, which sends as the Channel
   * and so never re-addresses it or guesses a landing place of its own.
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
              sender: CHANNEL_SENDER,
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
