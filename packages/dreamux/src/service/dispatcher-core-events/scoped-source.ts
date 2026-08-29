/**
 * One Channel session's view of its dispatcher's live event stream.
 *
 * The source is whole-union on purpose: a session subscribes once and
 * demultiplexes inside the Channel, so adding an event to the catalog changes
 * the catalog and its consumers and nothing here. Delivery is live and
 * best-effort — listeners run in publication order, are never awaited, and
 * neither a throw nor a rejection escapes into the Core operation that
 * published the fact.
 *
 * The lease belongs to Core, not to the Channel. `revoke` is how shutdown
 * proves no listener can still observe a fact after the boundary closed,
 * independently of whether the Channel remembered to unsubscribe.
 */
import type {
  ChannelCoreEvent,
  ChannelEventSource,
  ChannelEventSubscription,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

type CoreEventHandler = (event: ChannelCoreEvent) => void;
type ChannelEventListener = (event: ChannelCoreEvent) => void | Promise<void>;

export interface ScopedChannelEventSourceLease {
  readonly source: ChannelEventSource;
  revoke(): void;
}

interface ScopedChannelEventSourceInput {
  dispatcherId: string;
  channelId: string;
  log: DreamuxLogger;
  subscribe: (handler: CoreEventHandler) => void;
  unsubscribe: (handler: CoreEventHandler) => void;
}

export function createScopedChannelEventSource(
  input: ScopedChannelEventSourceInput,
): ScopedChannelEventSourceLease {
  // A registration wrapper rather than the function itself, so subscribing the
  // same listener twice yields two independent subscriptions and unsubscribing
  // one leaves the other delivering.
  const listeners = new Set<{ listener: ChannelEventListener }>();
  let active = true;

  const dispatch: CoreEventHandler = (event) => {
    for (const registration of [...listeners]) {
      try {
        void Promise.resolve(registration.listener(event)).catch(
          (error: unknown) => {
            logListenerFailure(input, event.kind, error);
          },
        );
      } catch (error) {
        logListenerFailure(input, event.kind, error);
      }
    }
  };

  const subscribe = (
    listener: ChannelEventListener,
  ): ChannelEventSubscription => {
    if (!active) {
      throw new Error('channel core event source is no longer active');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('channel core event listener must be a function');
    }
    const registration = { listener };
    listeners.add(registration);
    let subscribed = true;
    return Object.freeze({
      unsubscribe(): void {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(registration);
      },
    });
  };

  input.subscribe(dispatch);
  const source: ChannelEventSource = Object.freeze({ subscribe });
  return {
    source,
    revoke(): void {
      if (!active) return;
      active = false;
      input.unsubscribe(dispatch);
      listeners.clear();
    },
  };
}

function logListenerFailure(
  input: {
    dispatcherId: string;
    channelId: string;
    log: DreamuxLogger;
  },
  kind: ChannelCoreEvent['kind'],
  error: unknown,
): void {
  input.log.warn(
    {
      dispatcher_id: input.dispatcherId,
      channel_id: input.channelId,
      event_kind: kind,
      error: error instanceof Error ? error.message : String(error),
    },
    'channel core event listener failed',
  );
}
