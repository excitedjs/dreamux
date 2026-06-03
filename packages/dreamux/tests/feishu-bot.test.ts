import { describe, expect, it } from 'vitest';

import {
  createFeishuBot,
  type CreateBotOptions,
  type FeishuInboundEvent,
} from '../src/feishu/bot.js';
import type {
  FeishuDocComment,
  FeishuDocMeta,
  FeishuSendResult,
  FeishuTransport,
  InboundRoutes,
  OutboundTarget,
} from '@excitedjs/feishu-transport';

class FakeTransport implements FeishuTransport {
  readonly appId = 'app-test';
  readonly selfId = 'bot-open-id';
  routes: InboundRoutes | null = null;
  readonly sent: Array<{ target: OutboundTarget; text: string }> = [];
  closed = false;

  async start(routes: InboundRoutes): Promise<void> {
    this.routes = routes;
  }

  async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
    this.sent.push({ target, text });
    return { messageIds: ['message-sent'] };
  }

  async addReaction(): Promise<string> {
    throw new Error('unused in this test');
  }

  async removeReaction(): Promise<void> {
    throw new Error('unused in this test');
  }

  async editText(): Promise<void> {
    throw new Error('unused in this test');
  }

  async fetchDocComment(): Promise<FeishuDocComment | null> {
    throw new Error('unused in this test');
  }

  async fetchDocMeta(): Promise<FeishuDocMeta | null> {
    throw new Error('unused in this test');
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async dispatch(eventType: string, raw: unknown): Promise<boolean> {
    const handler = this.routes?.[eventType];
    if (handler === undefined) return false;
    await handler(raw);
    return true;
  }
}

describe('createFeishuBot inbound channel', () => {
  it('registers only im.message.receive_v1 and normalizes raw events', async () => {
    const transport = new FakeTransport();
    const createdWith: CreateBotOptions[] = [];
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      {
        createTransport: (opts) => {
          createdWith.push(opts);
          return transport;
        },
      },
    );
    const received: FeishuInboundEvent[] = [];

    await bot.start(async (event) => {
      received.push(event);
    });

    expect(createdWith).toEqual([
      { appId: 'app-test', appSecret: 'secret-test' },
    ]);
    expect(Object.keys(transport.routes ?? {})).toEqual([
      'im.message.receive_v1',
    ]);
    expect(bot.appId).toBe('app-test');
    expect(bot.botOpenId).toBe('bot-open-id');

    const ignored = await transport.dispatch('drive.file.comment_v1', {
      event: {},
    });
    expect(ignored).toBe(false);

    const delivered = await transport.dispatch('im.message.receive_v1', {
      schema: '2.0',
      header: {
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: {
          sender_id: { open_id: 'sender-open-id' },
          sender_type: 'user',
        },
        message: {
          message_id: 'message-id-1',
          chat_id: 'chat-id-1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello @_user_1' }),
          create_time: '1710000000000',
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'mentioned-open-id' },
              name: 'Ada',
            },
          ],
        },
      },
    });

    expect(delivered).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      messageId: 'message-id-1',
      chatId: 'chat-id-1',
      chatType: 'group',
      senderId: 'sender-open-id',
      senderType: 'user',
      senderName: '',
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello @_user_1' }),
      parsedText: 'hello @Ada',
      createTime: '1710000000000',
    });
    expect(received[0]?.mentions).toHaveLength(1);
  });

  it('uses best-effort sender display name fields when present', async () => {
    const transport = new FakeTransport();
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
    const received: FeishuInboundEvent[] = [];

    await bot.start(async (event) => {
      received.push(event);
    });

    await transport.dispatch('im.message.receive_v1', {
      event: {
        sender: {
          sender_id: { open_id: 'sender-open-id' },
          sender_type: 'user',
          sender_name: 'Ada Sender',
        },
        message: {
          message_id: 'message-id-1',
          chat_id: 'chat-id-1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
          create_time: '1710000000000',
        },
      },
    });

    expect(received[0]?.senderName).toBe('Ada Sender');
  });

  it('drops unroutable receive_v1 events before calling the handler', async () => {
    const transport = new FakeTransport();
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
    const received: FeishuInboundEvent[] = [];
    await bot.start(async (event) => {
      received.push(event);
    });

    const delivered = await transport.dispatch('im.message.receive_v1', {
      event: {
        sender: {
          sender_id: { open_id: 'sender-open-id' },
          sender_type: 'user',
        },
        message: {
          message_id: '',
          chat_id: 'chat-id-1',
          message_type: 'text',
          content: JSON.stringify({ text: 'missing id' }),
        },
      },
    });

    expect(delivered).toBe(true);
    expect(received).toEqual([]);
  });
});
