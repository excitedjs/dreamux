/**
 * The `FeishuBot` adapter — one per Dispatcher (D3: 1 Dispatcher = 1 Bot).
 *
 * Since issue #25 PR1 this is a thin adapter over `@excitedjs/feishu-transport`
 * (the shared platform-I/O core): all Feishu SDK I/O — the inbound WebSocket,
 * markdown→card render, content parse, the outbound message API — lives in the
 * core, the single importer of `@larksuiteoapi/node-sdk`. This file only shapes
 * the core's surface into the `FeishuBot` interface the server already wires:
 *   - `start(routes)` takes one handler per Feishu event type (issue #62 seam):
 *     `onMessage` for `im.message.receive_v1` (normalized via the core's
 *     `parseInbound` into a `FeishuInboundEvent`) and an optional
 *     `onBotMemberAdded` for `im.chat.member.bot.added_v1`. Each route awaits
 *     its handler, so the server gates and submits accepted inbound before the
 *     SDK acks.
 *   - `send(target, text)` delegates to the core transport, preserving reply
 *     threading / @-back metadata from the in-memory inbound batch.
 *   - `botOpenId` surfaces the core transport's `selfId`.
 *
 * Tests inject a `FakeFeishuBot` via `createFakeFeishuBot()` instead of opening
 * a live connection.
 */

import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  createFeishuTransport,
  narrowMetaFromEvent,
  normalizeBotMemberAddedEvent,
  parseInbound,
  toChannelInbound,
  type FeishuBotMemberAddedEvent,
  type FeishuTransport,
  type Mention,
  type OutboundTarget,
} from '@excitedjs/feishu-transport';

/** The Feishu event_type carrying inbound chat messages. */
const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';

export interface FeishuInboundEvent {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group' | ...
  senderId: string;
  senderType: string;
  /**
   * Best-effort display name seam for future enrichers. Feishu
   * im.message.receive_v1 does not provide this in the native event envelope,
   * so the normal value is intentionally an empty string.
   */
  senderName: string;
  messageType: string;
  /** Raw JSON-encoded content as Feishu delivered it. */
  rawContent: string;
  /** Parsed text after the core's content flattening / mention substitution. */
  parsedText: string;
  mentions: Mention[];
  createTime: string;
  /** The full original Feishu event payload (for storage / audit). */
  raw: unknown;
}

export type InboundHandler = (event: FeishuInboundEvent) => void | Promise<void>;

export type BotMemberAddedHandler = (
  event: FeishuBotMemberAddedEvent,
) => void | Promise<void>;

/**
 * The typed event-route seam (issue #62 Phase 1). `start` takes one handler per
 * Feishu event type instead of a single message handler, so a new event type is
 * wired by adding a field here and a transport route, without growing branches
 * in `Server`. This is a small typed seam, not yet a generic
 * `eventType -> handler` registry; if a third event type lands, promote this to
 * a map. Each route still awaits its handler before the SDK acks
 * (queue-before-ACK).
 */
export interface FeishuInboundRoutes {
  /** `im.message.receive_v1` — a chat message. */
  onMessage: InboundHandler;
  /** `im.chat.member.bot.added_v1` — the bot was added to a chat. Optional. */
  onBotMemberAdded?: BotMemberAddedHandler;
}

export interface FeishuSendResult {
  /** message_id of each card sent, in order. Empty if Feishu omitted ids. */
  messageIds: string[];
}

export interface FeishuBot {
  readonly appId: string;
  readonly botOpenId: string | undefined;
  start(routes: FeishuInboundRoutes): Promise<void>;
  send(target: OutboundTarget, text: string): Promise<FeishuSendResult>;
  addReaction(messageId: string, emoji: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface CreateBotOptions {
  appId: string;
  appSecret: string;
}

export interface CreateFeishuBotDeps {
  createTransport?: (opts: CreateBotOptions) => FeishuTransport;
}

export interface ChannelOutboundTarget {
  /** Stable channel-local conversation id. */
  conversationId: string;
  /** Optional channel-local source message to thread under. */
  replyTo?: string;
  /** Optional channel-local participants to bring into the reply. */
  mentionUsers?: string[];
  /** Optional host/runtime routing hint, opaque to the channel adapter. */
  conversationKey?: string;
}

export function createFeishuBot(
  opts: CreateBotOptions,
  deps: CreateFeishuBotDeps = {},
): FeishuBot {
  const transport = deps.createTransport?.(opts) ??
    createFeishuTransport({
      appId: opts.appId,
      appSecret: opts.appSecret,
    });

  return {
    get appId(): string {
      return transport.appId;
    },
    get botOpenId(): string | undefined {
      return transport.selfId;
    },

    async start(routes: FeishuInboundRoutes): Promise<void> {
      // The core opens the WebSocket and awaits each route handler before the
      // SDK acks; awaiting here keeps gate/submission work before ACK.
      // `start` rejects if the connection does not come up, so the server's
      // try/catch can fail the dispatcher loudly rather than leave it dark.
      const table: Record<string, (raw: unknown) => Promise<void>> = {
        [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
          const event = normalizeInboundEvent(raw);
          if (event === null) return;
          await routes.onMessage(event);
        },
      };
      if (routes.onBotMemberAdded !== undefined) {
        const onBotMemberAdded = routes.onBotMemberAdded;
        table[BOT_MEMBER_ADDED_EVENT_TYPE] = async (raw: unknown) => {
          const event = normalizeBotMemberAddedEvent(raw);
          if (event === null) return;
          await onBotMemberAdded(event);
        };
      }
      await transport.start(table);
    },

    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      const { messageIds } = await transport.send(target, text);
      return { messageIds };
    },

    addReaction(messageId: string, emoji: string): Promise<string> {
      return transport.addReaction(messageId, emoji);
    },

    removeReaction(messageId: string, reactionId: string): Promise<void> {
      return transport.removeReaction(messageId, reactionId);
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}

export function channelOutboundToFeishuTarget(
  target: ChannelOutboundTarget,
): OutboundTarget {
  return {
    chatId: target.conversationId,
    ...(target.replyTo !== undefined
      ? { replyToMessageId: target.replyTo }
      : {}),
    ...(target.mentionUsers !== undefined
      ? { mentionUserIds: target.mentionUsers }
      : {}),
    ...(target.conversationKey !== undefined
      ? { conversationKey: target.conversationKey }
      : {}),
  };
}

/**
 * Reshape a raw `im.message.receive_v1` payload into a `FeishuInboundEvent`,
 * using the core's `parseInbound` + `narrowMetaFromEvent` + `toChannelInbound`
 * for content flattening and event-envelope metadata. Returns `null` for a
 * payload missing the message_id or chat_id that make it routable.
 */
function normalizeInboundEvent(raw: unknown): FeishuInboundEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = (root['event'] ?? root) as Record<string, unknown>;
  const message = (event['message'] ?? {}) as Record<string, unknown>;
  const messageType = (message['message_type'] as string) ?? '';
  const rawContent = (message['content'] as string) ?? '';
  const mentions = (message['mentions'] as Mention[] | undefined) ?? [];
  const parsed = parseInbound({
    message_type: messageType,
    content: rawContent,
    mentions,
  });
  const payload = toChannelInbound({
    ...parsed,
    meta: narrowMetaFromEvent(raw),
  });
  const messageId = payload.meta['message_id'] ?? '';
  const chatId = payload.meta['chat_id'] ?? '';
  const chatType = payload.meta['chat_type'] ?? '';
  const senderId = payload.meta['sender_id'] ?? '';
  const senderType = payload.meta['sender_type'] ?? '';
  const createTime = payload.meta['create_time'] ?? '';
  const senderName = extractSenderName(raw);

  if (messageId === '' || chatId === '') return null;

  return {
    messageId,
    chatId,
    chatType,
    senderId,
    senderType,
    senderName,
    messageType,
    rawContent,
    parsedText: payload.text,
    mentions,
    createTime,
    raw,
  };
}

function extractSenderName(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const root = raw as Record<string, unknown>;
  const event = asRecord(root['event']) ?? root;
  const sender = asRecord(event['sender']);
  if (sender === undefined) return '';
  return firstString(
    sender['sender_name'],
    sender['display_name'],
    sender['name'],
    sender['user_name'],
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// -------------------------------------------------------------- fake (tests)

export interface FakeFeishuBot extends FeishuBot {
  readonly sentMessages: Array<{
    chatId: string;
    target: OutboundTarget;
    text: string;
    messageIds: string[];
  }>;
  readonly reactions: Array<{
    messageId: string;
    emoji: string;
    reactionId: string;
  }>;
  readonly removedReactions: Array<{
    messageId: string;
    reactionId: string;
  }>;
  inject(event: FeishuInboundEvent): Promise<void>;
  injectBotMemberAdded(event: FeishuBotMemberAddedEvent): Promise<void>;
  setSendError(err: Error | null): void;
  setReactionError(err: Error | null): void;
  setRemoveReactionError(err: Error | null): void;
}

export function createFakeFeishuBot(appId: string = 'fake-bot'): FakeFeishuBot {
  const sent: Array<{
    chatId: string;
    target: OutboundTarget;
    text: string;
    messageIds: string[];
  }> = [];
  let routes: FeishuInboundRoutes | null = null;
  let nextMessageId = 1;
  let nextReactionId = 1;
  let sendError: Error | null = null;
  let reactionError: Error | null = null;
  let removeReactionError: Error | null = null;
  const openId: string | undefined = `fake-open-id-${appId}`;
  const reactions: Array<{
    messageId: string;
    emoji: string;
    reactionId: string;
  }> = [];
  const removedReactions: Array<{
    messageId: string;
    reactionId: string;
  }> = [];

  return {
    appId,
    get botOpenId(): string | undefined {
      return openId;
    },
    async start(r: FeishuInboundRoutes): Promise<void> {
      routes = r;
    },
    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      if (sendError !== null) {
        throw sendError;
      }
      const id = `message-fake-${nextMessageId++}`;
      sent.push({ chatId: target.chatId, target, text, messageIds: [id] });
      return { messageIds: [id] };
    },
    async addReaction(messageId: string, emoji: string): Promise<string> {
      if (reactionError !== null) {
        throw reactionError;
      }
      const reactionId = `reaction-fake-${nextReactionId++}`;
      reactions.push({ messageId, emoji, reactionId });
      return reactionId;
    },
    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      if (removeReactionError !== null) {
        throw removeReactionError;
      }
      removedReactions.push({ messageId, reactionId });
    },
    async close(): Promise<void> {
      routes = null;
    },
    get sentMessages() {
      return sent;
    },
    get reactions() {
      return reactions;
    },
    get removedReactions() {
      return removedReactions;
    },
    async inject(event: FeishuInboundEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onMessage(event);
    },
    async injectBotMemberAdded(event: FeishuBotMemberAddedEvent): Promise<void> {
      if (routes === null) throw new Error('fake bot not started');
      await routes.onBotMemberAdded?.(event);
    },
    setSendError(err: Error | null): void {
      sendError = err;
    },
    setReactionError(err: Error | null): void {
      reactionError = err;
    },
    setRemoveReactionError(err: Error | null): void {
      removeReactionError = err;
    },
  };
}
