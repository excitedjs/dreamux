import { describe, expect, it } from 'vitest';

import * as feishuChannel from '../src/index.js';

// @ts-expect-error -- test doubles must not return to the published package API.
export type RemovedFakeFeishuBotMustStayUnexported =
  import('../src/index.js').FakeFeishuBot;

describe('@excitedjs/feishu-channel public API', () => {
  it('does not export the test-only fake bot factory', () => {
    expect(Object.hasOwn(feishuChannel, 'createFakeFeishuBot')).toBe(false);
  });

  it('does not retain automatic inbound reaction constants', () => {
    expect(Object.hasOwn(feishuChannel, 'RECEIVED_REACTION_EMOJI')).toBe(false);
    expect(Object.hasOwn(feishuChannel, 'IN_PROGRESS_REACTION_EMOJI')).toBe(false);
  });

  it('retains the gate input ABI and requires prior exact-human classification', () => {
    type PublicGateInput = Parameters<typeof feishuChannel.dreamuxFeishuGate>[1];
    const input: PublicGateInput = {
      chat_type: 'group',
      sender_id: 'ou_human',
      chat_id: 'oc_trusted',
      is_bot_sender: false,
      trusted_bot: false,
      bot_mentioned: true,
    };
    expect(input).toHaveProperty('is_bot_sender', false);
    expect(input).not.toHaveProperty('sender_kind');

    // @ts-expect-error is_bot_sender remains required on the public input.
    const missingBotFlag: PublicGateInput = {
      chat_type: 'group',
      sender_id: 'ou_human',
      chat_id: 'oc_trusted',
      trusted_bot: false,
      bot_mentioned: true,
    };
    expect(missingBotFlag).not.toHaveProperty('is_bot_sender');

    const noSenderKind: PublicGateInput = {
      ...input,
      // @ts-expect-error sender_kind was not added to the public input ABI.
      sender_kind: 'human',
    };
    expect(noSenderKind).toHaveProperty('sender_kind', 'human');
  });
});
