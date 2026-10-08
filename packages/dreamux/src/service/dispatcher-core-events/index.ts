/**
 * The dispatcher's live Core-fact bus.
 *
 * Dispatcher-scoped, in-process distribution only. Authoritative state stays
 * with the Team, identity, and turn owners; this bus retains nothing, replays
 * nothing, and guarantees no eventual delivery. It is the single delivery
 * owner: every published fact is sealed here before any listener sees it, and
 * every per-session source is a lease this bus can revoke.
 */
import type {
  ChannelCoreEvent,
  ChannelEventSource,
  ChannelEventSubscription,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { sealChannelCoreEvent } from './seal.js';

type CoreEventHandler = (event: ChannelCoreEvent) => void;
type ChannelEventListener = (event: ChannelCoreEvent) => void | Promise<void>;

export interface DispatcherCoreEventPublisher {
  publish(event: ChannelCoreEvent): void;
  hasSources(): boolean;
}

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
export interface ScopedChannelEventSourceLease {
  readonly source: ChannelEventSource;
  revoke(): void;
}

export class DispatcherCoreEventBus implements DispatcherCoreEventPublisher {
  // The bus's whole subscriber registry: every live Channel session's
  // dispatch handler, keyed by the lease `revoke()` removes it through.
  private readonly sources = new Map<
    ScopedChannelEventSourceLease,
    CoreEventHandler
  >();

  constructor(
    private readonly opts: {
      dispatcherId: string;
      log: DreamuxLogger;
    },
  ) {}

  hasSources(): boolean {
    return this.sources.size > 0;
  }

  createSource(channelId: string): ScopedChannelEventSourceLease {
    // A registration wrapper rather than the function itself, so subscribing
    // the same listener twice yields two independent subscriptions and
    // unsubscribing one leaves the other delivering.
    const listeners = new Set<{ listener: ChannelEventListener }>();
    let active = true;

    const dispatch: CoreEventHandler = (event) => {
      for (const registration of [...listeners]) {
        try {
          void Promise.resolve(registration.listener(event)).catch(
            (error: unknown) => {
              this.logListenerFailure(channelId, event.kind, error);
            },
          );
        } catch (error) {
          this.logListenerFailure(channelId, event.kind, error);
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

    const source: ChannelEventSource = Object.freeze({ subscribe });
    const lease: ScopedChannelEventSourceLease = {
      source,
      revoke: (): void => {
        if (!active) return;
        active = false;
        this.sources.delete(lease);
        listeners.clear();
      },
    };
    this.sources.set(lease, dispatch);
    return lease;
  }

  revokeSources(): void {
    for (const lease of this.sources.keys()) lease.revoke();
    this.sources.clear();
  }

  /**
   * Publishing never fails a producer.
   *
   * Every caller is inside a Core operation whose durable work has already
   * succeeded, so a listener defect is logged and dropped, per listener,
   * rather than raised into that operation or allowed to stop delivery to
   * the sessions after it.
   */
  publish(event: ChannelCoreEvent): void {
    const sealed = sealChannelCoreEvent(event);
    for (const handler of this.sources.values()) {
      try {
        handler(sealed);
      } catch (error) {
        this.opts.log.warn(
          {
            dispatcher_id: this.opts.dispatcherId,
            event_kind: event.kind,
            error: error instanceof Error ? error.message : String(error),
          },
          'dispatcher core event delivery failed',
        );
      }
    }
  }

  private logListenerFailure(
    channelId: string,
    kind: ChannelCoreEvent['kind'],
    error: unknown,
  ): void {
    this.opts.log.warn(
      {
        dispatcher_id: this.opts.dispatcherId,
        channel_id: channelId,
        event_kind: kind,
        error: error instanceof Error ? error.message : String(error),
      },
      'channel core event listener failed',
    );
  }
}
