/**
 * Dispatcher runtime-boundary guard (issue #209 live multi-channel routing).
 *
 * `assertRunnableChannelShape` is the single intended place where a config that
 * is *accepted* but *not yet runnable* fails loud. A channel is runnable when its
 * provider resolves to a loaded implementation in the channel catalog — core
 * names no concrete provider, so any builtin/npm channel that loaded is runnable;
 * only a channel whose provider has no loaded implementation is rejected. State
 * seeding stays fail-soft; this guard does the rejecting.
 */
import { describe, expect, it } from 'vitest';

import type { DispatcherChannelConfig } from '../src/config/config.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import {
  assertRunnableChannelShape,
  type ChannelProviderResolver,
} from '../src/service/dispatcher-service/runnable-channel.js';
import { createFakeChannelProvider } from './helpers/fake-channel-provider.js';

function channel(id: string, provider: string): DispatcherChannelConfig {
  return { id, provider, config: {} as never };
}

/** A fake catalog: resolves the given loaded refs, throws (unloaded) otherwise. */
function resolverWith(...loaded: string[]): ChannelProviderResolver {
  const set = new Set(loaded);
  return {
    resolve(ref: string): unknown {
      if (!set.has(ref)) {
        throw new Error(`channel provider ${JSON.stringify(ref)} is not supported`);
      }
      return {};
    },
  };
}

describe('assertRunnableChannelShape', () => {
  it('accepts a single channel whose provider resolves', () => {
    expect(() =>
      assertRunnableChannelShape(
        { id: 'flow', channels: [channel('primary', 'builtin:feishu')] },
        resolverWith('builtin:feishu'),
      ),
    ).not.toThrow();
  });

  it('accepts more than one channel when each provider resolves (any provider, not just feishu)', () => {
    expect(() =>
      assertRunnableChannelShape(
        {
          id: 'flow',
          channels: [
            channel('primary', 'builtin:feishu'),
            channel('secondary', 'npm:@example/dreamux-slack#channel'),
          ],
        },
        resolverWith('builtin:feishu', 'npm:@example/dreamux-slack#channel'),
      ),
    ).not.toThrow();
  });

  it('rejects a channel whose provider has no loaded implementation', () => {
    expect(() =>
      assertRunnableChannelShape(
        {
          id: 'flow',
          channels: [
            channel('primary', 'builtin:feishu'),
            channel('secondary', 'npm:@example/dreamux-other#channel'),
          ],
        },
        resolverWith('builtin:feishu'),
      ),
    ).toThrow(/channel "npm:@example\/dreamux-other#channel" is not runnable/);
  });

  /**
   * The two tests above use a hand-built resolver; these two run the same
   * guard against the real `ChannelProviderCatalog` + `ProviderRegistry` seam
   * it is actually composed with in production, so a real
   * `WrongChannelProviderKindError`/`UnsupportedChannelProviderError` reason
   * propagates through the guard's message rather than a test-only stand-in.
   */
  it('propagates the real catalog\'s wrong-kind reason through the guard message', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'npm:@example/wrong-kind#create',
      kind: 'agentRuntime',
      ref: parseProviderRef('npm:@example/wrong-kind#create'),
    });
    const catalog = new ChannelProviderCatalog({ registry });

    expect(() =>
      assertRunnableChannelShape(
        { id: 'flow', channels: [channel('primary', 'npm:@example/wrong-kind#create')] },
        catalog,
      ),
    ).toThrow(/is a agentRuntime provider, expected channel/);
  });

  it('accepts a channel resolved through the real catalog once its implementation is registered', () => {
    const registry = new ProviderRegistry();
    const descriptor = {
      id: 'npm:@example/real#create',
      kind: 'channel' as const,
      ref: parseProviderRef('npm:@example/real#create'),
    };
    registry.register(descriptor);
    registry.registerImplementation(descriptor.id, createFakeChannelProvider().provider);
    const catalog = new ChannelProviderCatalog({ registry });

    expect(() =>
      assertRunnableChannelShape(
        { id: 'flow', channels: [channel('primary', 'npm:@example/real#create')] },
        catalog,
      ),
    ).not.toThrow();
  });

  it('rejects, through the real catalog, a descriptor registered without a loaded implementation', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'npm:@example/unloaded#create',
      kind: 'channel',
      ref: parseProviderRef('npm:@example/unloaded#create'),
    });
    const catalog = new ChannelProviderCatalog({ registry });

    expect(() =>
      assertRunnableChannelShape(
        { id: 'flow', channels: [channel('primary', 'npm:@example/unloaded#create')] },
        catalog,
      ),
    ).toThrow(/has no channel implementation wired/);
  });
});
