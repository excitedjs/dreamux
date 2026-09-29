import { describe, expect, it } from 'vitest';

import * as feishuChannel from '../src/index.js';

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
