import type {
  ChannelToolCall,
  SubscribeChannelProvider,
  SubscribeChannelToolContext,
} from '@excitedjs/dreamux-types';

import {
  parseProviderRef,
  ProviderRegistry,
} from '../../src/registry/index.js';
import { SubscribeChannelProviderCatalog } from '../../src/subscribe-channel/catalog.js';

export const SUBSCRIBE_PROVIDER_REF = 'builtin:example-subscription';

export interface FakeSubscribeChannelCatalog {
  catalog: SubscribeChannelProviderCatalog;
  handled: Array<{
    call: ChannelToolCall;
    context: SubscribeChannelToolContext;
  }>;
  configReads: unknown[];
  starts: number;
}

export function fakeSubscribeChannelCatalog(): FakeSubscribeChannelCatalog {
  const registry = new ProviderRegistry();
  const descriptor = {
    id: 'example-subscription',
    kind: 'subscribeChannel' as const,
    ref: parseProviderRef(SUBSCRIBE_PROVIDER_REF),
  };
  const handled: FakeSubscribeChannelCatalog['handled'] = [];
  const configReads: unknown[] = [];
  let starts = 0;
  const provider: SubscribeChannelProvider = {
    ref: SUBSCRIBE_PROVIDER_REF,
    descriptor,
    readConfig: (raw) => raw,
    createSession: () => ({
      provider: SUBSCRIBE_PROVIDER_REF,
      subscription_id: 'issues',
      start: async () => {
        starts += 1;
      },
      close: async () => undefined,
    }),
    tools: (config) => {
      configReads.push(config);
      return [{ name: 'ack_issue' }];
    },
    handleTool: async (call, context) => {
      handled.push({ call, context });
      return { ok: true, received: call.arguments };
    },
  };
  registry.register(descriptor);
  registry.registerImplementation(descriptor.id, provider);
  return {
    catalog: new SubscribeChannelProviderCatalog({ registry }),
    handled,
    configReads,
    get starts() {
      return starts;
    },
  };
}
