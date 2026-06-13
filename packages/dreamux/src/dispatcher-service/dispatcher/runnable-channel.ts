/**
 * The runnable-channel-shape guard (issue #209 multi-channel config).
 *
 * Config accepts the general multi-channel shape (`dispatchers[].channels[]` may
 * hold more than one channel, and a channel may name any registered provider),
 * but live multi-channel routing is a follow-up slice. A *runnable* dispatcher
 * must therefore declare exactly one channel and it must be `builtin:feishu`.
 *
 * This guard is the single intended runtime boundary where every "accepted by
 * config, not yet runnable" shape fails loud — state construction (the dispatcher
 * store) stays fail-soft so the failure surfaces here at launch, not earlier
 * during seeding. Keep it a pure function so the boundary is unit-testable
 * without standing up a live dispatcher.
 */
import { BUILTIN_FEISHU_PROVIDER_REF } from '../../config/config.js';
import type { DispatcherChannelConfig } from '../../config/config.js';

export function assertRunnableChannelShape(dispatcher: {
  id: string;
  channels: DispatcherChannelConfig[];
}): void {
  const { id, channels } = dispatcher;
  if (channels.length > 1) {
    throw new Error(
      `dispatcher '${id}' declares ${channels.length} channels; live multi-channel routing is a follow-up slice, so a runnable dispatcher must declare exactly one ${BUILTIN_FEISHU_PROVIDER_REF} channel`,
    );
  }
  const channelRef = channels[0]?.provider ?? BUILTIN_FEISHU_PROVIDER_REF;
  if (channelRef !== BUILTIN_FEISHU_PROVIDER_REF) {
    throw new Error(
      `dispatcher '${id}' channel ${JSON.stringify(channelRef)} is not wired; only ${BUILTIN_FEISHU_PROVIDER_REF} is built in this phase`,
    );
  }
}
