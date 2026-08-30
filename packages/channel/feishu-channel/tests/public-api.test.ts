import { describe, expect, it } from 'vitest';

import * as feishuChannel from '../src/index.js';

// @ts-expect-error -- test doubles must not return to the published package API.
export type RemovedFakeFeishuBotMustStayUnexported =
  import('../src/index.js').FakeFeishuBot;

/**
 * Every runtime binding `src/index.ts` currently exports, sorted. This is the
 * package's intentional public surface (COVERAGE CELL F): a name added here
 * without also being added to `src/index.ts`'s own export list is a failing
 * assertion, which is what makes an *accidental* new export — including a
 * resurrected Core binding/Collaboration Space surface — visible in review
 * rather than silently shipping.
 */
const EXPECTED_EXPORTS = [
  'BUILTIN_FEISHU_PROVIDER_REF',
  'CHANNEL_REMINDER',
  'DREAMUX_ACTION_KEY',
  'DREAMUX_PAIRING_CARD_ACTION',
  'DREAMUX_PAIRING_TOKEN_KEY',
  'FEISHU_ROUTING_DOCUMENT_VERSION',
  'FEISHU_TOOLS',
  'FeishuChannelSession',
  'FeishuRouting',
  'FeishuRoutingStore',
  'TRUST_DOMAIN_WARNING',
  'buildPairingApprovalCard',
  'buildPairingSuccessCard',
  'channelOutboundToFeishuTarget',
  'chatTarget',
  'createFeishuBot',
  'createFeishuChannelProvider',
  'createFeishuSessionMcp',
  'default',
  'defaultDispatcherAccessState',
  'describeTarget',
  'dreamuxFeishuGate',
  'feishuToolRegistrations',
  'feishuToolsFor',
  'findFeishuTool',
  'formatFeishuCreateTime',
  'formatFeishuMessageForRuntime',
  'listChatBots',
  'loadChatBots',
  'loadDispatcherAccess',
  'rawCardActionResponse',
  'routingDocumentFilename',
  'saveDispatcherAccess',
  'targetKey',
  'toWireChatBot',
  'topicTarget',
  'FEISHU_SKILL_FALLBACK_NOTE',
].sort();

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
];

describe('@excitedjs/feishu-channel public API', () => {
  it('does not export the test-only fake bot factory', () => {
    expect(Object.hasOwn(feishuChannel, 'createFakeFeishuBot')).toBe(false);
  });

  it('does not retain automatic inbound reaction constants', () => {
    expect(Object.hasOwn(feishuChannel, 'RECEIVED_REACTION_EMOJI')).toBe(false);
    expect(Object.hasOwn(feishuChannel, 'IN_PROGRESS_REACTION_EMOJI')).toBe(false);
  });

  it('exports exactly the intentional public surface — no more, no less', () => {
    const actual = Object.keys(feishuChannel).sort();
    expect(actual).toEqual(EXPECTED_EXPORTS);
  });

  it('never re-exports a name from the deleted Core binding/routing/Collaboration Space architecture', () => {
    for (const name of NEVER_EXPORTED) {
      expect(Object.hasOwn(feishuChannel, name)).toBe(false);
    }
  });

  it('the routing surface it does export owns only Feishu-local target/document concepts, never a Core Command or event type name', () => {
    // `FeishuRouting`'s own read/write surface must be the whole story: Core
    // is asked a `team_name` fact through the generic `invoke` port and never
    // exposes a binding-shaped Command of its own for this package to import.
    expect(Object.hasOwn(feishuChannel, 'FeishuRouting')).toBe(true);
    expect(Object.hasOwn(feishuChannel, 'FeishuBindingOperations')).toBe(false);
    expect(Object.hasOwn(feishuChannel, 'FeishuProvisioning')).toBe(false);
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
