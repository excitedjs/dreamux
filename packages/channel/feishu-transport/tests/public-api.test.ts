import { expect, it, vi } from 'vitest';
import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  DOC_COMMENT_EVENT_TYPE,
  FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
  FEISHU_COT_APPEND_MAX_EVENTS,
  FeishuCotApiError,
  asString,
  createFeishuCotClient,
  createFeishuTransport,
  isBotMentioned,
  isBotSenderType,
  isRecord,
  normalizeBotMemberAddedEvent,
  normalizeCardActionAck,
  normalizeCardActionEvent,
  normalizeCommentEvent,
  parseFeishuDocumentRef,
  parseFeishuInboundEvent,
  parseInbound,
  type FeishuCotClient,
  type FeishuCotEventInput,
  type FeishuInboundEvent,
  type FeishuSendResult,
  type FeishuTransport,
  type FeishuTransportOptions,
  type InboundMessage,
  type InboundRoutes,
  type Mention,
  type OutboundTarget,
  type ParsedInbound,
} from '@excitedjs/feishu-transport';

it('decodes inbound content and callback events through the public entry', async () => {
  const mentions: Mention[] = [
    { key: '@_user_1', id: { open_id: 'bot' }, name: 'Bot' },
  ];
  const message: InboundMessage = {
    message_type: 'text',
    content: JSON.stringify({ text: 'hello @_user_1' }),
    mentions,
  };
  const body: ParsedInbound = parseInbound(message);
  expect(body).toEqual({ text: 'hello @_user_1', resources: [] });
  const inbound: FeishuInboundEvent | null = parseFeishuInboundEvent({
    event: {
      sender: { sender_id: { open_id: 'sender' }, sender_type: 'user' },
      message: {
        ...message,
        message_id: 'source',
        chat_id: 'chat',
        chat_type: 'group',
        thread_id: 'topic',
      },
    },
  });
  expect(inbound).toMatchObject({
    messageId: 'source',
    chatId: 'chat',
    threadId: 'topic',
    text: 'hello @_user_1',
    senderId: 'sender',
    senderType: 'user',
  });
  expect(isBotMentioned(inbound?.mentions, 'bot')).toBe(true);
  expect(isBotSenderType(inbound?.senderType)).toBe(false);
  expect(isBotSenderType('app')).toBe(true);

  const fields: unknown = JSON.parse(message.content!);
  expect(isRecord(fields) ? asString(fields['text']) : '').toBe(
    'hello @_user_1',
  );
  expect(
    parseFeishuDocumentRef('https://example.invalid/docx/doc-token'),
  ).toEqual({ token: 'doc-token', type: 'docx' });

  const routes: InboundRoutes = {
    [BOT_MEMBER_ADDED_EVENT_TYPE]: async (raw) =>
      normalizeBotMemberAddedEvent(raw),
    [DOC_COMMENT_EVENT_TYPE]: async (raw) => normalizeCommentEvent(raw),
  };
  await expect(
    routes['im.chat.member.bot.added_v1']!({
      header: { event_id: 'added' },
      event: { chat_id: 'chat' },
    }),
  ).resolves.toEqual({ chatId: 'chat', eventId: 'added' });
  await expect(
    routes['drive.notice.comment_add_v1']!({
      event: {
        file_token: 'doc-token',
        file_type: 'docx',
        comment_id: 'comment',
        reply_id: 'reply',
        is_mentioned: true,
        create_time: '1757894400000',
        user_id: { open_id: 'commenter' },
      },
    }),
  ).resolves.toEqual({
    fileToken: 'doc-token',
    fileType: 'docx',
    commentId: 'comment',
    replyId: 'reply',
    mentionedBot: true,
    timestamp: 1757894400000,
    commenterId: 'commenter',
  });
  const action = normalizeCardActionEvent({
    event: {
      operator: { open_id: 'operator' },
      action: { value: { action: 'accept' }, input_value: 'answer' },
      context: { open_chat_id: 'chat', open_message_id: 'card' },
    },
  });
  expect(action).toMatchObject({
    operatorOpenId: 'operator',
    actionValue: { action: 'accept' },
    inputValue: 'answer',
    openChatId: 'chat',
    openMessageId: 'card',
  });
  expect(
    normalizeCardActionAck(
      {
        toast: { type: 'success', content: action.inputValue },
      },
      undefined,
    ),
  ).toEqual({
    toast: { type: 'success', content: 'answer' },
    card: undefined,
  });
});

it('creates a public transport that sends and resolves the platform owner', async () => {
  const request = vi
    .fn(async (_input: unknown): Promise<unknown> => ({}))
    .mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: 'sent',
        chat_id: 'actual-chat',
        thread_id: 'actual-topic',
      },
    })
    .mockResolvedValueOnce({
      data: {
        app: {
          creator_id: 'creator',
          owner: {
            owner_id: 'owner',
            type: FEISHU_APP_OWNER_TYPE_ENTERPRISE_MEMBER,
          },
        },
      },
    });
  // The SDK client is the fake IO boundary; the public transport is real.
  const options: FeishuTransportOptions = {
    client: { request } as unknown as NonNullable<
      FeishuTransportOptions['client']
    >,
  };
  const transport: FeishuTransport = createFeishuTransport(
    { appId: 'app', appSecret: 'secret' },
    options,
  );
  try {
    const target: OutboundTarget = {
      chatId: 'chat',
      replyToMessageId: 'source',
    };
    const signal = new AbortController().signal;
    const sent: FeishuSendResult = await transport.send(target, 'hello', {
      signal,
    });
    expect(sent).toEqual({
      messages: [
        {
          messageId: 'sent',
          chatId: 'actual-chat',
          threadId: 'actual-topic',
        },
      ],
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'POST',
        url: '/open-apis/im/v1/messages/source/reply',
        signal,
        data: expect.objectContaining({ msg_type: 'interactive' }),
      }),
    );
    await expect(transport.resolveAppOwner()).resolves.toEqual({
      creatorOpenId: 'creator',
      ownerOpenId: 'owner',
      ownerType: 2,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: '/open-apis/application/v6/applications/app',
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
    });
  } finally {
    await transport.close();
  }
});

it('creates a public COT client with bounded batches and catchable platform errors', async () => {
  const request = vi
    .fn(async (_input: unknown): Promise<unknown> => ({}))
    .mockResolvedValueOnce({
      code: 0,
      data: { cot_id: 'cot', message_id: 'cot-message' },
    })
    .mockResolvedValueOnce({ code: 0 })
    .mockResolvedValueOnce({ code: 232010, msg: 'cot already completed' });
  const cot: FeishuCotClient = createFeishuCotClient(
    { request } as Parameters<typeof createFeishuCotClient>[0],
    { now: () => 1234 },
  );
  const created = await cot.createCot({
    chatId: 'chat',
    originMessageId: 'source',
    replyInThread: true,
  });
  expect(created).toEqual({ cotId: 'cot', messageId: 'cot-message' });
  expect(request).toHaveBeenNthCalledWith(1, {
    method: 'POST',
    url: '/open-apis/im/v1/message_cot',
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'chat',
      origin_message_id: 'source',
      reply_in_thread: true,
      cot_hidden: false,
      enable_badge: false,
      update_feed_rank: false,
    },
  });
  const event: FeishuCotEventInput = {
    eventType: 'TEXT_MESSAGE_CONTENT',
    content: { delta: 'hello' },
  };
  const events = Array.from(
    { length: FEISHU_COT_APPEND_MAX_EVENTS },
    () => event,
  );
  await cot.appendCot({ ...created, events });
  expect(request).toHaveBeenNthCalledWith(2, {
    method: 'PUT',
    url: '/open-apis/im/v1/message_cot',
    data: {
      cot_id: 'cot',
      message_id: 'cot-message',
      events: Array.from({ length: 50 }, () => ({
        event_type: 'TEXT_MESSAGE_CONTENT',
        content: '{"delta":"hello"}',
        timestamp: 1234,
      })),
    },
  });
  await expect(
    cot.appendCot({ ...created, events: [...events, event] }),
  ).rejects.toThrow('Feishu COT append takes 1-50 events, got 51');
  expect(request).toHaveBeenCalledTimes(2);
  const completion = cot.completeCot({ ...created, reason: 'done' });
  await expect(completion).rejects.toBeInstanceOf(FeishuCotApiError);
  await expect(completion).rejects.toMatchObject({ code: 232010 });
  expect(request).toHaveBeenNthCalledWith(3, {
    method: 'POST',
    url: '/open-apis/im/v1/message_cot/complete/cot',
    params: { message_id: 'cot-message', reason: 'done' },
  });
});
