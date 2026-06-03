import { describe, expect, it } from 'vitest';

import {
  FEISHU_SKILL_FALLBACK_NOTE,
  formatFeishuCreateTime,
  formatFeishuMessageForCodex,
} from '../src/channel/feishu-message.js';
import type { FeishuInboundEvent } from '../src/feishu/bot.js';

describe('formatFeishuMessageForCodex', () => {
  it('formats text events with routable ids, empty sender_name, ISO time, and mention tags', () => {
    expect(formatFeishuMessageForCodex(event())).toBe([
      '<feishu_message',
      '  chat_id="chat-group-a"',
      '  chat_type="group"',
      '  message_id="message-1"',
      '  sender_id="sender-user"',
      '  sender_name=""',
      '  create_time="2024-03-09T16:00:00.000Z">',
      'hello <at id="mentioned-user">Ada</at> &amp; &lt;ok&gt;',
      '</feishu_message>',
    ].join('\n'));
  });

  it('uses a best-effort senderName seam when the adapter supplies one', () => {
    const block = formatFeishuMessageForCodex(
      event({ senderName: 'Ada & Bob' }),
    );

    expect(block).toContain('  sender_name="Ada &amp; Bob"');
  });

  it('adds a Feishu skill fallback note when text content cannot be parsed', () => {
    const block = formatFeishuMessageForCodex(
      event({
        rawContent: 'not json',
        parsedText: 'not json',
      }),
    );

    expect(block).toContain('not json');
    expect(block).toContain(FEISHU_SKILL_FALLBACK_NOTE);
    expect(block).toContain('message_id="message-1"');
    expect(block).toContain('chat_id="chat-group-a"');
  });
});

describe('formatFeishuCreateTime', () => {
  it('normalizes Feishu epoch milliseconds and seconds to ISO strings', () => {
    expect(formatFeishuCreateTime('1710000000000')).toBe(
      '2024-03-09T16:00:00.000Z',
    );
    expect(formatFeishuCreateTime('1710000000')).toBe(
      '2024-03-09T16:00:00.000Z',
    );
  });
});

function event(
  overrides: Partial<FeishuInboundEvent> = {},
): FeishuInboundEvent {
  return {
    messageId: 'message-1',
    chatId: 'chat-group-a',
    chatType: 'group',
    senderId: 'sender-user',
    senderType: 'user',
    senderName: '',
    messageType: 'text',
    rawContent: JSON.stringify({ text: 'hello @_user_1 & <ok>' }),
    parsedText: 'hello @Ada & <ok>',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'mentioned-user' },
        name: 'Ada',
      },
    ],
    createTime: '1710000000000',
    raw: {},
    ...overrides,
  };
}
