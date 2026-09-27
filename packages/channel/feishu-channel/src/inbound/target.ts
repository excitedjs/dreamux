/**
 * Which target an inbound Feishu message sits in, in Feishu's own terms.
 *
 * This answers one question, for inbound only — which target is this, and
 * does it sit inside a container that may be a Collaboration Space. It does
 * not read or write a binding: that is `FeishuRouting`'s job, once this has
 * named the target to look one up for. Nothing here leaves the package: Core
 * is told a `team_name` and nothing about chats, threads, or topic mode.
 *
 * Topic detection needs one platform lookup, so successful resolutions are
 * cached per chat for the session (failures and unknown modes are not cached,
 * so the next accepted inbound retries) and it fails open: a chat whose mode cannot be established is treated as an
 * ordinary group, which routes the message to the group binding rather than
 * inventing a topic that may not exist.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuChatMode,
  FeishuInboundEvent,
} from '@excitedjs/feishu-transport';

import {
  FeishuOperationError,
  isFeishuOperationError,
  runFeishuBoundedOperation,
} from '../feishu-bounded-operation.js';
import {
  chatTarget,
  topicTarget,
  type FeishuTarget,
} from '../routing/target.js';

const FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS = 2_000;

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

interface FeishuInboundTargetingOptions {
  chatModes: FeishuChatModeReader;
  log: DreamuxLogger;
}

/** Resolves which target and container an inbound event's place names. */
export class FeishuInboundTargeting {
  private readonly resolvedChatModes = new Map<string, FeishuChatMode>();
  private readonly pendingChatModes = new Map<
    string,
    Promise<FeishuChatMode | undefined>
  >();

  constructor(private readonly opts: FeishuInboundTargetingOptions) {}

  async projectInbound(
    event: FeishuInboundEvent,
    signal?: AbortSignal,
  ): Promise<FeishuInboundRoute> {
    assertRoutingActive(signal);
    const route = await this.project(
      {
        chatId: event.chatId,
        chatType: event.chatType,
        threadId: event.threadId,
      },
      signal,
    );
    assertRoutingActive(signal);
    return route;
  }

  /**
   * Which target a message sits in, from the place Feishu reports for it.
   *
   * A thread id is only half the answer: outside a topic-mode group it names a
   * reply chain rather than a topic, so the chat's mode decides — and that
   * lookup is spent only on a message that claims a thread at all. `chatType`
   * is absent for a message read back from the API, which reports none; an
   * ordinary group is what this already assumes for a chat it cannot name,
   * and the two kinds differ only in whether a binding could exist.
   */
  async project(
    place: { chatId: string; threadId?: string | undefined; chatType?: string },
    signal?: AbortSignal,
  ): Promise<FeishuInboundRoute> {
    const chatType = place.chatType ?? 'group';
    if (
      chatType === 'group' &&
      place.threadId !== undefined &&
      place.threadId !== ''
    ) {
      const mode = await this.chatMode(place.chatId, signal);
      assertRoutingActive(signal);
      if (mode === 'topic') {
        return {
          target: topicTarget(place.chatId, place.threadId),
          containerChatId: place.chatId,
        };
      }
    }
    return {
      target: chatTarget(place.chatId, chatType),
      containerChatId: null,
    };
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
      { chat_id: chatId, reason, err },
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
