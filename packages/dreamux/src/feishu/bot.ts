/**
 * The `FeishuBot` adapter — one per Dispatcher (D3: 1 Dispatcher = 1 Bot).
 *
 * Adapted from claudemux's `plugins/feishu-channel/src/feishu.ts` but
 * dramatically simplified for the dreamux MVP:
 *   - no single-instance lock — each dispatcher owns its own bot identity
 *     (independent appId/appSecret), so cross-process election is moot
 *   - no doc-comment / reaction / edit paths — P0 sendText only
 *   - no access gate at this layer (issue #2 D12 + P0 Trust Model)
 *
 * The real bot wraps the official `@larksuiteoapi/node-sdk`; tests inject
 * a `FakeFeishuBot` via `createFakeFeishuBot()` instead.
 */

import * as lark from '@larksuiteoapi/node-sdk';

import { parseInbound } from './content.js';
import {
  cardToContent,
  renderMarkdownToCards,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
} from './render.js';

const FEISHU_CARD_CONTENT_SAFE_BYTES = 28 * 1024;
import type { Mention } from './types.js';

export interface FeishuInboundEvent {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group' | ...
  senderId: string;
  messageType: string;
  /** Raw JSON-encoded content as Feishu delivered it. */
  rawContent: string;
  /** Parsed text after `content.ts` flattening / mention substitution. */
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
  sendText(chatId: string, text: string): Promise<FeishuSendResult>;
  close(): Promise<void>;
}

const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';
const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const WS_STARTUP_GRACE_MS = 30_000;

const sdkLogger = {
  error: (...m: unknown[]) => console.error('[feishu-sdk]', ...m),
  warn: (...m: unknown[]) => console.error('[feishu-sdk]', ...m),
  info: (...m: unknown[]) => console.error('[feishu-sdk]', ...m),
  debug: () => {},
  trace: () => {},
};

export interface CreateBotOptions {
  appId: string;
  appSecret: string;
  /** Override SDK client (tests). */
  client?: lark.Client;
}

export function createFeishuBot(opts: CreateBotOptions): FeishuBot {
  const client =
    opts.client ??
    new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      logger: sdkLogger,
    });
  let wsClient: lark.WSClient | undefined;
  let resolvedBotOpenId: string | undefined;

  return {
    appId: opts.appId,
    get botOpenId(): string | undefined {
      return resolvedBotOpenId;
    },

    async start(handler: InboundHandler): Promise<void> {
      resolvedBotOpenId = await resolveBotOpenId(client);

      const dispatcher = new lark.EventDispatcher({
        logger: sdkLogger,
      }).register({
        [IM_MESSAGE_EVENT_TYPE]: async (raw: unknown) => {
          const event = normalizeInboundEvent(raw);
          if (event === null) return;
          await handler(event);
        },
      });

      const ws = new lark.WSClient({
        appId: opts.appId,
        appSecret: opts.appSecret,
        logger: sdkLogger,
        handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
        autoReconnect: true,
        onReady: () => logConn(`bot ${opts.appId} ws ready`),
        onReconnecting: () => logConn(`bot ${opts.appId} ws reconnecting`),
        onReconnected: () => logConn(`bot ${opts.appId} ws reconnected`),
        onError: (err) => logConn(`bot ${opts.appId} ws error: ${err}`),
      });
      wsClient = ws;

      const ready = new Promise<void>((resolve) => {
        const orig = ws.getConnectionStatus;
        void orig; // satisfy lint; SDK lacks a 'ready' Promise, so we poll
        const poll = setInterval(() => {
          if (ws.getConnectionStatus().state === 'connected') {
            clearInterval(poll);
            resolve();
          }
        }, 100);
        // Don't keep the loop alive on this poll alone.
        (poll as { unref?: () => void }).unref?.();
      });

      void ws.start({ eventDispatcher: dispatcher }).catch((err) => {
        logConn(`bot ${opts.appId} ws start failed: ${err}`);
      });

      const cameUp = await Promise.race([
        ready.then(() => true),
        new Promise<boolean>((res) =>
          setTimeout(() => res(false), WS_STARTUP_GRACE_MS),
        ),
      ]);
      if (!cameUp) {
        logConn(
          `bot ${opts.appId} ws did not come up within ${WS_STARTUP_GRACE_MS}ms — closing to break the retry loop`,
        );
        ws.close();
        throw new Error(
          `feishu ws for bot ${opts.appId} did not connect within ${WS_STARTUP_GRACE_MS}ms`,
        );
      }
    },

    async sendText(chatId: string, text: string): Promise<FeishuSendResult> {
      const cards = renderMarkdownToCards(text);
      const ids: string[] = [];
      for (const card of cards) {
        const content = cardToContent(card);
        if (Buffer.byteLength(content, 'utf8') > FEISHU_CARD_CONTENT_SAFE_BYTES) {
          throw new Error(
            `card content exceeds ${FEISHU_CARD_REQUEST_LIMIT_BYTES} byte limit`,
          );
        }
        const res = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content,
          },
        });
        const id = res.data?.message_id;
        if (id) ids.push(id);
      }
      return { messageIds: ids };
    },

    async close(): Promise<void> {
      try {
        wsClient?.close();
      } catch (err) {
        console.error('[feishu] close error', err);
      }
      wsClient = undefined;
    },
  };
}

function normalizeInboundEvent(raw: unknown): FeishuInboundEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = (root['event'] ?? root) as Record<string, unknown>;
  const message = (event['message'] ?? {}) as Record<string, unknown>;
  const sender = (event['sender'] ?? {}) as Record<string, unknown>;
  const senderId =
    ((sender['sender_id'] as Record<string, unknown>)?.['open_id'] as string) ?? '';
  const messageId = (message['message_id'] as string) ?? '';
  const chatId = (message['chat_id'] as string) ?? '';
  const chatType = (message['chat_type'] as string) ?? '';
  const messageType = (message['message_type'] as string) ?? '';
  const rawContent = (message['content'] as string) ?? '';
  const mentions =
    (message['mentions'] as Mention[] | undefined) ?? [];
  const createTime = (message['create_time'] as string) ?? '';

  if (messageId === '' || chatId === '') return null;

  const parsed = parseInbound({
    message_type: messageType,
    content: rawContent,
    mentions,
  });

  return {
    messageId,
    chatId,
    chatType,
    senderId,
    messageType,
    rawContent,
    parsedText: parsed.text,
    mentions,
    createTime,
    raw,
  };
}

async function resolveBotOpenId(
  client: lark.Client,
): Promise<string | undefined> {
  try {
    const res = await client.request<{ bot?: { open_id?: string } }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    return res.bot?.open_id;
  } catch (err) {
    console.error(
      '[feishu] could not resolve bot open_id (groups requiring @-mention will drop messages):',
      err,
    );
    return undefined;
  }
}

function logConn(msg: string): void {
  console.error(`[feishu] ${new Date().toISOString()} ${msg}`);
}

// -------------------------------------------------------------- fake (tests)

export interface FakeFeishuBot extends FeishuBot {
  readonly sentMessages: Array<{ chatId: string; text: string; messageIds: string[] }>;
  inject(event: FeishuInboundEvent): Promise<void>;
  setSendError(err: Error | null): void;
}

export function createFakeFeishuBot(appId: string = 'fake_bot'): FakeFeishuBot {
  const sent: Array<{ chatId: string; text: string; messageIds: string[] }> = [];
  let handler: InboundHandler | null = null;
  let nextMessageId = 1;
  let sendError: Error | null = null;
  let openId: string | undefined = `ou_${appId}`;
  void openId;

  return {
    appId,
    get botOpenId(): string | undefined {
      return openId;
    },
    async start(h: InboundHandler): Promise<void> {
      handler = h;
    },
    async sendText(chatId: string, text: string): Promise<FeishuSendResult> {
      if (sendError !== null) {
        throw sendError;
      }
      const id = `om_fake_${nextMessageId++}`;
      sent.push({ chatId, text, messageIds: [id] });
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
