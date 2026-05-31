import { describe, expect, test } from 'vitest'
import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  normalizeBotMemberAddedEvent,
} from '../src/parse/bot-member'

describe('normalizeBotMemberAddedEvent', () => {
  test('exports the Feishu bot-member-added event type', () => {
    expect(BOT_MEMBER_ADDED_EVENT_TYPE).toBe('im.chat.member.bot.added_v1')
  })

  test('extracts chat id and event id from a full event envelope', () => {
    expect(
      normalizeBotMemberAddedEvent({
        header: {
          event_id: 'evt_1',
          event_type: BOT_MEMBER_ADDED_EVENT_TYPE,
        },
        event: {
          chat_id: 'oc_1',
        },
      }),
    ).toEqual({
      chatId: 'oc_1',
      eventId: 'evt_1',
    })
  })

  test('accepts a bare event body and leaves event id empty', () => {
    expect(normalizeBotMemberAddedEvent({ chat_id: 'oc_2' })).toEqual({
      chatId: 'oc_2',
      eventId: '',
    })
  })

  test('returns null for non-object or unroutable payloads', () => {
    expect(normalizeBotMemberAddedEvent(null)).toBeNull()
    expect(normalizeBotMemberAddedEvent('not an event')).toBeNull()
    expect(normalizeBotMemberAddedEvent({})).toBeNull()
    expect(normalizeBotMemberAddedEvent({ event: {} })).toBeNull()
    expect(normalizeBotMemberAddedEvent({ event: { chat_id: '' } })).toBeNull()
    expect(normalizeBotMemberAddedEvent({ event: { chat_id: 42 } })).toBeNull()
  })
})
