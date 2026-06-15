/**
 * The runnable-channel-shape guard (issue #209 multi-channel config).
 *
 * Config accepts the general multi-channel shape (`dispatchers[].channels[]` may
 * hold more than one channel, and a channel may name any registered provider).
 * A channel is RUNNABLE when its provider resolves to a loaded implementation in
 * the channel catalog — core names no concrete provider here, so any builtin or
 * npm channel provider that loaded is runnable. A channel whose provider has no
 * loaded implementation fails loud at launch.
 *
 * This guard is the single intended runtime boundary where every "accepted by
 * config, not yet runnable" shape fails loud — state construction (the dispatcher
 * store) stays fail-soft so the failure surfaces here at launch, not earlier
 * during seeding. It takes only the catalog's `resolve` seam so the boundary is
 * unit-testable without standing up a live dispatcher.
 */
import type { DispatcherChannelConfig } from '../../config/config.js';

/** The channel-catalog seam the guard needs: resolve a provider ref or throw. */
export interface ChannelProviderResolver {
  resolve(ref: string): unknown;
}

export function assertRunnableChannelShape(
  dispatcher: {
    id: string;
    channels: DispatcherChannelConfig[];
  },
  channelProviders: ChannelProviderResolver,
): void {
  const { id, channels } = dispatcher;
  for (const channel of channels) {
    try {
      channelProviders.resolve(channel.provider);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `dispatcher '${id}' channel ${JSON.stringify(channel.provider)} is not runnable: ${reason}`,
      );
    }
  }
}
