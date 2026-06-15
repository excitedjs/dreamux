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
import {
  assertRunnableChannelShape,
  type ChannelProviderResolver,
} from '../src/dispatcher-service/dispatcher/runnable-channel.js';

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
});
