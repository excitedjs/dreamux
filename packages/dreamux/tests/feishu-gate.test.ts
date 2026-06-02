import { describe, expect, it } from 'vitest';

import { compatibleFeishuGate } from '../src/channel/feishu-gate.js';

describe('compatibleFeishuGate', () => {
  it('keeps normal user messages deliverable', () => {
    expect(
      compatibleFeishuGate({
        senderId: 'sender-user',
        senderType: 'user',
        chatType: 'group',
        botOpenId: 'bot-open-id',
      }),
    ).toEqual({ action: 'deliver' });
  });

  it('drops missing sender id', () => {
    expect(
      compatibleFeishuGate({
        senderId: '',
        senderType: 'user',
        chatType: 'p2p',
        botOpenId: 'bot-open-id',
      }),
    ).toEqual({ action: 'drop', reason: 'missing sender id' });
  });

  it('drops self-sent bot-loop messages', () => {
    expect(
      compatibleFeishuGate({
        senderId: 'bot-open-id',
        senderType: 'user',
        chatType: 'group',
        botOpenId: 'bot-open-id',
      }),
    ).toEqual({ action: 'drop', reason: 'message sent by this bot' });
  });

  it('drops Feishu bot/app sender types', () => {
    expect(
      compatibleFeishuGate({
        senderId: 'peer-bot',
        senderType: 'app',
        chatType: 'group',
        botOpenId: 'bot-open-id',
      }),
    ).toEqual({ action: 'drop', reason: 'bot sender type: app' });
  });

  it('drops group messages when bot open_id is unknown', () => {
    expect(
      compatibleFeishuGate({
        senderId: 'sender-user',
        senderType: 'user',
        chatType: 'group',
      }),
    ).toEqual({
      action: 'drop',
      reason: 'group message received before bot open_id was resolved',
    });
  });
});
