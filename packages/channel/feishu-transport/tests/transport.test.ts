/**
 * Unit tests for `src/transport/feishu.ts` — both the pure decoders and the
 * outbound SDK paths of `createFeishuTransport`. The transport is exercised
 * through an injected stub `lark.Client`, so sends and reactions are covered
 * without a live Feishu app; only the inbound WebSocket / event-dispatcher
 * wiring still needs a live connection to run end-to-end.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createFeishuTransport } from '../src/transport/feishu'
import { FEISHU_MESSAGE_CONTENT_SAFE_BYTES } from '../src/transport/message-content'
import type { TransportLogger } from '../src/transport/diagnostics'

/**
 * Build a stub `lark.Client` that exposes only the methods this module calls.
 * Each method is a `vi.fn()` returning a configurable canned response, so a
 * test can assert both what the transport calls and how it reacts to the
 * response. The `as unknown as lark.Client` cast is intentional — the stub
 * deliberately omits methods the transport never touches.
 */
function stubClient() {
  const patch = vi.fn(async () => ({}))
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
        chat_id: 'oc_read',
        thread_id: 'omt_topic',
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
  const chatGet = vi.fn(
    async (): Promise<{ data?: Record<string, unknown> }> =>
      ({ data: { chat_mode: 'group' } }),
  )
  const memberCreate = vi.fn(async () => ({}))
  const request = vi.fn(
    async (_payload: unknown): Promise<unknown> =>
      ({ code: 0, data: { message_id: 'om_stub' } }),
  )
  const contactUserGet = vi.fn(async () => ({
    code: 0,
    data: { user: { name: 'Ada' } },
  }))
  const metaBatchQuery = vi.fn(async () => ({ data: { metas: [] } }))
  const wikiGetNode = vi.fn(async () => ({ data: { node: undefined } }))
  const commentBatchQuery = vi.fn(async () => ({ data: { items: [] } }))
  const stub = {
    im: {
      v1: {
        message: { get: messageGet },
        messageResource: { get: messageResourceGet },
      },
      message: { patch },
      messageReaction: { create: reactionCreate, delete: reactionDelete },
      chat: { create: chatCreate, get: chatGet, members: { create: memberCreate } },
    },
    drive: {
      meta: { batchQuery: metaBatchQuery },
      fileComment: { batchQuery: commentBatchQuery },
    },
    wiki: {
      v2: { space: { getNode: wikiGetNode } },
    },
    contact: {
      v3: { user: { get: contactUserGet } },
    },
    request,
    contactUserGet,
  }
  return {
    client: stub as unknown as lark.Client,
    metaBatchQuery,
    wikiGetNode,
    commentBatchQuery,
    patch,
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

interface SentRequest {
  url: string
  method: string
  params?: { receive_id_type: string }
  data: { receive_id?: string; msg_type: string; content: string }
  signal?: AbortSignal
}

function sentRequests(stub: ReturnType<typeof stubClient>): SentRequest[] {
  return (stub.request.mock.calls as unknown as Array<[SentRequest]>)
    .map(([payload]) => payload)
}

/** The Markdown inside each card that was sent, in order. */
function cardBodies(stub: ReturnType<typeof stubClient>): string[] {
  return sentRequests(stub).map((sent) => {
    expect(sent.data.msg_type).toBe('interactive')
    const card = JSON.parse(sent.data.content) as {
      schema: string
      body: { elements: Array<{ tag: string; content: string }> }
    }
    expect(card.schema).toBe('2.0')
    expect(card.body.elements.length).toBe(1)
    expect(card.body.elements[0]?.tag).toBe('markdown')
    return card.body.elements[0]?.content ?? ''
  })
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
  test('sends the authored body as one Markdown card', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = [
      '# Report',
      '',
      'A **bold** claim and <at user_id="ou_example">Example</at>.',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n')

    const result = await transport.send({ chatId: 'oc_chat' }, body)

    expect(result.messageIds).toEqual(['om_stub'])
    expect(stub.request).toHaveBeenCalledTimes(1)
    const sent = sentRequests(stub)[0]
    expect(sent?.url).toBe('/open-apis/im/v1/messages')
    expect(sent?.method).toBe('POST')
    expect(sent?.params).toEqual({ receive_id_type: 'chat_id' })
    expect(sent?.data.receive_id).toBe('oc_chat')
    expect(sent?.data.msg_type).toBe('interactive')
    expect(JSON.parse(sent?.data.content ?? '{}')).toEqual({
      schema: '2.0',
      config: { update_multi: true },
      body: {
        // The mention tag goes out as written: card Markdown renders it.
        elements: [{ tag: 'markdown', content: body }],
      },
    })
  })

  test('an oversized body loses its carriage returns in the split', async () => {
    // The split tiles the lexer's block `raw` values, which normalize CRLF
    // to LF; a body that fits is sent as written. Pinned rather than fixed:
    // the agent writes LF.
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = 'line one\r\nline two\r\n\r\n'.repeat(2000)

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.join('')).toBe(body.replace(/\r\n/g, '\n'))
  })

  test('threads a reply under the source message', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({
      code: 0,
      data: { message_id: 'om_reply_stub' },
    })
    const transport = buildTransport(stub)

    const result = await transport.send(
      { chatId: 'oc_chat', replyToMessageId: 'om/source' },
      'done',
    )

    expect(result.messageIds).toEqual(['om_reply_stub'])
    const sent = sentRequests(stub)[0]
    expect(sent?.url).toBe('/open-apis/im/v1/messages/om%2Fsource/reply')
    expect(sent?.data.receive_id).toBeUndefined()
    expect(cardBodies(stub)).toEqual(['done'])
  })

  test('returns empty messageIds when Feishu omits message_id', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({ code: 0, data: {} })
    const transport = buildTransport(stub)

    const result = await transport.send({ chatId: 'oc_chat' }, 'hi')

    expect(result.messageIds).toEqual([])
  })

  test('a body of many small blocks still sends as one message', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = Array.from({ length: 400 }, (_v, i) => `- item ${i}`).join('\n')

    await transport.send({ chatId: 'oc_chat' }, body)

    expect(stub.request).toHaveBeenCalledTimes(1)
    expect(cardBodies(stub)).toEqual([body])
  })

  test('splits an oversized mixed document into ordered cards that lose nothing', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    // Headings, prose, a list, a table and fenced code, so the split runs over
    // every block kind the lexer classifies rather than one uniform shape.
    const body = Array.from({ length: 400 }, (_v, i) => [
      `## Section ${i}`,
      '',
      `Paragraph ${i} with "quoted" text and a [link](https://example.com).`,
      '',
      `- item ${i}a`,
      `- item ${i}b`,
      '',
      '| id | note |',
      '| --- | --- |',
      `| ${i} | note ${i} |`,
      '',
      '```ts',
      `const value${i} = ${i}`,
      '```',
      '',
    ].join('\n')).join('')

    const result = await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.join('')).toBe(body)
    expect(result.messageIds.length).toBe(bodies.length)
    for (const sent of sentRequests(stub)) {
      expect(Buffer.byteLength(sent.data.content, 'utf8'))
        .toBeLessThanOrEqual(FEISHU_MESSAGE_CONTENT_SAFE_BYTES)
    }
  })

  test('measures the budget on the escaped payload, not the raw text', async () => {
    // A body of characters that each cost six bytes once JSON-escaped: a raw
    // UTF-8 count would call this one message and the platform would reject it.
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = '\u0001'.repeat(20_000)

    await transport.send({ chatId: 'oc_chat' }, body)

    expect(cardBodies(stub).join('')).toBe(body)
    for (const sent of sentRequests(stub)) {
      expect(Buffer.byteLength(sent.data.content, 'utf8'))
        .toBeLessThanOrEqual(FEISHU_MESSAGE_CONTENT_SAFE_BYTES)
    }
  })

  test('splits multi-byte text at grapheme boundaries', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = '汉'.repeat(20_000)

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.join('')).toBe(body)
    for (const piece of bodies) {
      expect(piece).not.toContain('\uFFFD')
      expect([...piece].every((char) => char === '汉')).toBe(true)
    }
  })

  test('keeps every piece of a split code block fenced', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const code = Array.from({ length: 3_000 }, (_v, i) => `line ${i}`).join('\n')
    const body = `\`\`\`ts\n${code}\n\`\`\`\n`

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    for (const piece of bodies) {
      expect(piece.startsWith('```ts\n')).toBe(true)
      expect(piece.trimEnd().endsWith('```')).toBe(true)
    }
    expect(bodies.map((piece) =>
      piece.slice('```ts\n'.length, piece.lastIndexOf('```'))).join(''))
      .toBe(`${code}\n`)
  })

  test('never sends a message that holds only blank lines', async () => {
    // Two oversized code blocks separated by a blank line, and a blank line at
    // the end: once each block is split the separators are left over on their
    // own. A separator between messages is not a message.
    const stub = stubClient()
    const transport = buildTransport(stub)
    const lines = (tag: string): string[] =>
      Array.from({ length: 6_000 }, (_v, i) => `${tag} ${i}`)
    const block = (tag: string): string =>
      `\`\`\`ts\n${lines(tag).join('\n')}\n\`\`\`\n`
    const body = `${block('a')}\n${block('b')}\n\n`

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(2)
    for (const piece of bodies) expect(piece.trim()).not.toBe('')
    expect(bodies
      .flatMap((piece) => piece.split('\n'))
      .filter((line) => line !== '' && !line.startsWith('```')))
      .toEqual([...lines('a'), ...lines('b')])
  })

  test('splits a code block whose single line is larger than one message', async () => {
    // Every piece pays for both fence lines plus the newline that separates the
    // split line from the closing fence; a piece that forgets the newline is
    // one escaped byte over the budget the platform enforces.
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = '```ts\n' + 'x'.repeat(30_000) + '\n```'

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    for (const sent of sentRequests(stub)) {
      expect(Buffer.byteLength(sent.data.content, 'utf8'))
        .toBeLessThanOrEqual(FEISHU_MESSAGE_CONTENT_SAFE_BYTES)
    }
    expect(bodies.map((piece) =>
      piece.slice('```ts\n'.length, piece.lastIndexOf('```')).trimEnd()).join(''))
      .toBe('x'.repeat(30_000))
  })

  test('repeats a long table header on every piece', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const header = '| id | note |\n| --- | --- |\n'
    const rows = Array.from(
      { length: 3_000 },
      (_v, i) => `| ${i} | note ${i} |`,
    ).join('\n')
    const body = `${header}${rows}\n`

    await transport.send({ chatId: 'oc_chat' }, body)

    const bodies = cardBodies(stub)
    expect(bodies.length).toBeGreaterThan(1)
    for (const piece of bodies) expect(piece.startsWith(header)).toBe(true)
    expect(bodies.map((piece) => piece.slice(header.length)).join(''))
      .toBe(`${rows}\n`)
  })

  test('refuses a table whose header and single row cannot fit', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const body = [
      '| id | note |',
      '| --- | --- |',
      `| 1 | ${'x'.repeat(FEISHU_MESSAGE_CONTENT_SAFE_BYTES)} |`,
    ].join('\n')

    await expect(transport.send({ chatId: 'oc_chat' }, body)).rejects.toThrow(
      /table header plus a single data row/,
    )
    expect(stub.request).not.toHaveBeenCalled()
  })

  test('observes each message before sending the next', async () => {
    const stub = stubClient()
    stub.request.mockImplementation(async () => ({
      code: 0,
      data: { message_id: `om_${stub.request.mock.calls.length}` },
    }))
    const transport = buildTransport(stub)
    const receipts: Array<{ messageId: string; ordinal: number }> = []
    const sendCountsAtReceipt: number[] = []

    const result = await transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      {
        onMessageCreated: (receipt) => {
          receipts.push(receipt)
          sendCountsAtReceipt.push(stub.request.mock.calls.length)
        },
      },
    )

    expect(result.messageIds.length).toBeGreaterThan(1)
    expect(receipts).toEqual(result.messageIds.map((messageId, ordinal) => ({
      messageId,
      ordinal,
    })))
    expect(sendCountsAtReceipt).toEqual(
      result.messageIds.map((_messageId, ordinal) => ordinal + 1),
    )
  })

  test('reports only created messages before a later send fails', async () => {
    const stub = stubClient()
    const failure = new Error('second part failed')
    stub.request.mockResolvedValueOnce({
      code: 0,
      data: { message_id: 'om_created' },
    })
    stub.request.mockRejectedValueOnce(failure)
    const transport = buildTransport(stub)
    const observer = vi.fn()

    await expect(transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      { onMessageCreated: observer },
    )).rejects.toBe(failure)

    expect(stub.request).toHaveBeenCalledTimes(2)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({
      messageId: 'om_created',
      ordinal: 0,
    })
  })

  test('contains observer failures and continues a multi-part send', async () => {
    const stub = stubClient()
    stub.request.mockImplementation(async () => ({
      code: 0,
      data: { message_id: `om_${stub.request.mock.calls.length}` },
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

  test('sendCard sends caller-owned interactive card JSON unchanged', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const card = { config: { update_multi: true }, elements: [{ tag: 'div' }] }

    const result = await transport.sendCard({ chatId: 'oc_chat' }, card)

    expect(result.messageIds).toEqual(['om_stub'])
    const sent = sentRequests(stub)[0]
    expect(sent?.data.msg_type).toBe('interactive')
    expect(JSON.parse(sent?.data.content ?? '{}')).toEqual(card)
  })

  test('sendCard rejects a card body over the content budget', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)
    const card = { text: 'x'.repeat(FEISHU_MESSAGE_CONTENT_SAFE_BYTES) }

    await expect(transport.sendCard({ chatId: 'oc_chat' }, card)).rejects
      .toThrow(/over the 28672-byte budget/)
    expect(stub.request).not.toHaveBeenCalled()
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

/**
 * The platform's own refusal, as the SDK delivers it: an HTTP rejection whose
 * `response.data` is the Feishu envelope. Everything above transport projects
 * an error to its message, so the message is where the code, reason and log id
 * have to survive.
 */
function platformRejection(
  status: number,
  body: Record<string, unknown>,
): Error & { response: { status: number; data: Record<string, unknown> } } {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: body },
  })
}

const AUDIT_REFUSAL = {
  code: 230028,
  msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
  error: { log_id: 'log_example' },
}

describe('createFeishuTransport — message send failures', () => {
  test('names the operation, status, code, reason and log id on create', async () => {
    const stub = stubClient()
    stub.request.mockRejectedValueOnce(platformRejection(400, AUDIT_REFUSAL))
    const transport = buildTransport(stub)

    await expect(transport.send({ chatId: 'oc_chat' }, 'hello')).rejects
      .toThrow(
        'Feishu message.create failed (HTTP 400, code 230028, ' +
          'log_id=log_example): ' + AUDIT_REFUSAL.msg,
      )
  })

  test('names message.reply when the send threaded under a message', async () => {
    const stub = stubClient()
    stub.request.mockRejectedValueOnce(platformRejection(400, AUDIT_REFUSAL))
    const transport = buildTransport(stub)

    await expect(transport.send(
      { chatId: 'oc_chat', replyToMessageId: 'om_source' },
      'hello',
    )).rejects.toThrow(/^Feishu message\.reply failed \(HTTP 400, code 230028/)
  })

  test('keeps the platform rejection as the cause and leaks no request', async () => {
    const stub = stubClient()
    const original = platformRejection(400, AUDIT_REFUSAL)
    stub.request.mockRejectedValueOnce(original)
    const transport = buildTransport(stub)

    const thrown = await transport
      .send({ chatId: 'oc_chat' }, 'a private body with a secret in it')
      .then(() => undefined)
      .catch((err: unknown) => err as Error)

    expect(thrown?.cause).toBe(original)
    expect(thrown?.message).not.toContain('secret')
    expect(thrown?.message).not.toContain('Authorization')
    expect(thrown?.message).not.toContain('oc_chat')
  })

  test('a resolved nonzero business code is a failed send, not an empty one', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({ ...AUDIT_REFUSAL, data: {} })
    const transport = buildTransport(stub)

    await expect(transport.send({ chatId: 'oc_chat' }, 'hello')).rejects
      .toThrow(
        `Feishu message.create failed (code 230028, log_id=log_example): ${
          AUDIT_REFUSAL.msg
        }`,
      )
  })

  test('the explicit card send reports the same platform detail', async () => {
    const stub = stubClient()
    stub.request.mockRejectedValueOnce(platformRejection(400, AUDIT_REFUSAL))
    const transport = buildTransport(stub)

    await expect(transport.sendCard({ chatId: 'oc_chat' }, { tag: 'div' }))
      .rejects.toThrow(/code 230028/)
  })

  test('an error with no Feishu response keeps its own identity', async () => {
    const stub = stubClient()
    const network = new Error('socket hang up')
    stub.request.mockRejectedValueOnce(network)
    const transport = buildTransport(stub)

    await expect(transport.send({ chatId: 'oc_chat' }, 'hello')).rejects
      .toBe(network)
  })

  test('a rejection whose response is not a Feishu envelope keeps its own', async () => {
    // A gateway can answer with an HTML page under the same field name. There
    // is no code, reason or log id to state, so the library's message stays.
    const stub = stubClient()
    const gateway = Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: '<html>502 Bad Gateway</html>' },
    })
    stub.request.mockRejectedValueOnce(gateway)
    const transport = buildTransport(stub)

    await expect(transport.send({ chatId: 'oc_chat' }, 'hello')).rejects
      .toBe(gateway)
  })

  test('a cancelled card send still rejects with the abort reason', async () => {
    const stub = stubClient()
    const controller = new AbortController()
    stub.request.mockImplementationOnce((raw: unknown) => {
      const signal = (raw as { signal?: AbortSignal }).signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    })
    const transport = buildTransport(stub)

    const sending = transport.sendCard(
      { chatId: 'oc_chat' },
      { tag: 'div' },
      { signal: controller.signal },
    )
    controller.abort()
    await expect(sending).rejects.toBe(controller.signal.reason)
  })

  test('earlier message ids stay observed when a later part is refused', async () => {
    const stub = stubClient()
    stub.request.mockResolvedValueOnce({
      code: 0,
      data: { message_id: 'om_first' },
    })
    stub.request.mockRejectedValueOnce(platformRejection(400, AUDIT_REFUSAL))
    const transport = buildTransport(stub)
    const observer = vi.fn()

    await expect(transport.send(
      { chatId: 'oc_chat' },
      'x'.repeat(60_000),
      { onMessageCreated: observer },
    )).rejects.toThrow(/code 230028/)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({ messageId: 'om_first', ordinal: 0 })
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
  test('reads the current chat name without caching it', async () => {
    const stub = stubClient()
    stub.chatGet.mockResolvedValue({ data: { chat_mode: 'group', name: 'Current name' } })
    const transport = buildTransport(stub)

    await expect(transport.resolveChatName?.('oc_chat')).resolves.toBe('Current name')
    await expect(transport.resolveChatName?.('oc_chat')).resolves.toBe('Current name')
    expect(stub.chatGet).toHaveBeenCalledTimes(2)
    expect(stub.chatGet).toHaveBeenCalledWith({ path: { chat_id: 'oc_chat' } })
  })

  test.each(['p2p', 'group', 'topic'] as const)(
    'reads the %s chat mode from the group information API',
    async (chatMode) => {
      const stub = stubClient()
      stub.chatGet.mockResolvedValueOnce({ data: { chat_mode: chatMode } })
      const transport = buildTransport(stub)

      await expect(transport.getChatMode?.('oc_chat')).resolves.toBe(chatMode)
      expect(stub.chatGet).toHaveBeenCalledWith({ path: { chat_id: 'oc_chat' } })
    },
  )

  test('returns undefined for a missing or unknown chat mode', async () => {
    const stub = stubClient()
    stub.chatGet
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { chat_mode: 'future-mode' } })
    const transport = buildTransport(stub)

    await expect(transport.getChatMode?.('oc_missing')).resolves.toBeUndefined()
    await expect(transport.getChatMode?.('oc_unknown')).resolves.toBeUndefined()
  })

  test('fails loud when the chat information API is unavailable', async () => {
    const stub = stubClient()
    const raw = stub.client as unknown as { im: { chat: { get?: unknown } } }
    delete raw.im.chat.get
    const transport = buildTransport(stub)

    await expect(transport.getChatMode?.('oc_chat')).rejects.toThrow(
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
  test('reads a message by id and nothing else', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    const result = await transport.readMessage({ messageId: 'om_read' })

    // No `user_id_type`: supplying one makes the platform answer a bot mention
    // with an application id instead of the open id a reply can address.
    expect(stub.messageGet).toHaveBeenCalledWith({
      path: { message_id: 'om_read' },
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
        // Where the message is, which is how a card answer finds its way back
        // into the conversation the card is actually in.
        chatId: 'oc_read',
        threadId: 'omt_topic',
      }],
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
        chatId: '',
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
    } as unknown as lark.Client
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 'secret' },
      { client: withoutContact },
    )

    await expect(transport.resolveUserName?.('ou_sender')).resolves.toBeUndefined()
    await expect(transport.resolveUserName?.('')).resolves.toBeUndefined()
  })
})

describe('createFeishuTransport — injected logger safety boundary (#74)', () => {
  test('a sentinel appSecret and message body never reach the injected logger', async () => {
    // Sentinels fed through the *real* transport inputs — the credentials and an
    // outbound body — so this proves the adapter does not surface them, rather
    // than asserting against strings the test never passed in.
    const SECRET = 'fake-not-a-real-secret'
    const BODY = 'do-not-log-body'

    const calls: Array<{
      fields: Record<string, unknown> | string
      message?: string
    }> = []
    const record = (
      fields: Record<string, unknown> | string,
      message?: string,
    ): void => {
      calls.push({ fields, message })
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
      {
        client: stub.client,
        logger,
        webSocketRegistration: {
          open: async () => undefined,
          close: () => {
            throw new Error('the socket was already gone')
          },
        },
      },
    )

    // Send a real body (no log on success), then fail the close so the
    // best-effort `diagnostic()` sink actually runs.
    await transport.send({ chatId: 'oc_chat' }, BODY)
    await transport.close()

    // The diagnostic path ran (so the assertion below is not vacuous)…
    expect(calls.length).toBeGreaterThan(0)
    // …yet neither sentinel appears anywhere in what the logger received.
    const haystack = JSON.stringify(calls)
    expect(haystack).not.toContain(SECRET)
    expect(haystack).not.toContain(BODY)
  })
})

/**
 * The metadata read is a *permission proof*, so what it cannot establish must
 * not look like what it can. These three cases used to collapse into one
 * `null`, which is how a 5xx could be reported to an operator as "add the bot
 * as a collaborator".
 */
describe('createFeishuTransport — fetchDocMeta discriminates its answers', () => {
  test('a token Feishu returns a metadata row for is visible', async () => {
    const stub = stubClient()
    stub.metaBatchQuery.mockResolvedValueOnce({
      data: { metas: [{ doc_token: 'doc_tok', title: 'Design' }] },
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.fetchDocMeta('doc_tok', 'docx')).resolves.toEqual({
      kind: 'visible',
    })
  })

  test('a token in failed_list is invisible — the one answer a refusal may quote', async () => {
    const stub = stubClient()
    stub.metaBatchQuery.mockResolvedValueOnce({
      data: { metas: [], failed_list: [{ token: 'doc_tok', code: 970003 }] },
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.fetchDocMeta('doc_tok', 'docx')).resolves.toEqual({
      kind: 'invisible',
    })
  })

  test('a type the metadata API does not take is its own answer, not invisibility', async () => {
    const stub = stubClient()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.fetchDocMeta('doc_tok', 'minutes')).resolves.toEqual({
      kind: 'unsupported_type',
    })
    expect(stub.metaBatchQuery).not.toHaveBeenCalled()
  })

  test('a failed request propagates instead of being reported as invisible', async () => {
    const stub = stubClient()
    stub.metaBatchQuery.mockRejectedValueOnce(new Error('network down'))
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.fetchDocMeta('doc_tok', 'docx')).rejects.toThrow(
      'network down',
    )
  })

  test('a response claiming the token in neither list throws rather than guessing', async () => {
    const stub = stubClient()
    stub.metaBatchQuery.mockResolvedValueOnce({
      code: 1061045,
      msg: 'rate limited',
      data: { metas: [] },
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.fetchDocMeta('doc_tok', 'docx')).rejects.toThrow(
      /1061045/,
    )
  })
})

describe('createFeishuTransport — resolveWikiNode', () => {
  test('answers the object the node holds, which is what the comment event names', async () => {
    const stub = stubClient()
    stub.wikiGetNode.mockResolvedValueOnce({
      data: { node: { node_token: 'wik_tok', obj_token: 'doc_tok', obj_type: 'docx' } },
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.resolveWikiNode('wik_tok')).resolves.toEqual({
      objToken: 'doc_tok',
      objType: 'docx',
    })
    expect(stub.wikiGetNode).toHaveBeenCalledWith({ params: { token: 'wik_tok' } })
  })

  test('a successful response with no node means this bot cannot see it', async () => {
    const stub = stubClient()
    stub.wikiGetNode.mockResolvedValueOnce({ code: 0, data: {} } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.resolveWikiNode('wik_tok')).resolves.toBeNull()
  })

  test('a non-zero business code throws rather than reading as "cannot see"', async () => {
    const stub = stubClient()
    stub.wikiGetNode.mockResolvedValueOnce({
      code: 1061045,
      msg: 'rate limited',
      data: {},
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(transport.resolveWikiNode('wik_tok')).rejects.toThrow(/1061045/)
  })
})


/**
 * The delivered body carries what the commenter wrote, so this read picks the
 * one item the event names out of the thread Feishu answers with. Every way of
 * not finding it is one answer — `null`, which the caller turns into a
 * delivery without text rather than a dropped event.
 */
describe('createFeishuTransport — fetchDocCommentText', () => {
  const thread = (replies: unknown[], quote?: string): unknown => ({
    data: {
      items: [
        {
          comment_id: 'cmt_1',
          quote,
          reply_list: { replies },
        },
      ],
    },
  })

  const textReply = (replyId: string, text: string): unknown => ({
    reply_id: replyId,
    content: { elements: [{ type: 'text_run', text_run: { text } }] },
  })

  test('an empty reply id reads the comment at the head of the thread', async () => {
    const stub = stubClient()
    stub.commentBatchQuery.mockResolvedValueOnce(
      thread(
        [textReply('rep_1', 'please rework this'), textReply('rep_2', 'agreed')],
        'the paragraph in question',
      ) as never,
    )
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: '',
      }),
    ).resolves.toEqual({
      quote: 'the paragraph in question',
      segments: [{ kind: 'text', text: 'please rework this' }],
    })
    expect(stub.commentBatchQuery).toHaveBeenCalledWith({
      path: { file_token: 'doc_tok' },
      params: { file_type: 'docx', user_id_type: 'open_id' },
      data: { comment_ids: ['cmt_1'] },
    })
  })

  test('a reply id reads that reply and not the head of the thread', async () => {
    const stub = stubClient()
    stub.commentBatchQuery.mockResolvedValueOnce(
      thread([
        textReply('rep_1', 'please rework this'),
        textReply('rep_2', 'agreed'),
      ]) as never,
    )
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: 'rep_2',
      }),
    ).resolves.toEqual({
      quote: '',
      segments: [{ kind: 'text', text: 'agreed' }],
    })
  })

  test('a mention stays a mention, and a docs_link is text', async () => {
    const stub = stubClient()
    stub.commentBatchQuery.mockResolvedValueOnce(
      thread([
        {
          reply_id: 'rep_1',
          content: {
            elements: [
              { type: 'person', person: { user_id: 'ou_bot' } },
              { type: 'text_run', text_run: { text: ' see ' } },
              { type: 'docs_link', docs_link: { url: 'https://example.invalid/x' } },
            ],
          },
        },
      ]) as never,
    )
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: 'rep_1',
      }),
    ).resolves.toEqual({
      quote: '',
      segments: [
        { kind: 'mention', openId: 'ou_bot' },
        { kind: 'text', text: ' see ' },
        { kind: 'text', text: 'https://example.invalid/x' },
      ],
    })
  })

  test('a thread without the named comment answers null', async () => {
    const stub = stubClient()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: '',
      }),
    ).resolves.toBeNull()
  })

  test('a thread without the named reply answers null', async () => {
    const stub = stubClient()
    stub.commentBatchQuery.mockResolvedValueOnce(
      thread([textReply('rep_1', 'please rework this')]) as never,
    )
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: 'rep_9',
      }),
    ).resolves.toBeNull()
  })

  test('a type the comment API does not take is answered without a call', async () => {
    const stub = stubClient()
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'mindnote',
        commentId: 'cmt_1',
        replyId: '',
      }),
    ).resolves.toBeNull()
    expect(stub.commentBatchQuery).not.toHaveBeenCalled()
  })

  test('a non-zero business code throws rather than reading as "no such comment"', async () => {
    const stub = stubClient()
    stub.commentBatchQuery.mockResolvedValueOnce({
      code: 1061045,
      msg: 'rate limited',
      data: {},
    } as never)
    const transport = createFeishuTransport(
      { appId: 'app', appSecret: 's' },
      { client: stub.client },
    )

    await expect(
      transport.fetchDocCommentText({
        fileToken: 'doc_tok',
        fileType: 'docx',
        commentId: 'cmt_1',
        replyId: '',
      }),
    ).rejects.toThrow(/1061045/)
  })
})
