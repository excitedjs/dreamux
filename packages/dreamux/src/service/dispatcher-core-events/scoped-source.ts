import type {
  ChannelCoreEvent,
  ChannelCoreEventKind,
  ChannelCoreEventListener,
  ChannelCoreEventSource,
  ChannelCoreEventSubscription,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

type CoreEventHandler = (event: ChannelCoreEvent) => void;
type ProviderListener = (event: ChannelCoreEvent) => void | Promise<void>;

export interface ScopedChannelCoreEventSourceLease {
  readonly source: ChannelCoreEventSource;
  revoke(): void;
}

export function createScopedChannelCoreEventSource(input: {
  dispatcherId: string;
  channelId: string;
  log: DreamuxLogger;
  subscribe: (handler: CoreEventHandler) => void;
  unsubscribe: (handler: CoreEventHandler) => void;
}): ScopedChannelCoreEventSourceLease {
  const listeners = new Set<{
    kind: ChannelCoreEventKind;
    listener: ProviderListener;
  }>();
  let active = true;

  const dispatch: CoreEventHandler = (event) => {
    for (const registration of [...listeners]) {
      if (registration.kind !== event.kind) continue;
      try {
        const result = registration.listener(event);
        void Promise.resolve(result).catch((error: unknown) => {
          logListenerFailure(input, event.kind, error);
        });
      } catch (error) {
        logListenerFailure(input, event.kind, error);
      }
    }
  };

  const on = <K extends ChannelCoreEventKind>(
    kind: K,
    listener: ChannelCoreEventListener<K>,
  ): ChannelCoreEventSubscription => {
    if (!active) {
      throw new Error('channel core event source is no longer active');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('channel core event listener must be a function');
    }
    const registration = {
      kind,
      listener: listener as unknown as ProviderListener,
    };
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
  const source: ChannelCoreEventSource = Object.freeze({ on });
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
  kind: ChannelCoreEventKind,
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
