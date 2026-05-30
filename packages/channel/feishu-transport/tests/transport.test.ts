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
 * `sendText(chatId, text)` — the PR1 impl reads only `target.chatId`, so these
 * assertions are unchanged in behavior.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { describe, expect, test, vi } from 'vitest'
import {
  FEISHU_CARD_CONTENT_SAFE_BYTES,
  commentFromBatchQuery,
  createFeishuTransport,
} from '../src/transport/feishu'

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
  const patch = vi.fn(async () => ({}))
  const update = vi.fn(async () => ({}))
  const reactionCreate = vi.fn(async () => ({ data: { reaction_id: 'rk_stub' } }))
  const reactionDelete = vi.fn(async () => ({}))
  const stub = {
    im: {
      message: { create, patch, update },
      messageReaction: { create: reactionCreate, delete: reactionDelete },
    },
    drive: {
      fileComment: { batchQuery: vi.fn(async () => ({ data: { items: [] } })) },
      meta: { batchQuery: vi.fn(async () => ({ data: { metas: [] } })) },
    },
    request: vi.fn(async () => ({})),
  }
  return {
    client: stub as unknown as lark.Client,
    create,
    patch,
    update,
    reactionCreate,
    reactionDelete,
  }
}

function buildTransport(stub: ReturnType<typeof stubClient>) {
  return createFeishuTransport({ appId: 'app', appSecret: 'secret' }, { client: stub.client })
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

  test('removeReaction deletes by message and reaction id', async () => {
    const stub = stubClient()
    const transport = buildTransport(stub)

    await transport.removeReaction('om_target', 'rk_stub')

    expect(stub.reactionDelete).toHaveBeenCalledTimes(1)
    const calls = stub.reactionDelete.mock.calls as unknown as Array<
      [{ path: { message_id: string; reaction_id: string } }]
    >
    const call = calls[0]?.[0]
    expect(call?.path.message_id).toBe('om_target')
    expect(call?.path.reaction_id).toBe('rk_stub')
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
