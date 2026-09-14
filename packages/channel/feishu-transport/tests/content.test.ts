import { describe, expect, test } from 'vitest'
import { narrowMetaFromEvent, parseInbound } from '../src/parse/content'
import type { InboundMessage } from '../src/parse/content'
import type { Mention } from '../src/contract/types'
import { normalizeMessageReadItem } from '../src/transport/message-read'

function message(type: string, content: unknown, mentions?: Mention[]): InboundMessage {
  return { message_type: type, content: JSON.stringify(content), mentions }
}

describe('parseInbound — text', () => {
  test('keeps the text as written, placeholders included', () => {
    const parsed = parseInbound(message('text', { text: 'hello @_user_1' }, [
      { key: '@_user_1', id: { open_id: 'ou_ada' }, name: 'Ada' },
    ]))

    expect(parsed).toEqual({ text: 'hello @_user_1', resources: [] })
  })

  test('content that is not JSON becomes a marked, incomplete body', () => {
    expect(parseInbound({ message_type: 'text', content: 'not json' })).toEqual({
      text: '(unparseable text message)',
      resources: [],
      incomplete: true,
    })
  })

  test('a message with no content is unparseable too', () => {
    expect(parseInbound({ message_type: 'post' })).toEqual({
      text: '(unparseable post message)',
      resources: [],
      incomplete: true,
    })
  })
})

describe('parseInbound — attachments', () => {
  test('an image message is its key and one image resource', () => {
    expect(parseInbound(message('image', { image_key: 'img_v2_a' }))).toEqual({
      text: 'img_v2_a',
      resources: [{ type: 'image', key: 'img_v2_a' }],
    })
  })

  test('a file message keeps its display name', () => {
    expect(parseInbound(message('file', {
      file_key: 'file_v2_a',
      file_name: 'report.pdf',
    }))).toEqual({
      text: 'file_v2_a',
      resources: [{ type: 'file', key: 'file_v2_a', name: 'report.pdf' }],
    })
  })

  test('a file message without a key is an empty, incomplete body', () => {
    expect(parseInbound(message('file', { file_name: 'report.pdf' }))).toEqual({
      text: '',
      resources: [],
      incomplete: true,
    })
  })

  test('audio is a voice file', () => {
    expect(parseInbound(message('audio', { file_key: 'file_v2_voice' }))).toEqual({
      text: 'file_v2_voice',
      resources: [{ type: 'file', key: 'file_v2_voice', name: 'voice.opus' }],
    })
  })

  test('media is the video and its cover, one per line', () => {
    expect(parseInbound(message('media', {
      file_key: 'file_v2_video',
      image_key: 'img_v2_cover',
    }))).toEqual({
      text: 'file_v2_video\nimg_v2_cover',
      resources: [
        { type: 'file', key: 'file_v2_video', name: 'video.mp4' },
        { type: 'image', key: 'img_v2_cover', name: 'video-cover.jpg' },
      ],
    })
  })

  test('media missing its cover is incomplete', () => {
    const parsed = parseInbound(message('media', { file_key: 'file_v2_video' }))

    expect(parsed.text).toBe('file_v2_video')
    expect(parsed.incomplete).toBe(true)
  })
})

describe('parseInbound — other types', () => {
  test.each([
    ['sticker', {}, '(sticker message; sticker resources are not downloadable)', false],
    ['share_chat', { chat_id: 'oc_shared' }, '(shared chat: oc_shared)', false],
    ['share_chat', {}, '(shared chat)', false],
    ['share_user', { user_id: 'ou_shared' }, '(shared user: ou_shared)', false],
    ['nonsupport', {}, '(unsupported message content not resolved)', true],
    ['future_type', { anything: true }, '(future_type message)', true],
  ])('%s is a bounded marker', (type, content, text, incomplete) => {
    expect(parseInbound(message(type, content))).toEqual({
      text,
      resources: [],
      ...(incomplete ? { incomplete: true } : {}),
    })
  })

  test('a merged-forward message is an empty, complete body whatever it carries', () => {
    // The channel points at the message instead of expanding it, and a read
    // of one comes back with an empty body.
    expect(parseInbound({ message_type: 'merge_forward', content: '' })).toEqual({
      text: '',
      resources: [],
    })
    expect(parseInbound(message('merge_forward', { anything: true }))).toEqual({
      text: '',
      resources: [],
    })
  })
})

describe('narrowMetaFromEvent', () => {
  const payload = {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_sender', union_id: 'on_sender' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_message',
        chat_id: 'oc_chat',
        chat_type: 'group',
        thread_id: 'omt_topic',
        root_id: 'om_root',
        parent_id: 'om_parent',
        create_time: '1710000000000',
        message_type: 'text',
        content: '{"text":"hi"}',
      },
    },
  }

  test('extracts the envelope fields the channel routes on', () => {
    expect(narrowMetaFromEvent(payload)).toEqual({
      message_id: 'om_message',
      chat_id: 'oc_chat',
      chat_type: 'group',
      sender_id: 'ou_sender',
      sender_union_id: 'on_sender',
      sender_type: 'user',
      thread_id: 'omt_topic',
      root_id: 'om_root',
      parent_id: 'om_parent',
      create_time: '1710000000000',
    })
  })

  test('reads an already-unwrapped event payload', () => {
    expect(narrowMetaFromEvent(payload.event)).toMatchObject({
      message_id: 'om_message',
      sender_id: 'ou_sender',
    })
  })

  test('drops missing, empty, nested, and non-string values', () => {
    expect(narrowMetaFromEvent({
      event: {
        sender: { sender_id: { open_id: '' }, sender_type: 7 },
        message: { message_id: 'om_only', chat_id: { nested: true } },
      },
    })).toEqual({ message_id: 'om_only' })
    expect(narrowMetaFromEvent('nonsense')).toEqual({})
    expect(narrowMetaFromEvent(null)).toEqual({})
  })
})

describe('message read mention identity', () => {
  test('an app_id record claims no user identity and the placeholder stays', () => {
    const item = normalizeMessageReadItem({
      message_id: 'om_read',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: '@_user_1 hi' }) },
      mentions: [{
        key: '@_user_1',
        id: 'cli_example',
        id_type: 'app_id',
        name: 'Dreamux',
      }],
    })

    expect(item.mentions).toEqual([{ key: '@_user_1', name: 'Dreamux' }])
    expect(parseInbound({
      message_type: item.messageType,
      content: item.content,
      mentions: item.mentions,
    })).toEqual({ text: '@_user_1 hi', resources: [] })
  })

  test('an omitted id_type still reads as an open id', () => {
    const item = normalizeMessageReadItem({
      message_id: 'om_read',
      msg_type: 'text',
      body: { content: '{}' },
      mentions: [{ key: '@_user_1', id: 'ou_example', name: 'Example' }],
    })

    expect(item.mentions).toEqual([
      { key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' },
    ])
  })
})
