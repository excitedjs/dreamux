/**
 * Test helpers for the neutral channel-provider seam (issue #209 cleanup).
 *
 * Production resolves a `ChannelProvider` from a `ChannelProviderCatalog` and
 * drives the neutral `ChannelSession` it returns; the legacy `botFactory` /
 * `skipBotSecret` Server/Service options are gone. Tests inject a channel
 * catalog instead:
 *
 * - `feishuChannelCatalog(botFactory)` — the REAL `@excitedjs/feishu-channel`
 *   provider with its bot connection replaced by a test bot (the provider's
 *   `botFactory` seam). Use it when a test verifies real Feishu wire semantics
 *   (reply/react mapping, inbound delivery, and the sender-loop gate).
 * - `stubChannelCatalog()` — a no-op `ChannelSession` that only needs to start /
 *   close so a dispatcher comes up. Use it when the channel is incidental (the
 *   test drives completion delivery or routing through other seams).
 */
import { createBuiltinProviderRegistry } from '../../src/registry/index.js';
import { BUILTIN_FEISHU_PROVIDER_REF } from '../../src/registry/builtins.js';
import {
  ChannelProviderCatalog,
} from '../../src/channel/catalog.js';
import {
  createFeishuChannelProvider,
  type FeishuBot,
  type FeishuChannelConfig,
} from '@excitedjs/feishu-channel';
import type {
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelSession,
  ChannelTarget,
} from '@excitedjs/dreamux-types';

const FEISHU_DESCRIPTOR: ChannelProviderDescriptor = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: BUILTIN_FEISHU_PROVIDER_REF },
};

function catalogWith(provider: ChannelProvider): ChannelProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(BUILTIN_FEISHU_PROVIDER_REF);
  registry.registerImplementation(descriptor.id, provider);
  return new ChannelProviderCatalog({ registry });
}

/**
 * A `ChannelProviderCatalog` backed by the real Feishu provider whose bot is the
 * test bot built by `botFactory`. The factory receives the validated channel
 * config so a multi-channel test can key a distinct bot per app identity.
 */
export function feishuChannelCatalog(
  botFactory: (config: FeishuChannelConfig) => FeishuBot,
): ChannelProviderCatalog {
  return catalogWith(createFeishuChannelProvider({ botFactory }));
}

/** A minimal no-op neutral `ChannelSession` (start/close/resolveTarget only). */
function stubSession(channelId: string): ChannelSession {
  return {
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    channel_id: channelId,
    async start() {
      /* no-op: the channel is incidental to the test */
    },
    async close() {
      /* no-op */
    },
    async resolveTarget(meta: unknown): Promise<ChannelTarget> {
      const chatId =
        typeof (meta as { chat_id?: unknown })?.chat_id === 'string'
          ? ((meta as { chat_id: string }).chat_id)
          : 'chat-stub';
      return {
        target_type: 'group',
        target_key: chatId,
        bindable: true,
        meta: { chat_id: chatId },
      };
    },
  };
}

/**
 * A `ChannelProviderCatalog` whose sessions are no-op stubs. The dispatcher
 * comes up with a live (inert) channel; tests that never drive inbound through
 * the channel use this.
 */
export function stubChannelCatalog(): ChannelProviderCatalog {
  const provider: ChannelProvider = {
    ref: BUILTIN_FEISHU_PROVIDER_REF,
    descriptor: FEISHU_DESCRIPTOR,
    readConfig(raw) {
      return raw;
    },
    createSession(context) {
      return stubSession(context.channel_id);
    },
  };
  return catalogWith(provider);
}
