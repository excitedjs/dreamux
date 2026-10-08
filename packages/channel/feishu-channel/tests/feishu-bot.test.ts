import { describe, expect, it, vi } from 'vitest';

import { createFeishuBot, type CreateBotOptions } from '../src/bot.js';
import { createFeishuTransport } from '@excitedjs/feishu-transport';
import type {
  FeishuInboundEvent,
  FeishuAppOwnerIdentity,
  FeishuChatMode,
  FeishuDocCommentText,
  FeishuDocMetaResult,
  FeishuWikiNode,
  FeishuMessageResourceRequest,
  FeishuMessageResourceResponse,
  FeishuMessageReadRequest,
  FeishuMessageReadResponse,
  FeishuSendOptions,
  FeishuSendResult,
  FeishuTransport,
  InboundRoutes,
  OutboundTarget,
} from '@excitedjs/feishu-transport';

vi.mock('@excitedjs/feishu-transport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@excitedjs/feishu-transport')>();
  return { ...actual, createFeishuTransport: vi.fn() };
});

class FakeTransport implements FeishuTransport {
  readonly appId = 'app-test';
  readonly selfId = 'bot-open-id';
  readonly selfName = 'App Test Bot';
  routes: InboundRoutes | null = null;
  readonly sent: Array<{ target: OutboundTarget; text: string }> = [];
  readonly sentCards: Array<{ target: OutboundTarget; card: unknown }> = [];
  readonly editedCards: Array<{ messageId: string; card: unknown }> = [];
  closed = false;
  lastSendOptions: FeishuSendOptions | undefined;

  constructor() {
    // The real transport returns an object with own function properties.
    // Match that boundary: the bot forwards those members by object spread.
    this.send = this.send.bind(this);
    this.sendCard = this.sendCard.bind(this);
    this.editCard = this.editCard.bind(this);
    this.getChatMode = this.getChatMode.bind(this);
    this.addReaction = this.addReaction.bind(this);
    this.fetchDocMeta = this.fetchDocMeta.bind(this);
    this.resolveWikiNode = this.resolveWikiNode.bind(this);
    this.fetchDocCommentText = this.fetchDocCommentText.bind(this);
    this.fetchMessageResource = this.fetchMessageResource.bind(this);
    this.readMessage = this.readMessage.bind(this);
    this.resolveAppOwner = this.resolveAppOwner.bind(this);
    this.close = this.close.bind(this);
  }

  async start(routes: InboundRoutes): Promise<void> {
    this.routes = routes;
  }

  async send(
    target: OutboundTarget,
    text: string,
    options?: FeishuSendOptions,
  ): Promise<FeishuSendResult> {
    this.sent.push({ target, text });
    this.lastSendOptions = options;
    return {
      messages: [
        {
          messageId: 'message-sent',
          chatId: target.chatId,
          threadId: undefined,
        },
      ],
    };
  }

  async sendCard(
    target: OutboundTarget,
    card: unknown,
  ): Promise<FeishuSendResult> {
    this.sentCards.push({ target, card });
    return {
      messages: [
        {
          messageId: 'message-card-sent',
          chatId: target.chatId,
          threadId: undefined,
        },
      ],
    };
  }

  async editCard(messageId: string, card: unknown): Promise<void> {
    this.editedCards.push({ messageId, card });
  }

  async getChatMode(): Promise<FeishuChatMode | undefined> {
    return 'topic';
  }

  async addReaction(): Promise<string> {
    throw new Error('unused in this test');
  }

  async fetchDocMeta(): Promise<FeishuDocMetaResult> {
    throw new Error('unused in this test');
  }

  async resolveWikiNode(): Promise<FeishuWikiNode | null> {
    throw new Error('unused in this test');
  }

  async fetchDocCommentText(): Promise<FeishuDocCommentText | null> {
    throw new Error('unused in this test');
  }

  async fetchMessageResource(
    _request: FeishuMessageResourceRequest,
  ): Promise<FeishuMessageResourceResponse> {
    throw new Error('unused in this test');
  }

  async readMessage(
    _request: FeishuMessageReadRequest,
  ): Promise<FeishuMessageReadResponse> {
    throw new Error('unused in this test');
  }

  async resolveAppOwner(): Promise<FeishuAppOwnerIdentity> {
    return { creatorOpenId: 'ou_owner' };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async dispatch(eventType: string, raw: unknown): Promise<unknown> {
    const handler = this.routes?.[eventType];
    if (handler === undefined) return false;
    const result = await handler(raw);
    return result === undefined ? true : result;
  }
}

describe('createFeishuBot inbound channel', () => {
  it('forwards platform message landings and cancellation to the transport', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });
    const controller = new AbortController();
    const result = await bot.send({ chatId: 'chat-id-1' }, 'hello', {
      signal: controller.signal,
    });
    expect(result).toEqual({
      messages: [
        {
          messageId: 'message-sent',
          chatId: 'chat-id-1',
          threadId: undefined,
        },
      ],
    });
    expect(transport.lastSendOptions?.signal).toBe(controller.signal);
    expect(transport.sent).toEqual([
      { target: { chatId: 'chat-id-1' }, text: 'hello' },
    ]);
  });

  it('registers only im.message.receive_v1 and normalizes raw events', async () => {
    const transport = new FakeTransport();
    const createdWith: CreateBotOptions[] = [];
    vi.mocked(createFeishuTransport).mockImplementationOnce((opts) => {
      createdWith.push(opts);
      return transport;
    });
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });
    const received: FeishuInboundEvent[] = [];

    await bot.start({
      onMessage: async (event) => {
        received.push(event);
      },
    });

    expect(createdWith).toEqual([
      { appId: 'app-test', appSecret: 'secret-test' },
    ]);
    expect(Object.keys(transport.routes ?? {})).toEqual([
      'im.message.receive_v1',
    ]);
    expect(bot.appId).toBe('app-test');
    expect(bot.botOpenId).toBe('bot-open-id');
    expect(bot.botDisplayName).toBe('App Test Bot');

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
          thread_id: 'thread-id-1',
          root_id: 'root-id-1',
          parent_id: 'parent-id-1',
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
      threadId: 'thread-id-1',
      rootId: 'root-id-1',
      parentId: 'parent-id-1',
      senderId: 'sender-open-id',
      senderType: 'user',
      senderName: '',
      messageType: 'text',
      rawContent: JSON.stringify({ text: 'hello @_user_1' }),
      text: 'hello @_user_1',
      resources: [],
      createTime: '1710000000000',
    });
    expect(received[0]?.mentions).toHaveLength(1);
    // `getChatMode` is optional on the bot contract; a bot that cannot answer
    // it is a different assertion than one that answers wrongly.
    expect(bot.getChatMode).toBeDefined();
    await expect(bot.getChatMode?.('chat-id-1')).resolves.toBe('topic');
  });

  it('uses best-effort sender display name fields when present', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });
    const received: FeishuInboundEvent[] = [];

    await bot.start({
      onMessage: async (event) => {
        received.push(event);
      },
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
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });
    const received: FeishuInboundEvent[] = [];
    await bot.start({
      onMessage: async (event) => {
        received.push(event);
      },
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

  it('registers the bot-added route only when a handler is provided (issue #62 seam)', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });
    const added: Array<{ chatId: string; eventId: string }> = [];
    await bot.start({
      onMessage: async () => {},
      onBotMemberAdded: (event) => {
        added.push({ chatId: event.chatId, eventId: event.eventId });
      },
    });

    expect(Object.keys(transport.routes ?? {})).toEqual([
      'im.message.receive_v1',
      'im.chat.member.bot.added_v1',
    ]);

    await transport.dispatch('im.chat.member.bot.added_v1', {
      header: { event_id: 'evt-1' },
      event: { chat_id: 'chat-id-1' },
    });
    expect(added).toEqual([{ chatId: 'chat-id-1', eventId: 'evt-1' }]);
  });

  it('registers card.action.trigger and preserves the handler return value', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });

    await bot.start({
      onMessage: async () => {},
      onCardAction: (event) => ({
        toast: {
          type: 'success',
          content: String(event.actionValue['code']),
        },
      }),
    });

    expect(Object.keys(transport.routes ?? {})).toEqual([
      'im.message.receive_v1',
      'card.action.trigger',
    ]);
    const response = await transport.dispatch('card.action.trigger', {
      operator: { open_id: 'ou_operator' },
      action: { value: { code: 'sample-code' } },
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
    });

    expect(response).toEqual({
      toast: { type: 'success', content: 'sample-code' },
    });
  });

  it('normalizes malformed card-action responses into a legal error toast', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });

    await bot.start({
      onMessage: async () => {},
      onCardAction: () => 'not-an-ack',
    });

    const response = await transport.dispatch('card.action.trigger', {
      operator: { open_id: 'ou_operator' },
      action: { value: {} },
    });

    expect(response).toEqual({
      toast: { type: 'error', content: '卡片回调响应格式错误' },
    });
  });

  it('strips unknown top-level keys from raw card callback data', async () => {
    const transport = new FakeTransport();
    vi.mocked(createFeishuTransport).mockReturnValueOnce(transport);
    const bot = createFeishuBot({
      appId: 'app-test',
      appSecret: 'secret-test',
    });

    await bot.start({
      onMessage: async () => {},
      onCardAction: () => ({
        toast: { type: 'success', content: 'ok' },
        card: {
          type: 'raw',
          data: {
            config: {},
            header: { title: { tag: 'plain_text', content: 'done' } },
            elements: [],
            _debugVersion: 'local',
          },
        },
      }),
    });

    const response = await transport.dispatch('card.action.trigger', {
      operator: { open_id: 'ou_operator' },
      action: { value: {} },
    });

    expect(response).toEqual({
      toast: { type: 'success', content: 'ok' },
      card: {
        type: 'raw',
        data: {
          config: {},
          header: { title: { tag: 'plain_text', content: 'done' } },
          elements: [],
        },
      },
    });
  });
});
