/**
 * Unit tests for `src/transport/feishu.ts` — both the pure decoders and the
 * outbound SDK paths of `createFeishuTransport`. The transport is exercised
 * through an injected stub `lark.Client`, so `send` / `editText` / reactions are
 * covered without a live Feishu app; only the inbound WebSocket / event-dispatcher
 * wiring still needs a live connection to run end-to-end.
 *
 * Ported from claudemux's `feishu.test.ts` (the source of truth). The only
 * adaptations: the transport no longer takes a lock path (election moved out of
 * core), and the outbound entry point is `send(target, text)` rather than
 * `sendText(chatId, text)`.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import {
  FEISHU_CARD_CONTENT_SAFE_BYTES,
  commentFromBatchQuery,
  createFeishuTransport,
} from '../src/transport/feishu'
import type { TransportLogger } from '../src/transport/diagnostics'

/**
 * One `drive.v1.fileComment.batchQuery` response item, in the exact shape the
 * live API returns — a local-selection comment (`is_whole: false`) anchored to
 * a quote, with one reply. Captured from a real `batch_query` response.
 */
function batchQueryItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment_id: 'cmt_1',
    is_whole: false,
    quote: 'the target sentence the comment is anchored to',
    reply_list: {
      replies: [
        {
          reply_id: 'rpl_1',
          user_id: 'ou_commenter',
          content: { elements: [{ type: 'text_run', text_run: { text: 'please take a look' } }] },
        },
      ],
    },
    ...overrides,
  }
}

describe('commentFromBatchQuery', () => {
  test('decodes a local-selection comment with its quote and reply text', () => {
    const comment = commentFromBatchQuery([batchQueryItem()], 'cmt_1')

    expect(comment).toEqual({
      isWhole: false,
      quote: 'the target sentence the comment is anchored to',
      replies: [
        {
          replyId: 'rpl_1',
          authorId: 'ou_commenter',
          elements: [{ type: 'text_run', text_run: { text: 'please take a look' } }],
        },
      ],
    })
  })

  test('picks the requested comment out of a multi-item response', () => {
    const items = [
      batchQueryItem({ comment_id: 'cmt_other', quote: 'a different anchor' }),
      batchQueryItem({ comment_id: 'cmt_1', quote: 'the wanted anchor' }),
    ]
    expect(commentFromBatchQuery(items, 'cmt_1')?.quote).toBe('the wanted anchor')
  })

  test('returns null when the response carries no comment with that id', () => {
    expect(commentFromBatchQuery([batchQueryItem({ comment_id: 'cmt_other' })], 'cmt_1')).toBeNull()
  })

  test('returns null for an empty response', () => {
    expect(commentFromBatchQuery([], 'cmt_1')).toBeNull()
  })

  test('a whole-document comment decodes with isWhole true and an empty quote', () => {
    const comment = commentFromBatchQuery(
      [batchQueryItem({ is_whole: true, quote: '' })],
      'cmt_1',
    )
    expect(comment?.isWhole).toBe(true)
    expect(comment?.quote).toBe('')
  })

  test('defaults isWhole to true and quote to empty when the API omits them', () => {
    const comment = commentFromBatchQuery(
      [{ comment_id: 'cmt_1', reply_list: { replies: [] } }],
      'cmt_1',
    )
    expect(comment).toEqual({ isWhole: true, quote: '', replies: [] })
  })

  test('a comment with no reply list decodes to an empty reply array', () => {
    const comment = commentFromBatchQuery([{ comment_id: 'cmt_1' }], 'cmt_1')
    expect(comment?.replies).toEqual([])
  })

  test('a reply missing its ids and content decodes to empty fields', () => {
    const comment = commentFromBatchQuery(
      [{ comment_id: 'cmt_1', reply_list: { replies: [{}] } }],
      'cmt_1',
    )
    expect(comment?.replies).toEqual([{ replyId: '', authorId: '', elements: [] }])
  })
})


/**
 * Build a stub `lark.Client` that exposes only the methods this module calls.
 * Each method is a `vi.fn()` returning a configurable canned response, so a
 * test can assert both what the transport calls and how it reacts to the
 * response. The `as unknown as lark.Client` cast is intentional — the stub
 * deliberately omits methods the transport never touches.
 */
function stubClient() {
  const create = vi.fn(async () => ({ data: { message_id: 'om_stub' } }))
  const reply = vi.fn(async () => ({ data: { message_id: 'om_reply_stub' } }))
  const patch = vi.fn(async () => ({}))
  const update = vi.fn(async () => ({}))
  const reactionCreate = vi.fn(async () => ({ data: { reaction_id: 'rk_stub' } }))
  const reactionDelete = vi.fn(async () => ({}))
  const messageResourceGet = vi.fn(async () => ({
    getReadableStream: () => Readable.from([Buffer.from('resource bytes')]),
    headers: { 'content-type': 'application/octet-stream' },
  }))
  const messageGet = vi.fn(async () => ({
    data: {
      items: [{
        message_id: 'om_read',
        msg_type: 'interactive',
        body: { content: JSON.stringify({ title: 'visible' }) },
        upper_message_id: 'om_parent',
        sender: {
          id: 'ou_sender',
          sender_type: 'user',
          sender_name: 'Ada',
        },
        mentions: [{
          key: '@_user_1',
          id: 'ou_mentioned',
          id_type: 'open_id',
          name: 'Bob',
        }],
      }],
    },
  }))
  const chatCreate = vi.fn(async () => ({ data: { chat_id: 'oc_created' } }))
  const chatGet = vi.fn(async () => ({ data: { chat_mode: 'group' } }))
  const memberCreate = vi.fn(async () => ({}))
  const request = vi.fn(async () => ({}))
  const contactUserGet = vi.fn(async () => ({
    code: 0,
    data: { user: { name: 'Ada' } },
  }))
  const stub = {
    im: {
      v1: {
        message: { get: messageGet },
        messageResource: { get: messageResourceGet },
      },
      message: { create, reply, patch, update },
      messageReaction: { create: reactionCreate, delete: reactionDelete },
      chat: { create: chatCreate, get: chatGet, members: { create: memberCreate } },
    },
    drive: {
      fileComment: { batchQuery: vi.fn(async () => ({ data: { items: [] } })) },
      meta: { batchQuery: vi.fn(async () => ({ data: { metas: [] } })) },
    },
    contact: {
      v3: { user: { get: contactUserGet } },
    },
    request,
    contactUserGet,
  }
  return {
    client: stub as unknown as lark.Client,
    create,
    reply,
    patch,
    update,
    reactionCreate,
    reactionDelete,
    messageResourceGet,
    messageGet,
    chatCreate,
    chatGet,
    memberCreate,
    request,
    contactUserGet,
  }
}

function buildTransport(stub: ReturnType<typeof stubClient>) {
  const noop = (): void => undefined
  const logger: TransportLogger = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
  }
  return createFeishuTransport(
    { appId: 'app', appSecret: 'secret' },
    { client: stub.client, logger },
  )
}

describe('createFeishuTransport — send', () => {
  test('sends as a v2 interactive card with the rendered card content', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.send({ chatId: 'oc_chat' }, '**bold** message')

    expect(result.messageIds).toEqual(['om_stub'])
    expect(stub.create).toHaveBeenCalledTimes(1)
    const calls = stub.create.mock.calls as unknown as Array<
      [{ params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }]
    >
    const call = calls[0]?.[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.params.receive_id_type).toBe('chat_id')
    expect(call.data.receive_id).toBe('oc_chat')
    expect(call.data.msg_type).toBe('interactive')
    const card = JSON.parse(call.data.content) as {
      schema: string
      config: { update_multi: boolean }
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.schema).toBe('2.0')
    expect(card.config.update_multi).toBe(true)
    expect(card.body.elements[0]?.tag).toBe('markdown')
    // The paragraph token's raw form is passed through to lark_md, which
    // renders the inline bold marker — nothing is flattened on the way out.
    expect(card.body.elements[0]?.content).toBe('**bold** message')
  })

  test('returns empty messageIds when Feishu omits message_id', async () => {
    const stub = stubClient()
    stub.create.mockResolvedValueOnce({ data: {} } as never)
    const transport = buildTransport(stub)

    const result = await transport.send({ chatId: 'oc_chat' }, 'hi')

    expect(result.messageIds).toEqual([])
  })

  test('threads replies under the source message and prefixes @-back mentions', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.send(
      {
        chatId: 'oc_chat',
        replyToMessageId: 'om_source',
        mentionUserIds: ['ou_sender'],
      },
      'done',
    )

    expect(result.messageIds).toEqual(['om_reply_stub'])
    expect(stub.create).not.toHaveBeenCalled()
    expect(stub.reply).toHaveBeenCalledTimes(1)
    const calls = stub.reply.mock.calls as unknown as Array<
      [{ path: { message_id: string }; data: { msg_type: string; content: string } }]
    >
    const call = calls[0]?.[0]
    expect(call?.path.message_id).toBe('om_source')
    expect(call?.data.msg_type).toBe('interactive')
    const card = JSON.parse(call?.data.content ?? '{}') as {
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.body.elements[0]?.content).toContain('<at id="ou_sender"></at>')
    expect(card.body.elements[0]?.content).toContain('done')
  })

  test('renders a multi-card body into one im.message.create per card', async () => {
    // A body that exceeds the per-card byte budget produces several cards;
    // each card is its own create() call and contributes one message_id.
    const stub = stubClient()
    stub.create.mockResolvedValueOnce({ data: { message_id: 'om_a' } } as never)
    stub.create.mockResolvedValueOnce({ data: { message_id: 'om_b' } } as never)
    const transport = buildTransport(stub)

    const result = await transport.send({ chatId: 'oc_chat' }, 'x'.repeat(60_000))

    expect(stub.create.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.messageIds[0]).toBe('om_a')
    expect(result.messageIds[1]).toBe('om_b')
  })

  test('observes each multi-card message before sending the next card', async () => {
    const stub = stubClient()
    stub.create.mockImplementation(async () => ({
      data: { message_id: `om_${stub.create.mock.calls.length}` },
    }))
    const transport = buildTransport(stub)
    const receipts: Array<{ messageId: string; ordinal: number }> = []
    const createCountsAtReceipt: number[] = []

    const result = await transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      {
        onMessageCreated: (receipt) => {
          receipts.push(receipt)
          createCountsAtReceipt.push(stub.create.mock.calls.length)
        },
      },
    )

    expect(result.messageIds.length).toBeGreaterThan(1)
    expect(receipts).toEqual(result.messageIds.map((messageId, ordinal) => ({
      messageId,
      ordinal,
    })))
    expect(createCountsAtReceipt).toEqual(
      result.messageIds.map((_messageId, ordinal) => ordinal + 1),
    )
  })

  test('reports only created messages before a later multi-card send fails', async () => {
    const stub = stubClient()
    const failure = new Error('second card failed')
    stub.create.mockResolvedValueOnce({ data: { message_id: 'om_created' } } as never)
    stub.create.mockRejectedValueOnce(failure)
    const transport = buildTransport(stub)
    const observer = vi.fn()

    await expect(transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      { onMessageCreated: observer },
    )).rejects.toBe(failure)

    expect(stub.create).toHaveBeenCalledTimes(2)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({
      messageId: 'om_created',
      ordinal: 0,
    })
  })

  test('contains observer failures and continues a multi-card send', async () => {
    const stub = stubClient()
    stub.create.mockImplementation(async () => ({
      data: { message_id: `om_${stub.create.mock.calls.length}` },
    }))
    const transport = buildTransport(stub)
    const observer = vi.fn((_receipt: {
      messageId: string
      ordinal: number
    }) => {
      throw new Error('observer failed')
    })

    const result = await transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      { onMessageCreated: observer },
    )

    expect(result.messageIds.length).toBeGreaterThan(1)
    expect(observer).toHaveBeenCalledTimes(result.messageIds.length)
    expect(observer.mock.calls.map(([receipt]) => receipt)).toEqual(
      result.messageIds.map((messageId, ordinal) => ({ messageId, ordinal })),
    )
  })

  test('sendCard sends caller-owned interactive card JSON without markdown rendering', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const card = { config: { update_multi: true }, elements: [{ tag: 'div' }] }

    const result = await transport.sendCard({ chatId: 'oc_chat' }, card)

    expect(result.messageIds).toEqual(['om_stub'])
    const calls = stub.create.mock.calls as unknown as Array<
      [{ params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }]
    >
    expect(calls[0]?.[0].data.msg_type).toBe('interactive')
    expect(JSON.parse(calls[0]?.[0].data.content ?? '{}')).toEqual(card)
  })

  test('sendCard forwards AbortSignal to the cancellable request path', async () => {
    const stub = stubClient()
    const controller = new AbortController()
    stub.request.mockImplementationOnce((raw: unknown) => {
      const signal = (raw as { signal?: AbortSignal }).signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        )
      })
    })
    const transport = buildTransport(stub)

    const sending = transport.sendCard(
      { chatId: 'oc_chat' },
      { elements: [{ tag: 'div' }] },
      { signal: controller.signal },
    )
    expect(stub.create).not.toHaveBeenCalled()
    expect(stub.request).toHaveBeenCalledWith(expect.objectContaining({
      url: '/open-apis/im/v1/messages',
      method: 'POST',
      signal: controller.signal,
    }))

    controller.abort()
    await expect(sending).rejects.toBe(controller.signal.reason)
  })

  test('sendCard uses cancellable top-level create with caller-owned signal', async () => {
    const stub = stubClient()
    const controller = new AbortController()
    stub.request.mockResolvedValueOnce({
      data: { message_id: 'om_cancellable_create' },
    })
    const transport = buildTransport(stub)
    const card = { elements: [{ tag: 'div' }] }

    const result = await transport.sendCard(
      { chatId: 'oc_chat' },
      card,
      { signal: controller.signal },
    )

    expect(result.messageIds).toEqual(['om_cancellable_create'])
    expect(stub.create).not.toHaveBeenCalled()
    expect(stub.request).toHaveBeenCalledWith({
      url: '/open-apis/im/v1/messages',
      method: 'POST',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      signal: controller.signal,
    })
  })

  test('sendCard uses cancellable reply with caller-owned signal', async () => {
    const stub = stubClient()
    const controller = new AbortController()
    stub.request.mockResolvedValueOnce({
      data: { message_id: 'om_cancellable_reply' },
    })
    const transport = buildTransport(stub)
    const card = { elements: [{ tag: 'div' }] }

    const result = await transport.sendCard(
      { chatId: 'oc_chat', replyToMessageId: 'om/source' },
      card,
      { signal: controller.signal },
    )

    expect(result.messageIds).toEqual(['om_cancellable_reply'])
    expect(stub.reply).not.toHaveBeenCalled()
    expect(stub.request).toHaveBeenCalledWith({
      url: '/open-apis/im/v1/messages/om%2Fsource/reply',
      method: 'POST',
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      signal: controller.signal,
    })
  })
})

describe('createFeishuTransport — app owner', () => {
  test('resolves creator and human owner as open_id values', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({
      data: {
        app: {
          creator_id: 'ou_creator',
          owner: { owner_id: 'ou_owner', type: 2 },
        },
      },
    } as never)
    const transport = buildTransport(stub)

    await expect(transport.resolveAppOwner()).resolves.toEqual({
      creatorOpenId: 'ou_creator',
      ownerOpenId: 'ou_owner',
      ownerType: 2,
    })
    expect(stub.request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/application/v6/applications/app',
      params: { lang: 'zh_cn', user_id_type: 'open_id' },
    })
  })

  test('does not accept a non-enterprise-member owner id', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({
      data: {
        app: {
          creator_id: 'ou_creator',
          owner: { owner_id: 'ou_partner_owner', type: 1 },
        },
      },
    } as never)
    const transport = buildTransport(stub)

    await expect(transport.resolveAppOwner()).resolves.toEqual({
      creatorOpenId: 'ou_creator',
      ownerType: 1,
    })
  })

  test('owner lookup diagnostic names the documented Feishu scopes', async () => {
    const calls: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const record = (fields: Record<string, unknown>, message?: string) => {
      calls.push({ message: message ?? '', fields })
    }
    const logger: TransportLogger = {
      error: record,
      warn: record,
      info: record,
      debug: record,
      trace: record,
    }
    const stub = stubClient()
    stub.request.mockRejectedValue(new Error('permission denied'))
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { client: stub.client, logger },
    )

    await expect(transport.resolveAppOwner()).resolves.toEqual({})
    const haystack = JSON.stringify(calls)
    expect(haystack).toContain('application:application:self_manage')
    expect(haystack).toContain('admin:app.info:readonly')
    expect(haystack).not.toContain('application:app:readonly')
  })
})

describe('createFeishuTransport — reactions', () => {
  test('addReaction posts the emoji and returns the reaction_id', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const reactionId = await transport.addReaction('om_target', 'THUMBSUP')

    expect(reactionId).toBe('rk_stub')
    expect(stub.reactionCreate).toHaveBeenCalledTimes(1)
    const calls = stub.reactionCreate.mock.calls as unknown as Array<
      [{ path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }]
    >
    const call = calls[0]?.[0]
    expect(call?.path.message_id).toBe('om_target')
    expect(call?.data.reaction_type.emoji_type).toBe('THUMBSUP')
  })

  test('addReaction returns an empty string when Feishu omits the reaction_id', async () => {
    const stub = stubClient()
    stub.reactionCreate.mockResolvedValueOnce({ data: {} } as never)
    const transport = buildTransport(stub)

    expect(await transport.addReaction('om_target', 'THUMBSUP')).toBe('')
  })

})

describe('createFeishuTransport — group chats', () => {
  test.each(['p2p', 'group', 'topic'] as const)(
    'reads the %s chat mode from the group information API',
    async (chatMode) => {
      const stub = stubClient()
      stub.chatGet.mockResolvedValueOnce({ data: { chat_mode: chatMode } })
      const transport = buildTransport(stub)

      await expect(transport.getChatMode('oc_chat')).resolves.toBe(chatMode)
      expect(stub.chatGet).toHaveBeenCalledWith({ path: { chat_id: 'oc_chat' } })
    },
  )

  test('returns undefined for a missing or unknown chat mode', async () => {
    const stub = stubClient()
    stub.chatGet
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { chat_mode: 'future-mode' } })
    const transport = buildTransport(stub)

    await expect(transport.getChatMode('oc_missing')).resolves.toBeUndefined()
    await expect(transport.getChatMode('oc_unknown')).resolves.toBeUndefined()
  })

  test('fails loud when the chat information API is unavailable', async () => {
    const stub = stubClient()
    const raw = stub.client as unknown as { im: { chat: { get?: unknown } } }
    delete raw.im.chat.get
    const transport = buildTransport(stub)

    await expect(transport.getChatMode('oc_chat')).rejects.toThrow(
      /chat get API is not available/,
    )
  })

  test('creates a group chat and returns chat_id', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.createGroup({
      name: 'Dreamux Team',
      userOpenIds: ['ou_user'],
    })

    expect(result).toEqual({ chatId: 'oc_created' })
    expect(stub.chatCreate).toHaveBeenCalledWith({
      params: { user_id_type: 'open_id' },
      data: { name: 'Dreamux Team', user_id_list: ['ou_user'] },
    })
  })

  test('fails loud when chat create API is unavailable', async () => {
    const stub = stubClient()
    const raw = stub.client as unknown as { im: { chat?: unknown } }
    delete raw.im.chat
    const transport = buildTransport(stub)

    await expect(
      transport.createGroup({ name: 'Dreamux Team', userOpenIds: [] }),
    ).rejects.toThrow(/chat create API is not available/)
  })

  test('invites members by open_id and returns requested ids', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.inviteMembers({
      chatId: 'oc_chat',
      userOpenIds: ['ou_a', 'ou_b'],
    })

    expect(result).toEqual({ addedOpenIds: ['ou_a', 'ou_b'] })
    expect(stub.memberCreate).toHaveBeenCalledWith({
      path: { chat_id: 'oc_chat' },
      data: { id_list: ['ou_a', 'ou_b'] },
      params: { member_id_type: 'open_id' },
    })
  })
})

describe('createFeishuTransport — message resources', () => {
  test('fetchMessageResource delegates to the raw Lark message resource API', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.fetchMessageResource({
      messageId: 'om_target',
      fileKey: 'file-key',
      type: 'file',
    })

    expect(stub.messageResourceGet).toHaveBeenCalledTimes(1)
    expect(stub.messageResourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_target', file_key: 'file-key' },
      params: { type: 'file' },
    })
    expect(result.headers).toEqual({ 'content-type': 'application/octet-stream' })
    const chunks: Buffer[] = []
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('resource bytes')
  })
})

describe('createFeishuTransport — message reads', () => {
  test('omits card_msg_content_type for the default representation', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.readMessage({
      messageId: 'om_read',
      cardContent: 'default',
    })

    expect(stub.messageGet).toHaveBeenCalledWith({
      path: { message_id: 'om_read' },
      params: { user_id_type: 'open_id' },
    })
    expect(result).toEqual({
      items: [{
        messageId: 'om_read',
        messageType: 'interactive',
        content: JSON.stringify({ title: 'visible' }),
        mentions: [{
          key: '@_user_1',
          id: { open_id: 'ou_mentioned' },
          name: 'Bob',
        }],
        deleted: false,
        malformed: false,
      }],
    })
  })

  test('requests the structured card representation explicitly', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    await transport.readMessage({
      messageId: 'om_read',
      cardContent: 'user_card_content',
    })

    expect(stub.messageGet).toHaveBeenCalledWith({
      path: { message_id: 'om_read' },
      params: {
        user_id_type: 'open_id',
        card_msg_content_type: 'user_card_content',
      },
    })
  })

  test('marks incomplete SDK items as malformed without throwing', async () => {
    const stub = stubClient()
    stub.messageGet.mockResolvedValueOnce({
      data: {
        items: [{
          message_id: '',
          msg_type: '',
          body: {},
          deleted: true,
        }],
      },
    } as never)
    const transport = buildTransport(stub)

    await expect(transport.readMessage({ messageId: 'om_bad' })).resolves.toEqual({
      items: [{
        messageId: '',
        messageType: '',
        content: '',
        mentions: [],
        deleted: true,
        malformed: true,
      }],
    })
  })

  test('accepts an empty merged-forward root body because descendants carry its content', async () => {
    const stub = stubClient()
    stub.messageGet.mockResolvedValueOnce({
      data: {
        items: [{
          message_id: 'om_forward',
          msg_type: 'merge_forward',
          body: { content: '' },
        }],
      },
    } as never)
    const transport = buildTransport(stub)

    const result = await transport.readMessage({ messageId: 'om_forward' })

    expect(result.items[0]).toMatchObject({
      messageId: 'om_forward',
      messageType: 'merge_forward',
      malformed: false,
    })
  })
})

describe('createFeishuTransport — sender names', () => {
  test('queries contact.v3.user.get on every call without caching', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBe('Ada')
    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBe('Ada')

    expect(stub.contactUserGet).toHaveBeenCalledTimes(2)
    expect(stub.contactUserGet).toHaveBeenCalledWith({
      path: { user_id: 'ou_sender' },
      params: { user_id_type: 'open_id' },
    })
  })

  test('returns no name for every nonzero or malformed response', async () => {
    const stub = stubClient()
    stub.contactUserGet.mockResolvedValueOnce({ code: 99991672 } as never)
    stub.contactUserGet.mockResolvedValueOnce({ code: 7 } as never)
    stub.contactUserGet.mockResolvedValueOnce({ code: 0, data: {} } as never)
    const transport = buildTransport(stub)

    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBeUndefined()
    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBeUndefined()
    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBeUndefined()
    expect(stub.contactUserGet).toHaveBeenCalledTimes(3)
  })

  test('leaves thrown SDK failures for the Channel attempt boundary', async () => {
    const stub = stubClient()
    stub.contactUserGet.mockRejectedValueOnce(new Error('transient'))
    const transport = buildTransport(stub)

    await expect(transport.resolveUserName?.('ou_sender')).rejects.toThrow('transient')
  })

  test('returns no name when the client has no contact API or id is empty', async () => {
    const stub = stubClient()
    const withoutContact = {
      ...stub.client,
      contact: undefined,
    } as lark.Client
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { client: withoutContact },
    )

    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBeUndefined()
    await expect(transport.resolveUserName?.('')).resolves.toBeUndefined()
  })
})

describe('createFeishuTransport — editText', () => {
  test('patches the message as a v2 card on the happy path', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    await transport.editText('om_target', 'updated *body*')

    expect(stub.patch).toHaveBeenCalledTimes(1)
    expect(stub.update).not.toHaveBeenCalled()
    const calls = stub.patch.mock.calls as unknown as Array<
      [{ path: { message_id: string }; data: { content: string } }]
    >
    const call = calls[0]?.[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.path.message_id).toBe('om_target')
    const card = JSON.parse(call.data.content) as {
      schema: string
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.schema).toBe('2.0')
    expect(card.body.elements[0]?.content).toBe('updated *body*')
  })

  test('falls back to im.message.update when patch fails — legacy text msg', async () => {
    // A message_id sent by an older version of the channel is a plain
    // `msg_type: text` message. Feishu rejects `patch` on it; the fallback
    // updates the text content via `im.message.update`.
    const stub = stubClient()
    stub.patch.mockRejectedValueOnce(new Error('not a card'))
    const transport = buildTransport(stub)

    await transport.editText('om_legacy', 'new body')

    expect(stub.patch).toHaveBeenCalledTimes(1)
    expect(stub.update).toHaveBeenCalledTimes(1)
    const calls = stub.update.mock.calls as unknown as Array<
      [{ path: { message_id: string }; data: { msg_type: string; content: string } }]
    >
    const call = calls[0]?.[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.path.message_id).toBe('om_legacy')
    expect(call.data.msg_type).toBe('text')
    expect(JSON.parse(call.data.content)).toEqual({ text: 'new body' })
  })

  test('re-throws the patch error when the legacy fallback also fails', async () => {
    // Both endpoints failing means the target is neither an editable card
    // nor an editable text message — auth, deleted message, rate limit.
    // The original patch error describes the path the channel intends to
    // use, so surface it rather than the legacy fallback's error.
    const stub = stubClient()
    const patchErr = new Error('patch failed')
    stub.patch.mockRejectedValueOnce(patchErr)
    stub.update.mockRejectedValueOnce(new Error('update also failed'))
    const transport = buildTransport(stub)

    await expect(transport.editText('om_dead', 'hi')).rejects.toBe(patchErr)
  })

  test('rejects an edit whose body would span multiple cards', async () => {
    // An edit patches one message_id in place and cannot fan out, so a body
    // the renderer would split into several cards has no destination. The
    // guard runs before any API call so the model sees an actionable error
    // instead of a low-level Feishu code.
    const stub = stubClient()
    const transport = buildTransport(stub)
    // 60 KB of fence-free text exceeds the per-card budget; the renderer
    // splits it into two or more cards, which `editText` then refuses.
    const huge = 'a'.repeat(FEISHU_CARD_CONTENT_SAFE_BYTES + 64)

    await expect(transport.editText('om_target', huge)).rejects.toThrow(
      /edit body produced [0-9]+ cards/,
    )
    expect(stub.patch).not.toHaveBeenCalled()
    expect(stub.update).not.toHaveBeenCalled()
  })
})

describe('createFeishuTransport — injected logger safety boundary (#74)', () => {
  test('a sentinel appSecret and message body never reach the injected logger', async () => {
    // Sentinels fed through the *real* transport inputs — the credentials and an
    // outbound body — so this proves the adapter does not surface them, rather
    // than asserting against strings the test never passed in.
    const SECRET = 'fake-not-a-real-secret'
    const BODY = 'do-not-log-body'

    const calls: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const record = (message: string, fields?: Record<string, unknown>) => {
      calls.push({ message, fields })
    }
    const logger: TransportLogger = {
      error: record,
      warn: record,
      info: record,
      debug: record,
      trace: record,
    }

    const stub = stubClient()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: SECRET },
      { client: stub.client, logger },
    )

    // Send a real body (no log on success), then force the doc-comment fetch to
    // fail so the best-effort `diagnostic()` sink actually runs.
    await transport.send({ chatId: 'oc_chat' }, BODY)
    const drive = (
      stub.client as unknown as {
        drive: { fileComment: { batchQuery: ReturnType<typeof vi.fn> } }
      }
    ).drive
    drive.fileComment.batchQuery.mockRejectedValueOnce(new Error('network down'))
    const comment = await transport.fetchDocComment('tok', 'docx', 'cmt')

    expect(comment).toBeNull()
    // The diagnostic path ran (so the assertion below is not vacuous)…
    expect(calls.length).toBeGreaterThan(0)
    // …yet neither sentinel appears anywhere in what the logger received.
    const haystack = JSON.stringify(calls)
    expect(haystack).not.toContain(SECRET)
    expect(haystack).not.toContain(BODY)
  })
})
