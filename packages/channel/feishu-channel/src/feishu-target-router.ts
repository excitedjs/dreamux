import type {
  ChannelContainer,
  ChannelTarget,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type { FeishuChatMode } from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from './bot.js';

interface FeishuChatModeReader {
  getChatMode?(chatId: string): Promise<FeishuChatMode | undefined>;
}

export interface FeishuInboundRoute {
  target: ChannelTarget;
  container?: ChannelContainer;
}

interface FeishuTargetRouterOptions {
  chatModes: FeishuChatModeReader;
  log: DreamuxLogger;
}

/**
 * Provider-owned routing capability for Feishu inbound and outbound selectors.
 * It is the single normalization point for targets carried to core and targets
 * recorded for later TeamLeader egress authorization.
 */
export class FeishuTargetRouter {
  private readonly resolvedChatModes = new Map<string, FeishuChatMode>();
  private readonly pendingChatModes = new Map<
    string,
    Promise<FeishuChatMode | undefined>
  >();
  private readonly messageTargets = new Map<string, ChannelTarget>();

  constructor(private readonly opts: FeishuTargetRouterOptions) {}

  async projectInbound(event: FeishuInboundEvent): Promise<FeishuInboundRoute> {
    let route: FeishuInboundRoute = {
      target: chatTarget(event.chatId, event.chatType),
    };
    if (
      event.chatType === 'group' &&
      event.threadId !== undefined &&
      event.threadId !== ''
    ) {
      const mode = await this.chatMode(event.chatId);
      if (mode === 'topic') {
        route = topicRoute(event);
      }
    }
    this.messageTargets.set(event.messageId, route.target);
    return route;
  }

  resolveTarget(meta: unknown): ChannelTarget {
    const selector = asRecord(meta);
    const messageId = optionalString(selector, 'message_id');
    if (messageId !== undefined) {
      const recorded = this.messageTargets.get(messageId);
      if (recorded !== undefined) {
        assertRecordedSelectorMatches(selector, recorded);
        return recorded;
      }
    }

    const chatId = requiredString(selector, 'chat_id');
    const threadId = optionalString(selector, 'thread_id');
    if (threadId !== undefined) {
      throw new Error(
        'feishu resolveTarget requires an observed message_id for topic replies',
      );
    }
    return chatTarget(chatId, selector['chat_type'] === 'p2p' ? 'p2p' : 'group');
  }

  messageBelongsToTarget(messageId: string, target: ChannelTarget): boolean {
    const recorded = this.messageTargets.get(messageId);
    return recorded !== undefined && targetsMatch(recorded, target);
  }

  messageBelongsToChat(messageId: string, chatId: string): boolean {
    const recorded = this.messageTargets.get(messageId);
    return recorded !== undefined && targetChatId(recorded) === chatId;
  }

  private async chatMode(chatId: string): Promise<FeishuChatMode | undefined> {
    const cached = this.resolvedChatModes.get(chatId);
    if (cached !== undefined) return cached;
    const pending = this.pendingChatModes.get(chatId);
    if (pending !== undefined) return pending;

    const lookup = this.lookupChatMode(chatId);
    this.pendingChatModes.set(chatId, lookup);
    try {
      return await lookup;
    } finally {
      if (this.pendingChatModes.get(chatId) === lookup) {
        this.pendingChatModes.delete(chatId);
      }
    }
  }

  private async lookupChatMode(chatId: string): Promise<FeishuChatMode | undefined> {
    const getChatMode = this.opts.chatModes.getChatMode;
    if (getChatMode === undefined) {
      this.opts.log.warn(
        { chat_id: chatId, reason: 'chat_mode_lookup_unavailable' },
        'could not verify Feishu topic-group mode; treating inbound as an ordinary group',
      );
      return undefined;
    }
    try {
      const mode = await getChatMode.call(this.opts.chatModes, chatId);
      if (mode !== undefined) {
        this.resolvedChatModes.set(chatId, mode);
        return mode;
      }
      this.opts.log.warn(
        { chat_id: chatId, reason: 'missing_or_unknown_chat_mode' },
        'could not verify Feishu topic-group mode; treating inbound as an ordinary group',
      );
      return undefined;
    } catch (err) {
      this.opts.log.warn(
        {
          chat_id: chatId,
          reason: 'chat_mode_lookup_failed',
          err: safeError(err),
        },
        'could not verify Feishu topic-group mode; treating inbound as an ordinary group',
      );
      return undefined;
    }
  }
}

function topicRoute(event: FeishuInboundEvent): FeishuInboundRoute {
  const threadId = event.threadId;
  if (threadId === undefined || threadId === '') {
    throw new Error('topicRoute requires a non-empty thread id');
  }
  return {
    target: topicTarget({
      chatId: event.chatId,
      threadId,
      ...(event.rootId !== undefined ? { rootId: event.rootId } : {}),
      ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
    }),
    container: {
      container_type: 'topic_group',
      container_key: event.chatId,
      meta: { chat_id: event.chatId, chat_mode: 'topic' },
    },
  };
}

function topicTarget(input: {
  chatId: string;
  threadId: string;
  rootId?: string;
  parentId?: string;
}): ChannelTarget {
  return {
    target_type: 'topic',
    target_key: input.threadId,
    bindable: true,
    meta: {
      chat_id: input.chatId,
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: input.threadId,
      ...(input.rootId !== undefined ? { root_id: input.rootId } : {}),
      ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
    },
  };
}

function chatTarget(chatId: string, rawType: string): ChannelTarget {
  const chatType = rawType === 'p2p' ? 'p2p' : 'group';
  return {
    target_type: chatType,
    target_key: chatId,
    bindable: chatType === 'group',
    meta: { chat_id: chatId, chat_type: chatType },
  };
}

function targetsMatch(left: ChannelTarget, right: ChannelTarget): boolean {
  return left.target_type === right.target_type &&
    left.target_key === right.target_key &&
    targetChatId(left) === targetChatId(right);
}

function targetChatId(target: ChannelTarget): string | undefined {
  const chatId = target.meta?.['chat_id'];
  return typeof chatId === 'string' && chatId !== '' ? chatId : undefined;
}

function assertRecordedSelectorMatches(
  selector: Record<string, unknown>,
  recorded: ChannelTarget,
): void {
  assertOptionalSelector(selector, 'chat_id', targetChatId(recorded));
  assertOptionalSelector(
    selector,
    'thread_id',
    stringMeta(recorded, 'thread_id'),
  );
  assertOptionalSelector(
    selector,
    'chat_type',
    stringMeta(recorded, 'chat_type'),
  );
  assertOptionalSelector(
    selector,
    'chat_mode',
    stringMeta(recorded, 'chat_mode'),
  );
}

function assertOptionalSelector(
  selector: Record<string, unknown>,
  key: string,
  expected: string | undefined,
): void {
  if (!(key in selector)) return;
  const value = selector[key];
  if (typeof value !== 'string' || value === '' || value !== expected) {
    throw new Error(
      `feishu resolveTarget ${JSON.stringify(key)} conflicts with the recorded message target`,
    );
  }
}

function stringMeta(target: ChannelTarget, key: string): string | undefined {
  const value = target.meta?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(selector: Record<string, unknown>, key: string): string {
  const value = optionalString(selector, key);
  if (value === undefined) {
    throw new Error(`feishu resolveTarget requires a non-empty ${key}`);
  }
  return value;
}

function optionalString(
  selector: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = selector[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
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
