import { describe, expect, it } from 'vitest';

import {
  renderChannelBlock,
  renderChannelInput,
  type InboundTurnInput,
} from '../src/agent-runtime/turn.js';
import { formatFeishuMessageForRuntime } from '../src/channel/feishu/feishu-message.js';
import type { FeishuInboundEvent } from '../src/channel/feishu/bot.js';

describe('renderChannelBlock (native <channel> wrap, shared by both runtimes)', () => {
  it('renders source + attrs + body in the native envelope', () => {
    const out = renderChannelBlock(
      'feishu',
      [
        ['chat_id', 'chat-1'],
        ['sender_id', 'sender-1'],
      ],
      'hello world',
    );
    expect(out).toBe(
      '<channel source="feishu" chat_id="chat-1" sender_id="sender-1">\nhello world\n</channel>',
    );
  });

  it('XML-escapes attribute values and drops unsafe attribute keys', () => {
    const out = renderChannelBlock(
      'feishu',
      [
        ['chat_id', 'a"b<c>&d'],
        ['bad-key', 'dropped'],
        ['1leading', 'dropped'],
      ],
      'body',
    );
    expect(out).toContain('chat_id="a&quot;b&lt;c&gt;&amp;d"');
    expect(out).not.toContain('bad-key');
    expect(out).not.toContain('1leading');
  });
});

describe('renderChannelInput', () => {
  it('wraps a structured channel input into the <channel> block', () => {
    const input: InboundTurnInput = {
      sourceId: 'm1',
      source: 'feishu',
      text: 'ignored fallback',
      attrs: [['chat_id', 'chat-1']],
      body: 'the message',
    };
    expect(renderChannelInput(input)).toBe(
      '<channel source="feishu" chat_id="chat-1">\nthe message\n</channel>',
    );
  });

  it('passes plain input (no attrs/body) through unchanged', () => {
    const input: InboundTurnInput = { sourceId: 'm1', text: 'a trigger turn' };
    expect(renderChannelInput(input)).toBe('a trigger turn');
  });
});

function inboundEvent(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'file',
    rawContent: JSON.stringify({ file_key: 'file-key-1', file_name: 'report.pdf' }),
    parsedText: '(file message)',
    resources: [{ type: 'file', key: 'file-key-1', name: 'report.pdf' }],
    mentions: [],
    createTime: '1700000000000',
    raw: {},
    ...overrides,
  };
}

describe('formatFeishuMessageForRuntime (structured, no pre-rendered XML)', () => {
  it('returns the six display attrs and an unwrapped body (no pre-rendered envelope)', async () => {
    const result = await formatFeishuMessageForRuntime(inboundEvent());
    expect(result.attrs.map(([k]) => k)).toEqual([
      'chat_id',
      'chat_type',
      'message_id',
      'sender_id',
      'sender_name',
      'create_time',
    ]);
    // The channel layer no longer pre-renders any message wrapper — the runtime
    // owns adding the <channel> envelope.
    expect(result.body).not.toContain('<channel');
    expect(result.body).not.toContain('source="feishu"');
    expect(result.attrs.find(([k]) => k === 'chat_id')?.[1]).toBe('chat-1');
  });

  it('keeps attachment refs and the group_bots block inside the rendered <channel>', async () => {
    // No resourceFetcher → the attachment is not downloaded and renders as a
    // text ref in the body; trustedBots adds a <group_bots> block. Both must
    // survive into the wrapped channel block (no content regression).
    const result = await formatFeishuMessageForRuntime(inboundEvent(), {
      trustedBots: [{ openId: 'bot-open-1', name: 'Helper' }],
    });
    expect(result.body).toContain('<attachment');
    expect(result.body).toContain('<group_bots');

    const wrapped = renderChannelInput({
      sourceId: 'msg-1',
      source: 'feishu',
      text: result.body,
      attrs: result.attrs,
      body: result.body,
    });
    expect(wrapped.startsWith('<channel source="feishu"')).toBe(true);
    expect(wrapped).toContain('<attachment');
    expect(wrapped).toContain('<group_bots');
    expect(wrapped.endsWith('</channel>')).toBe(true);
  });
});
