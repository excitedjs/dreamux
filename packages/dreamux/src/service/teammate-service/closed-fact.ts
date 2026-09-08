import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type {
  TeammateClosedFact,
  TeammateClosedSubscription,
} from './types.js';

type TeammateClosedListener = (
  fact: TeammateClosedFact,
) => void | Promise<void>;

/** Publish one durable TeamMate close without coupling listeners to lifecycle. */
export class TeammateClosedPublisher {
  private readonly listeners = new Set<TeammateClosedListener>();

  constructor(private readonly log: DreamuxLogger) {}

  subscribe(listener: TeammateClosedListener): TeammateClosedSubscription {
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

  publish(identity: AgentEntityIdentity, closedAt: number): void {
    const fact: TeammateClosedFact = Object.freeze({
      schema_version: 1,
      kind: 'teammate.closed',
      dispatcher_id: identity.dispatcher_id,
      team_id: identity.team_id,
      name: identity.name,
      closed_at: closedAt,
    });
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      for (const listener of listeners) this.deliver(listener, fact);
    });
  }

  private deliver(
    listener: TeammateClosedListener,
    fact: TeammateClosedFact,
  ): void {
    const failed = (error: unknown): void => {
      this.log.warn(
        { teammate: fact.name, error },
        'TeamMate retirement listener failed',
      );
    };
    try {
      void Promise.resolve(listener(fact)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
