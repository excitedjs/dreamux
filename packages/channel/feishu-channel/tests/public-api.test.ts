import { describe, expect, it } from 'vitest';

import * as feishuChannel from '../src/index.js';
import { dreamuxFeishuGate } from '../src/access/gate.js';

/**
 * Every name a prior Core-owned binding/Collaboration Space/target-resolution
 * architecture used, per the frozen "DELETED SURFACES" list this refactor
 * retired. None of them names a real export today, and none may be
 * reintroduced as one without a superseding decision record.
 */
const NEVER_EXPORTED = [
  'ChannelRoutes',
  'ChannelSession',
  'resolveTarget',
  'resolveInboundBinding',
  'messageBelongsToTarget',
  'ChannelOrigin',
  'target_key',
  'binding_fallbacks',
  'transfer_back',
  'CollaborationSpace',
  'CollaborationSpaceService',
  'CollaborationSpaceCommand',
  'ProvisionedTargetRecord',
  'FeishuBindingOperations',
  'FeishuProvisioning',
];

describe('@excitedjs/feishu-channel public API', () => {
  it('exports exactly the intentional public surface — no more, no less', () => {
    expect(Object.keys(feishuChannel).sort()).toEqual([
      'DREAMUX_ACTION_KEY',
      'createFeishuChannelProvider',
      'createFeishuPlugin',
      'default',
      'formatFeishuMessageForRuntime',
      'rawCardActionResponse',
    ]);
  });

  it('does not export the test-only fake bot factory', () => {
    expect(Object.hasOwn(feishuChannel, 'createFakeFeishuBot')).toBe(false);
    expect('FakeFeishuBot' in feishuChannel).toBe(false);
  });

  it('does not retain automatic inbound reaction constants', () => {
    expect(Object.hasOwn(feishuChannel, 'RECEIVED_REACTION_EMOJI')).toBe(false);
    expect(Object.hasOwn(feishuChannel, 'IN_PROGRESS_REACTION_EMOJI')).toBe(
      false,
    );
  });

  it('never re-exports a name from the deleted Core binding/routing/Collaboration Space architecture', () => {
    for (const name of NEVER_EXPORTED) {
      expect(Object.hasOwn(feishuChannel, name)).toBe(false);
    }
  });
});

it('retains the gate input ABI and requires prior exact-human classification', () => {
  type PublicGateInput = Parameters<typeof dreamuxFeishuGate>[1];
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
