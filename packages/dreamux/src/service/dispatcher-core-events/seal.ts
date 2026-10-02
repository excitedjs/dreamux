/**
 * The one place a published fact becomes deliverable.
 *
 * Every Core event is built by a Core Service as a fresh typed object literal
 * whose fields come from that Service's own authoritative state, so its shape
 * and catalog membership are already the compiler's to guarantee. What a type
 * cannot carry is that nothing can rewrite the value after it has been
 * broadcast to every listener, which is what freezing it here states.
 */
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';

import { deepFreeze } from '../../platform/json-value.js';

export function sealChannelCoreEvent(
  event: ChannelCoreEvent,
): ChannelCoreEvent {
  return deepFreeze(event);
}
