/**
 * The runnable-channel-shape guard (issue #209 multi-channel config).
 *
 * Config accepts the general multi-channel shape (`dispatchers[].channels[]` may
 * hold more than one channel, and a channel may name any registered provider).
 * Live multi-channel routing now runs one Feishu session per channel, so a
 * runnable dispatcher MAY declare more than one channel — but every channel must
 * be `builtin:feishu`, the only provider wired into the dispatcher service in
 * this phase. A channel naming any other (not-yet-wired) provider fails loud here.
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
  const unwired = channels.find(
    (channel) => channel.provider !== BUILTIN_FEISHU_PROVIDER_REF,
  );
  if (unwired !== undefined) {
    throw new Error(
      `dispatcher '${id}' channel ${JSON.stringify(unwired.provider)} is not wired; only ${BUILTIN_FEISHU_PROVIDER_REF} is built in this phase`,
    );
  }
}
