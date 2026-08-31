/**
 * Where a Feishu message actually arrived, in Feishu's own terms.
 *
 * The router answers one question for inbound — which target is this, and does
 * it sit inside a container that may be a Collaboration Space — and keeps two
 * small session-local ledgers so outbound work can address a place it has
 * actually seen. Nothing here leaves the package: Core is told a `team_name`
 * and nothing about chats, threads, or topic mode.
 *
 * Topic detection needs one platform lookup, so it is cached per chat, bounded,
 * and fails open: a chat whose mode cannot be established is treated as an
 * ordinary group, which routes the message to the group binding rather than
 * inventing a topic that may not exist.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { FeishuChatMode } from '@excitedjs/feishu-transport';

import type { ChannelOutboundTarget, FeishuInboundEvent } from './bot.js';
import {
  FeishuOperationError,
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from './feishu-bounded-operation.js';
import {
  chatTarget,
  targetKey,
  topicTarget,
  type FeishuTarget,
} from './routing/target.js';

const FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS = 2_000;
/** Session-local ledgers are display/addressing aids, never authority. */
const FEISHU_OBSERVED_MESSAGES_MAX = 4_096;

interface FeishuChatModeReader {
  getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>;
}

export interface FeishuInboundRoute {
  readonly target: FeishuTarget;
  /**
   * The chat a Collaboration Space policy could be registered on. Only a topic
   * has one: an ordinary group is a target, not a container of targets.
   */
  readonly containerChatId: string | null;
}

interface FeishuTargetRouterOptions {
  chatModes: FeishuChatModeReader;
  log: DreamuxLogger;
}

export class FeishuTargetRouter {
  private readonly resolvedChatModes = new Map<string, FeishuChatMode>();
  private readonly pendingChatModes = new Map<
    string,
    Promise<FeishuChatMode | undefined>
  >();
  private readonly messageTargets = new Map<string, FeishuTarget>();
  /** The newest message seen in a target, so a topic can be replied into. */
  private readonly targetAnchors = new Map<string, string>();

  constructor(private readonly opts: FeishuTargetRouterOptions) {}

  async projectInbound(
    event: FeishuInboundEvent,
    signal?: AbortSignal,
  ): Promise<FeishuInboundRoute> {
    assertRoutingActive(signal);
    let route: FeishuInboundRoute = {
      target: chatTarget(event.chatId, event.chatType),
      containerChatId: null,
    };
    if (
      event.chatType === 'group' &&
      event.threadId !== undefined &&
      event.threadId !== ''
    ) {
      const mode = await this.chatMode(event.chatId, signal);
      assertRoutingActive(signal);
      if (mode === 'topic') {
        route = {
          target: topicTarget(event.chatId, event.threadId),
          containerChatId: event.chatId,
        };
      }
    }
    assertRoutingActive(signal);
    this.observe(event.messageId, route.target);
    return route;
  }

  /** Record a message this session sent or received against its target. */
  observe(messageId: string, target: FeishuTarget): void {
    if (messageId === '') return;
    if (this.messageTargets.size >= FEISHU_OBSERVED_MESSAGES_MAX) {
      const oldest = this.messageTargets.keys().next();
      if (!oldest.done) this.messageTargets.delete(oldest.value);
    }
    this.messageTargets.set(messageId, target);
    this.targetAnchors.set(targetKey(target), messageId);
  }

  targetForMessage(messageId: string): FeishuTarget | undefined {
    return this.messageTargets.get(messageId);
  }

  /**
   * Where a Channel-authored notification about a target should be sent.
   *
   * A topic is only addressable by replying under a message already in it, so
   * a topic this session has never seen falls back to its parent chat rather
   * than being dropped: the operator who just bound it is in that chat.
   */
  notificationTarget(target: FeishuTarget): ChannelOutboundTarget {
    if (target.kind !== 'topic') return { conversationId: target.chatId };
    const anchor = this.targetAnchors.get(targetKey(target));
    return anchor === undefined
      ? { conversationId: target.chatId }
      : { conversationId: target.chatId, replyTo: anchor };
  }

  private async chatMode(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<FeishuChatMode | undefined> {
    assertRoutingActive(signal);
    const cached = this.resolvedChatModes.get(chatId);
    if (cached !== undefined) return cached;
    const pending = this.pendingChatModes.get(chatId);
    if (pending !== undefined) {
      const mode = await pending;
      assertRoutingActive(signal);
      if (mode !== undefined) this.resolvedChatModes.set(chatId, mode);
      return mode;
    }

    const lookup = this.lookupChatMode(chatId);
    this.pendingChatModes.set(chatId, lookup);
    try {
      const mode = await lookup;
      assertRoutingActive(signal);
      if (mode !== undefined) this.resolvedChatModes.set(chatId, mode);
      return mode;
    } finally {
      if (this.pendingChatModes.get(chatId) === lookup) {
        this.pendingChatModes.delete(chatId);
      }
    }
  }

  private async lookupChatMode(
    chatId: string,
  ): Promise<FeishuChatMode | undefined> {
    const getChatMode = this.opts.chatModes.getChatMode;
    if (getChatMode === undefined) {
      this.warnUnknownMode(chatId, 'chat_mode_lookup_unavailable');
      return undefined;
    }
    try {
      const mode = await withChatModeTimeout(
        getChatMode.call(this.opts.chatModes, chatId),
      );
      if (mode !== undefined) return mode;
      this.warnUnknownMode(chatId, 'missing_or_unknown_chat_mode');
      return undefined;
    } catch (err) {
      this.warnUnknownMode(
        chatId,
        isFeishuOperationError(err, 'deadline')
          ? 'chat_mode_lookup_timed_out'
          : 'chat_mode_lookup_failed',
        safeError(err),
      );
      return undefined;
    }
  }

  private warnUnknownMode(
    chatId: string,
    reason: string,
    err?: { name?: string; message: string },
  ): void {
    this.opts.log.warn(
      { chat_id: chatId, reason, ...(err !== undefined ? { err } : {}) },
      'could not verify Feishu topic-group mode; ' +
        'treating inbound as an ordinary group',
    );
  }
}

function assertRoutingActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new FeishuOperationError('aborted');
  }
}

function withChatModeTimeout(
  promise: Promise<FeishuChatMode | undefined>,
): Promise<FeishuChatMode | undefined> {
  return runFeishuBoundedOperation({
    operation: () => promise,
    deadlineAt: Date.now() + FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS,
  });
}

function safeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return {
      ...(err.name !== '' ? { name: err.name } : {}),
      message: err.message,
    };
  }
  return { message: String(err) };
}
