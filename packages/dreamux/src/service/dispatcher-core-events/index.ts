/**
 * The dispatcher's live Core-fact bus.
 *
 * Dispatcher-scoped, in-process distribution only. Authoritative state stays
 * with the Team, identity, and turn owners; this bus retains nothing, replays
 * nothing, and guarantees no eventual delivery. It is the single delivery
 * owner: every published fact is sealed here before any listener sees it, and
 * every per-session source is a lease this bus can revoke.
 */
import { EventEmitter } from 'node:events';

import type {
  ChannelCoreEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  createScopedChannelEventSource,
  type ScopedChannelEventSourceLease,
} from './scoped-source.js';
import { sealChannelCoreEvent } from './seal.js';

const CORE_EVENT = Symbol('dispatcher-core-event');

export interface DispatcherCoreEventPublisher {
  publish(dispatcherId: string, event: ChannelCoreEvent): void;
  hasSources?(): boolean;
}

export class DispatcherCoreEventBus extends EventEmitter {
  readonly publisher: DispatcherCoreEventPublisher;
  private readonly sources = new Set<ScopedChannelEventSourceLease>();

  constructor(private readonly opts: {
    dispatcherId: string;
    log: DreamuxLogger;
    maxSources: number;
  }) {
    super();
    if (opts.maxSources > this.getMaxListeners()) {
      this.setMaxListeners(opts.maxSources);
    }
    this.publisher = Object.freeze({
      publish: (dispatcherId: string, event: ChannelCoreEvent) => {
        this.publish(dispatcherId, event);
      },
      hasSources: () => this.sources.size > 0,
    });
  }

  createSource(channelId: string): ScopedChannelEventSourceLease {
    const source = createScopedChannelEventSource({
      dispatcherId: this.opts.dispatcherId,
      channelId,
      log: this.opts.log,
      subscribe: (handler) => {
        this.on(CORE_EVENT, handler);
      },
      unsubscribe: (handler) => {
        this.off(CORE_EVENT, handler);
      },
    });
    this.sources.add(source);
    return {
      source: source.source,
      revoke: () => {
        source.revoke();
        this.sources.delete(source);
      },
    };
  }

  revokeSources(): void {
    for (const source of this.sources) source.revoke();
    this.sources.clear();
  }

  /**
   * Publishing never fails a producer.
   *
   * Every caller is inside a Core operation whose durable work has already
   * succeeded, so a scope mismatch, a rejected envelope, and a listener defect
   * are all logged and dropped rather than raised into that operation.
   */
  private publish(dispatcherId: string, event: ChannelCoreEvent): void {
    try {
      if (dispatcherId !== this.opts.dispatcherId) {
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            source_dispatcher_id: dispatcherId,
            event_kind: event?.kind,
          },
          'dispatcher core event scope mismatch',
        );
        return;
      }
      const sealed = sealChannelCoreEvent(event);
      if (sealed === null) {
        this.opts.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            event_kind: event?.kind,
          },
          'dispatcher core event is not a publishable catalog event',
        );
        return;
      }
      this.emit(CORE_EVENT, sealed);
    } catch (error) {
      this.opts.log.warn(
        {
          dispatcher_id: this.opts.dispatcherId,
          event_kind: event?.kind,
          error: error instanceof Error ? error.message : String(error),
        },
        'dispatcher core event delivery failed',
      );
    }
  }
}

export type { ScopedChannelEventSourceLease };
