import { describe, expect, test } from 'vitest';
import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  normalizeBotMemberAddedEvent,
} from '../src/parse/bot-member';

describe('normalizeBotMemberAddedEvent', () => {
  test('exports the Feishu bot-member-added event type', () => {
    expect(BOT_MEMBER_ADDED_EVENT_TYPE).toBe('im.chat.member.bot.added_v1');
  });

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
    });
  });

  test('reads the event id from the flattened envelope a live route receives', () => {
    // What the SDK actually hands a route handler: `RequestHandle.parse`
    // destructures `header` and `event` away and spreads both onto the top
    // level, so the id is there and `header` is gone. Reading only
    // `header.event_id` yielded '' on every real event.
    expect(
      normalizeBotMemberAddedEvent({
        schema: '2.0',
        event_id: 'evt_flat',
        event_type: BOT_MEMBER_ADDED_EVENT_TYPE,
        token: 't',
        create_time: '1',
        app_id: 'cli_x',
        tenant_key: 'k',
        chat_id: 'oc_flat',
      }),
    ).toEqual({ chatId: 'oc_flat', eventId: 'evt_flat' });
  });

  test('accepts a bare event body and leaves event id empty', () => {
    expect(normalizeBotMemberAddedEvent({ chat_id: 'oc_2' })).toEqual({
      chatId: 'oc_2',
      eventId: '',
    });
  });

  test('returns null for non-object or unroutable payloads', () => {
    expect(normalizeBotMemberAddedEvent(null)).toBeNull();
    expect(normalizeBotMemberAddedEvent('not an event')).toBeNull();
    expect(normalizeBotMemberAddedEvent({})).toBeNull();
    expect(normalizeBotMemberAddedEvent({ event: {} })).toBeNull();
    expect(normalizeBotMemberAddedEvent({ event: { chat_id: '' } })).toBeNull();
    expect(normalizeBotMemberAddedEvent({ event: { chat_id: 42 } })).toBeNull();
  });
});
