import { EventEmitter } from 'node:events';

import type {
  ChannelCoreEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  createScopedChannelCoreEventSource,
  type ScopedChannelCoreEventSourceLease,
} from './scoped-source.js';

const CORE_EVENT = Symbol('dispatcher-core-event');

export interface DispatcherCoreEventPublisher {
  publish(dispatcherId: string, event: ChannelCoreEvent): void;
  hasSources?(): boolean;
}

/**
 * Dispatcher-scoped, in-process fact distribution only. Authoritative state
 * remains in the existing Team, identity, and turn owners; this bus retains no
 * events and offers no eventual-delivery guarantee.
 */
export class DispatcherCoreEventBus extends EventEmitter {
  readonly publisher: DispatcherCoreEventPublisher;
  private readonly sources = new Set<ScopedChannelCoreEventSourceLease>();

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

  createSource(channelId: string): ScopedChannelCoreEventSourceLease {
    const source = createScopedChannelCoreEventSource({
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

  private publish(dispatcherId: string, event: ChannelCoreEvent): void {
    if (dispatcherId !== this.opts.dispatcherId) {
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          source_dispatcher_id: dispatcherId,
          event_kind: event.kind,
        },
        'dispatcher core event scope mismatch',
      );
      return;
    }
    try {
      this.emit(CORE_EVENT, Object.freeze(event));
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

export type { ScopedChannelCoreEventSourceLease };
