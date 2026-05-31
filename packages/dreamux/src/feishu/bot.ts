/**
 * The `FeishuBot` adapter — one per Dispatcher (D3: 1 Dispatcher = 1 Bot).
 *
 * Since issue #25 PR1 this is a thin adapter over `@excitedjs/feishu-transport`
 * (the shared platform-I/O core): all Feishu SDK I/O — the inbound WebSocket,
 * markdown→card render, content parse, the outbound message API — lives in the
 * core, the single importer of `@larksuiteoapi/node-sdk`. This file only shapes
 * the core's surface into the `FeishuBot` interface the server already wires:
 *   - `start(handler)` registers the `im.message.receive_v1` route, normalizes
 *     each raw event with the core's `parseInbound`, and forwards a
 *     `FeishuInboundEvent`. The route handler awaits `handler`, so the message is
 *     durably enqueued before the SDK acks (the deferred-ACK invariant).
 *   - `send(target, text)` delegates to the core transport, preserving reply
 *     threading / @-back metadata from the durable inbound row.
 *   - `botOpenId` surfaces the core transport's `selfId`.
 *
 * Tests inject a `FakeFeishuBot` via `createFakeFeishuBot()` instead of opening
 * a live connection.
 */

import {
  createFeishuTransport,
  narrowMetaFromEvent,
  parseInbound,
  toChannelInbound,
  type Mention,
  type OutboundTarget,
} from '@excitedjs/feishu-transport';

import type { ChannelOutboundTarget } from '../channel/outbound.js';

/** The Feishu event_type carrying inbound chat messages. */
const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';

export interface FeishuInboundEvent {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group' | ...
  senderId: string;
  senderType: string;
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

export interface FeishuSendResult {
  /** message_id of each card sent, in order. Empty if Feishu omitted ids. */
  messageIds: string[];
}

export interface FeishuBot {
  readonly appId: string;
  readonly botOpenId: string | undefined;
  start(handler: InboundHandler): Promise<void>;
  send(target: OutboundTarget, text: string): Promise<FeishuSendResult>;
  close(): Promise<void>;
}

export interface CreateBotOptions {
  appId: string;
  appSecret: string;
}

export function createFeishuBot(opts: CreateBotOptions): FeishuBot {
  const transport = createFeishuTransport({
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

    async start(handler: InboundHandler): Promise<void> {
      // The core opens the WebSocket and awaits this route handler before the
      // SDK acks; awaiting `handler` here keeps the enqueue durable-before-ACK.
      // `start` rejects if the connection does not come up, so the server's
      // try/catch can fail the dispatcher loudly rather than leave it dark.
      await transport.start({
        [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
          const event = normalizeInboundEvent(raw);
          if (event === null) return;
          await handler(event);
        },
      });
    },

    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      const { messageIds } = await transport.send(target, text);
      return { messageIds };
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

  if (messageId === '' || chatId === '') return null;

  return {
    messageId,
    chatId,
    chatType,
    senderId,
    senderType,
    messageType,
    rawContent,
    parsedText: payload.text,
    mentions,
    createTime,
    raw,
  };
}

// -------------------------------------------------------------- fake (tests)

export interface FakeFeishuBot extends FeishuBot {
  readonly sentMessages: Array<{
    chatId: string;
    target: OutboundTarget;
    text: string;
    messageIds: string[];
  }>;
  inject(event: FeishuInboundEvent): Promise<void>;
  setSendError(err: Error | null): void;
}

export function createFakeFeishuBot(appId: string = 'fake_bot'): FakeFeishuBot {
  const sent: Array<{
    chatId: string;
    target: OutboundTarget;
    text: string;
    messageIds: string[];
  }> = [];
  let handler: InboundHandler | null = null;
  let nextMessageId = 1;
  let sendError: Error | null = null;
  const openId: string | undefined = `ou_${appId}`;

  return {
    appId,
    get botOpenId(): string | undefined {
      return openId;
    },
    async start(h: InboundHandler): Promise<void> {
      handler = h;
    },
    async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
      if (sendError !== null) {
        throw sendError;
      }
      const id = `om_fake_${nextMessageId++}`;
      sent.push({ chatId: target.chatId, target, text, messageIds: [id] });
      return { messageIds: [id] };
    },
    async close(): Promise<void> {
      handler = null;
    },
    get sentMessages() {
      return sent;
    },
    async inject(event: FeishuInboundEvent): Promise<void> {
      if (handler === null) throw new Error('fake bot not started');
      await handler(event);
    },
    setSendError(err: Error | null): void {
      sendError = err;
    },
  };
}
