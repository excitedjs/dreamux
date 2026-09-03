/**
 * The published catalog, and the one place a fact becomes deliverable.
 *
 * Every Core event is built by a Core Service as a fresh typed object literal
 * whose fields come from that Service's own authoritative state, so the shape
 * of a payload is already the compiler's to guarantee. What a type cannot
 * carry is the two facts this module states: that the value belongs to the
 * catalog at the version a Channel switches on, and that nothing can rewrite
 * it after it has been broadcast to every listener.
 *
 * A rejected event is dropped, never thrown. Producers publish synchronously
 * from inside operations whose durable work has already succeeded, so a seal
 * that threw would turn a defect in a redundant projection into a failed Core
 * operation — the opposite of what the projection exists for.
 */
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';

import { deepFreeze } from '../frozen-snapshot.js';

/**
 * The catalog itself.
 *
 * A Channel switches on `kind`, so an unknown one is not a fact it can act on;
 * it is a Core defect, and the log line the bus writes on rejection is how it
 * is seen. Declaring it as a total record over the union is what keeps that
 * true: a new event kind that is not listed here fails to compile, where a bare
 * set of strings would have let it be published and silently dropped.
 */
const KIND_CATALOG: Record<ChannelCoreEvent['kind'], true> = {
  'team.state': true,
  'teammate.state': true,
  'teammate.input': true,
  'teammate.activity': true,
};

const KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_CATALOG));

export function sealChannelCoreEvent(
  event: ChannelCoreEvent,
): ChannelCoreEvent | null {
  if (!KINDS.has(event?.kind)) return null;
  // The version a subscriber was promised, and the ordering key it applies.
  if (event.schema_version !== 1) return null;
  if (!Number.isFinite(event.occurred_at)) return null;
  return deepFreeze(event);
}
