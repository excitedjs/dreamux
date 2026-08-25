/**
 * Unit tests for `src/transport/cot.ts` — the three Feishu COT endpoints, the
 * official request envelope, and response validation, exercised through a stub
 * request client so no live Feishu app is needed.
 *
 * These assertions are deliberately written against the *wire*: the append body
 * is `{events, message_id, cot_id}`, each event is
 * `{event_type, content: <JSON string>, timestamp: <ms>}`, and complete carries
 * `{message_id, reason}` as query params with no body. Nothing here inspects an
 * AG-UI content object without parsing `events[i].content` first.
 */

import { describe, expect, test } from 'vitest'

import {
  createFeishuCotClient,
  FEISHU_COT_APPEND_MAX_EVENTS,
} from '../src/transport/cot'

/**
 * The per-event envelope the official Append page specifies, declared here
 * independently of the implementation. Importing the production type would let
 * a drift in it silently rewrite what these tests claim Feishu accepts.
 */
interface ExpectedWireEvent {
  event_type: string
  content: string
  timestamp: number
}

interface RecordedRequest {
  method?: string
  url?: string
  params?: Record<string, unknown>
  data?: Record<string, unknown>
}

function stubClient(responses: unknown[]): {
  client: Parameters<typeof createFeishuCotClient>[0]
  calls: RecordedRequest[]
} {
  const calls: RecordedRequest[] = []
  let index = 0
  const client = {
    async request(input: unknown): Promise<unknown> {
      calls.push(input as RecordedRequest)
      const response = responses[index] ?? responses[responses.length - 1]
      index += 1
      if (response instanceof Error) throw response
      return response
    },
  }
  return { client: client as Parameters<typeof createFeishuCotClient>[0], calls }
}

function createOk(): unknown {
  return { code: 0, data: { cot_id: 'cot-1', message_id: 'om-cot-1' } }
}

/** The wire events of one append call, still in their serialized form. */
function wireEvents(call: RecordedRequest | undefined): ExpectedWireEvent[] {
  return (call?.data?.['events'] ?? []) as ExpectedWireEvent[]
}

describe('createCot', () => {
  test('posts receive_id_type=chat_id with the anchored source message', async () => {
    const { client, calls } = stubClient([createOk()])
    const result = await createFeishuCotClient(client).createCot({
      chatId: 'oc-chat-1',
      originMessageId: 'om-source-1',
      replyInThread: true,
    })

    expect(result).toEqual({ cotId: 'cot-1', messageId: 'om-cot-1' })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/open-apis/im/v1/message_cot')
    expect(calls[0]?.params).toEqual({ receive_id_type: 'chat_id' })
    expect(calls[0]?.data).toEqual({
      receive_id: 'oc-chat-1',
      origin_message_id: 'om-source-1',
      reply_in_thread: true,
      cot_hidden: false,
      enable_badge: false,
      update_feed_rank: false,
    })
  })

  test('keeps every display switch at the official default when unset', async () => {
    const { client, calls } = stubClient([createOk()])
    await createFeishuCotClient(client).createCot({ chatId: 'oc-chat-1' })

    expect(calls[0]?.data).toEqual({
      receive_id: 'oc-chat-1',
      cot_hidden: false,
      enable_badge: false,
      update_feed_rank: false,
    })
    expect(calls[0]?.data).not.toHaveProperty('reply_in_thread')
  })

  test.each([false, true])('sends an explicitly configured reply_in_thread=%s', async (value) => {
    const { client, calls } = stubClient([createOk()])
    await createFeishuCotClient(client).createCot({
      chatId: 'oc-chat-1',
      replyInThread: value,
    })

    expect(calls[0]?.data?.['reply_in_thread']).toBe(value)
  })

  test('rejects a non-zero business code without echoing the request', async () => {
    const { client } = stubClient([{ code: 232003, msg: 'permission denied' }])
    await expect(
      createFeishuCotClient(client).createCot({ chatId: 'oc-chat-1' }),
    ).rejects.toThrow('Feishu COT create failed with code 232003: permission denied')
  })

  test('rejects a 0-code response that carries no cot_id', async () => {
    const { client } = stubClient([{ code: 0, data: { message_id: 'om-cot-1' } }])
    await expect(
      createFeishuCotClient(client).createCot({ chatId: 'oc-chat-1' }),
    ).rejects.toThrow('Feishu COT create returned no cot_id')
  })

  test('rejects a 0-code response that carries no message_id', async () => {
    const { client } = stubClient([{ code: 0, data: { cot_id: 'cot-1' } }])
    await expect(
      createFeishuCotClient(client).createCot({ chatId: 'oc-chat-1' }),
    ).rejects.toThrow('Feishu COT create returned no message_id')
  })

  test('rejects an empty chat id before any request', async () => {
    const { client, calls } = stubClient([createOk()])
    await expect(
      createFeishuCotClient(client).createCot({ chatId: '' }),
    ).rejects.toThrow('non-empty chat id')
    expect(calls).toHaveLength(0)
  })
})
describe('appendCot', () => {
  test('PUTs {events, message_id, cot_id} with each event serialized', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    await createFeishuCotClient(client, { now: () => 1_700_000_000_500 }).appendCot({
      cotId: 'cot-1',
      messageId: 'om-cot-1',
      events: [
        { eventType: 'RUN_STARTED', content: { threadId: 'p1', runId: 'p1' } },
        {
          eventType: 'TEXT_MESSAGE_START',
          content: { messageId: 'evt-1', role: 'assistant' },
        },
      ],
    })

    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toBe('/open-apis/im/v1/message_cot')
    expect(calls[0]?.params).toBeUndefined()
    expect(Object.keys(calls[0]?.data ?? {}).sort()).toEqual([
      'cot_id',
      'events',
      'message_id',
    ])
    expect(calls[0]?.data?.['cot_id']).toBe('cot-1')
    expect(calls[0]?.data?.['message_id']).toBe('om-cot-1')

    const events = wireEvents(calls[0])
    expect(events).toEqual([
      {
        event_type: 'RUN_STARTED',
        content: '{"threadId":"p1","runId":"p1"}',
        timestamp: 1_700_000_000_500,
      },
      {
        event_type: 'TEXT_MESSAGE_START',
        content: '{"messageId":"evt-1","role":"assistant"}',
        timestamp: 1_700_000_000_500,
      },
    ])
    expect(JSON.parse(events[0]?.content ?? 'null')).toEqual({
      threadId: 'p1',
      runId: 'p1',
    })
  })

  test('stamps a millisecond timestamp from the real clock by default', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    const before = Date.now()
    await createFeishuCotClient(client).appendCot({
      cotId: 'cot-1',
      messageId: 'om-cot-1',
      events: [{ eventType: 'RUN_STARTED', content: {} }],
    })
    const after = Date.now()

    const timestamp = wireEvents(calls[0])[0]?.timestamp ?? 0
    expect(Number.isInteger(timestamp)).toBe(true)
    expect(timestamp).toBeGreaterThanOrEqual(before)
    expect(timestamp).toBeLessThanOrEqual(after)
    // Milliseconds, not seconds: a seconds-based stamp would be ~1e10.
    expect(timestamp).toBeGreaterThan(1_000_000_000_000)
  })

  test('accepts exactly the official 1..50 batch bound', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    const cot = createFeishuCotClient(client)
    const full = Array.from({ length: FEISHU_COT_APPEND_MAX_EVENTS }, (_, i) => ({
      eventType: 'TEXT_MESSAGE_CONTENT',
      content: { messageId: `evt-${i}`, delta: 'x' },
    }))
    await cot.appendCot({ cotId: 'cot-1', messageId: 'om-cot-1', events: full })
    expect(calls).toHaveLength(1)

    await expect(
      cot.appendCot({ cotId: 'cot-1', messageId: 'om-cot-1', events: [] }),
    ).rejects.toThrow('Feishu COT append takes 1-50 events, got 0')
    await expect(
      cot.appendCot({
        cotId: 'cot-1',
        messageId: 'om-cot-1',
        events: [...full, { eventType: 'RUN_FINISHED', content: {} }],
      }),
    ).rejects.toThrow('Feishu COT append takes 1-50 events, got 51')
    expect(calls).toHaveLength(1)
  })

  test('refuses to append without the create response message id', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    await expect(
      createFeishuCotClient(client).appendCot({
        cotId: 'cot-1',
        messageId: '',
        events: [{ eventType: 'RUN_STARTED', content: {} }],
      }),
    ).rejects.toThrow('cot id and message id from create')
    expect(calls).toHaveLength(0)
  })

  test('rejects a non-zero business code', async () => {
    const { client } = stubClient([{ code: 232010, msg: 'cot already completed' }])
    await expect(
      createFeishuCotClient(client).appendCot({
        cotId: 'cot-1',
        messageId: 'om-cot-1',
        events: [{ eventType: 'RUN_FINISHED', content: {} }],
      }),
    ).rejects.toThrow('Feishu COT append failed with code 232010: cot already completed')
  })
})

describe('completeCot', () => {
  test('posts message_id and reason as query params with no body', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    await createFeishuCotClient(client).completeCot({
      cotId: 'cot/1',
      messageId: 'om-cot-1',
      reason: 'error',
    })

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/open-apis/im/v1/message_cot/complete/cot%2F1')
    expect(calls[0]?.params).toEqual({
      message_id: 'om-cot-1',
      reason: 'error',
    })
    expect(calls[0]?.data).toBeUndefined()
  })

  test('refuses to complete without the create response message id', async () => {
    const { client, calls } = stubClient([{ code: 0 }])
    await expect(
      createFeishuCotClient(client).completeCot({
        cotId: 'cot-1',
        messageId: '',
        reason: 'done',
      }),
    ).rejects.toThrow('cot id and message id from create')
    expect(calls).toHaveLength(0)
  })

  test('surfaces a transport rejection to the caller', async () => {
    const { client } = stubClient([new Error('network down')])
    await expect(
      createFeishuCotClient(client).completeCot({
        cotId: 'cot-1',
        messageId: 'om-cot-1',
        reason: 'done',
      }),
    ).rejects.toThrow('network down')
  })
})
