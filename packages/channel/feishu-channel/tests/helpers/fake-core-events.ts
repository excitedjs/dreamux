import type {
  ChannelCoreEvent,
  ChannelCoreEventKind,
  ChannelCoreEventSource,
} from '@excitedjs/dreamux-types';

export interface FakeCoreEventSource {
  readonly source: ChannelCoreEventSource;
  /** Deliver one event to every live listener of its kind, synchronously. */
  emit(event: ChannelCoreEvent): void;
  /** How many listeners are still subscribed, for unsubscribe assertions. */
  listenerCount(): number;
}
/**
 * A stand-in for core's dispatcher-scoped event source. It fans out by `kind`
 * and never filters by channel, matching the real source — which is exactly the
 * condition the COT adapter's own two-layer takeover has to cope with.
 */
export function createFakeCoreEventSource(): FakeCoreEventSource {
  const listeners = new Set<{
    kind: ChannelCoreEventKind;
    listener: (event: ChannelCoreEvent) => void;
  }>();
  return {
    source: {
      on(kind, listener) {
        const registration = {
          kind,
          listener: listener as (event: ChannelCoreEvent) => void,
        };
        listeners.add(registration);
        return {
          unsubscribe(): void {
            listeners.delete(registration);
          },
        };
      },
    },
    emit(event: ChannelCoreEvent): void {
      for (const registration of [...listeners]) {
        if (registration.kind !== event.kind) continue;
        registration.listener(event);
      }
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}
