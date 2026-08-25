import type {
  ChannelInboundEnvelope,
  ChannelOrigin,
} from '@excitedjs/dreamux-types';

import { endpointFromBinding } from './binding-events.js';
import type { ChannelBinding } from './channel-binding/store.js';
import { immutableJsonSnapshot } from './frozen-snapshot.js';

/**
 * Freeze the inbound location a channel turn was routed from, at the moment the
 * route is decided.
 *
 * `target` stays the exact inbound target the provider produced, while
 * `binding` describes the endpoint whose Team binding actually accepted it — a
 * topic delivered through its group's binding keeps both facts. Core never
 * interprets either beyond passing them back to channel providers.
 *
 * Returns `null` when no safe snapshot can be taken. Target metadata is
 * provider-owned and opaque, so it may hold something JSON cannot represent
 * (a cycle, a BigInt). This is an optional display fact layered on top of
 * delivery: the turn must still be routed and admitted normally, just without
 * an origin — never rejected because its presentation could not be described.
 */
export function channelOriginFromRoute(input: {
  envelope: ChannelInboundEnvelope;
  binding: ChannelBinding;
}): ChannelOrigin | null {
  try {
    return Object.freeze({
      provider: input.envelope.provider,
      channel_id: input.envelope.channel_id,
      message_id: input.envelope.message_id ?? null,
      target: immutableJsonSnapshot(input.envelope.target),
      binding: endpointFromBinding(input.binding),
    });
  } catch {
    return null;
  }
}

/** Freeze the exact inbound endpoint when the dispatcher accepts it directly. */
export function channelOriginFromDispatcherRoute(
  envelope: ChannelInboundEnvelope,
): ChannelOrigin | null {
  try {
    const target = immutableJsonSnapshot(envelope.target);
    return Object.freeze({
      provider: envelope.provider,
      channel_id: envelope.channel_id,
      message_id: envelope.message_id ?? null,
      target,
      binding: null,
    });
  } catch {
    return null;
  }
}
