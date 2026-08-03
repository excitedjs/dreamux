import { describe, expect, it } from 'vitest';

import {
  createFeishuBot,
  type CreateBotOptions,
  type FeishuInboundEvent,
  type FeishuMessageRecalledEvent,
} from '../src/bot.js';
import type {
  FeishuAppOwnerIdentity,
  FeishuCreateGroupInput,
  FeishuCreateGroupResult,
  FeishuChatMode,
  FeishuDocComment,
  FeishuDocMeta,
  FeishuInviteMembersInput,
  FeishuInviteMembersResult,
  FeishuMessageResourceRequest,
  FeishuMessageResourceResponse,
  FeishuMessageReadRequest,
  FeishuMessageReadResponse,
  FeishuSendResult,
  FeishuTransport,
  InboundRoutes,
  OutboundTarget,
} from '@excitedjs/feishu-transport';

class FakeTransport implements FeishuTransport {
  readonly appId = 'app-test';
  readonly selfId = 'bot-open-id';
  readonly selfName = 'App Test Bot';
  routes: InboundRoutes | null = null;
  readonly sent: Array<{ target: OutboundTarget; text: string }> = [];
  readonly sentCards: Array<{ target: OutboundTarget; card: unknown }> = [];
  closed = false;

  async start(routes: InboundRoutes): Promise<void> {
    this.routes = routes;
  }

  async send(target: OutboundTarget, text: string): Promise<FeishuSendResult> {
    this.sent.push({ target, text });
    return { messageIds: ['message-sent'] };
  }

  async sendCard(target: OutboundTarget, card: unknown): Promise<FeishuSendResult> {
    this.sentCards.push({ target, card });
    return { messageIds: ['message-card-sent'] };
  }

  async createGroup(input: FeishuCreateGroupInput): Promise<FeishuCreateGroupResult> {
    return { chatId: input.name };
  }

  async inviteMembers(input: FeishuInviteMembersInput): Promise<FeishuInviteMembersResult> {
    return { addedOpenIds: input.userOpenIds };
  }

  async getChatMode(): Promise<FeishuChatMode | undefined> {
    return 'topic';
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
      parsedText: 'hello @Ada',
      createTime: '1710000000000',
    });
    expect(received[0]?.mentions).toHaveLength(1);
    await expect(bot.getChatMode('chat-id-1')).resolves.toBe('topic');
  });

  it('uses best-effort sender display name fields when present', async () => {
    const transport = new FakeTransport();
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
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

  it('registers and bounds im.message.recalled_v1 without retaining raw fields', async () => {
    const transport = new FakeTransport();
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
    const recalled: FeishuMessageRecalledEvent[] = [];

    await bot.start({
      onMessage: async () => {},
      onMessageRecalled: async (event) => {
        recalled.push(event);
      },
    });

    expect(Object.keys(transport.routes ?? {})).toEqual([
      'im.message.receive_v1',
      'im.message.recalled_v1',
    ]);
    await transport.dispatch('im.message.recalled_v1', {
      schema: '2.0',
      header: {
        event_id: 'event-recall-1',
        event_type: 'im.message.recalled_v1',
        token: 'must-not-be-retained',
        app_id: 'must-not-be-retained',
      },
      event: {
        chat_id: 'chat-topic',
        message_id: 'message-root',
        recall_type: 'message_owner',
        recall_time: '1782660000000',
        body: 'must-not-be-retained',
      },
    });

    expect(recalled).toEqual([{
      eventId: 'event-recall-1',
      chatId: 'chat-topic',
      messageId: 'message-root',
      recallType: 'message_owner',
      recallTime: '1782660000000',
    }]);
    expect(Object.keys(recalled[0] ?? {}).sort()).toEqual([
      'chatId',
      'eventId',
      'messageId',
      'recallTime',
      'recallType',
    ]);

    await transport.dispatch('im.message.recalled_v1', {
      event_id: 'event-recall-flattened',
      chat_id: 'chat-topic',
      message_id: 'message-root-flattened',
      recall_type: 'message_owner',
      recall_time: '1782660000001',
      token: 'must-not-be-retained',
    });
    expect(recalled[1]).toEqual({
      eventId: 'event-recall-flattened',
      chatId: 'chat-topic',
      messageId: 'message-root-flattened',
      recallType: 'message_owner',
      recallTime: '1782660000001',
    });

    const malformed = [
      {
        header: {},
        event: {
          chat_id: 'chat-topic',
          message_id: 'message-root',
          recall_type: 'message_owner',
          recall_time: '1782660000000',
        },
      },
      {
        header: { event_id: 'event-missing-message' },
        event: {
          chat_id: 'chat-topic',
          recall_type: 'message_owner',
          recall_time: '1782660000000',
        },
      },
      {
        header: { event_id: 'event-overlong-chat' },
        event: {
          chat_id: 'x'.repeat(513),
          message_id: 'message-root',
          recall_type: 'message_owner',
          recall_time: '1782660000000',
        },
      },
      {
        header: { event_id: 'event-invalid-recall-type' },
        event: {
          chat_id: 'chat-topic',
          message_id: 'message-root',
          recall_type: { raw: true },
          recall_time: '1782660000000',
        },
      },
    ];
    for (const raw of malformed) {
      await transport.dispatch('im.message.recalled_v1', raw);
    }
    expect(recalled).toHaveLength(2);
  });

  it('drops unroutable receive_v1 events before calling the handler', async () => {
    const transport = new FakeTransport();
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
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
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );
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
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );

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
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );

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
    const bot = createFeishuBot(
      { appId: 'app-test', appSecret: 'secret-test' },
      { createTransport: () => transport },
    );

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
