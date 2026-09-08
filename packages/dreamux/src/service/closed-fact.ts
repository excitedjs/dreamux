import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { errorInfo } from '../platform/error-info.js';

export type ClosedListener<Fact> = (fact: Fact) => void | Promise<void>;

export interface ClosedSubscription {
  unsubscribe(): void;
}

/**
 * Who to tell that one entity is durably over, and the telling itself.
 *
 * Separate from the entity because the entity is the fact's source, not its
 * transport: a Team and a TeamMate each build their own closed fact and hand
 * it here. The record is already durable by the time anything here runs, so a
 * listener can neither fail the operation that closed it nor take it back —
 * which is why every delivery is queued to a microtask, and every failure is
 * only logged and never hides the fact from the other listeners.
 */
export class ClosedFactPublisher<Fact extends object> {
  private readonly listeners = new Set<ClosedListener<Fact>>();

  constructor(private readonly log: DreamuxLogger) {}

  subscribe(listener: ClosedListener<Fact>): ClosedSubscription {
    this.listeners.add(listener);
    let subscribed = true;
    return {
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.listeners.delete(listener);
      },
    };
  }

  publish(fact: Fact): void {
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      for (const listener of listeners) this.deliver(listener, fact);
    });
  }

  private deliver(listener: ClosedListener<Fact>, fact: Fact): void {
    const failed = (error: unknown): void => {
      this.log.warn({ closed: fact, err: errorInfo(error) }, 'closed listener failed');
    };
    try {
      void Promise.resolve(listener(fact)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
