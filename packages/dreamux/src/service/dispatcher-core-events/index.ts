/**
 * The dispatcher's live Core-fact bus.
 *
 * Dispatcher-scoped, in-process distribution only. Authoritative state stays
 * with the Team, identity, and turn owners; this bus retains nothing, replays
 * nothing, and guarantees no eventual delivery. It is the single delivery
 * owner: every published fact is sealed here before any listener sees it, and
 * every per-session source is a lease this bus can revoke.
 */
import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  createScopedChannelEventSource,
  type ScopedChannelEventSourceLease,
} from './scoped-source.js';
import { sealChannelCoreEvent } from './seal.js';

type CoreEventHandler = (event: ChannelCoreEvent) => void;

export interface DispatcherCoreEventPublisher {
  publish(event: ChannelCoreEvent): void;
  hasSources(): boolean;
}

export class DispatcherCoreEventBus {
  readonly publisher: DispatcherCoreEventPublisher;
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
  ) {
    this.publisher = Object.freeze({
      publish: (event: ChannelCoreEvent) => {
        this.publish(event);
      },
      hasSources: () => this.sources.size > 0,
    });
  }

  createSource(channelId: string): ScopedChannelEventSourceLease {
    let handler!: CoreEventHandler;
    const lease = createScopedChannelEventSource({
      dispatcherId: this.opts.dispatcherId,
      channelId,
      log: this.opts.log,
      subscribe: (h) => {
        handler = h;
      },
      unsubscribe: () => {
        this.sources.delete(lease);
      },
    });
    this.sources.set(lease, handler);
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
  private publish(event: ChannelCoreEvent): void {
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
}

export type { ScopedChannelEventSourceLease };
