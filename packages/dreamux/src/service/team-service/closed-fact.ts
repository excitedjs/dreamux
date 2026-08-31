import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { teamErrorInfo } from '../team-collection/errors.js';
import type { TeamRecord } from '../team-collection/types.js';
import type { TeamClosedFact, TeamClosedSubscription } from './types.js';

export type TeamClosedListener = (fact: TeamClosedFact) => void | Promise<void>;

/**
 * Who to tell that one Team is over, and the telling itself.
 *
 * Separate from the Team because the Team is the fact's source, not its
 * transport. The record is already durable by the time anything here runs, so a
 * listener can neither fail the operation that closed it nor take it back —
 * which is why every delivery is queued and every failure is only logged.
 */
export class TeamClosedPublisher {
  private readonly listeners = new Set<TeamClosedListener>();

  constructor(private readonly log: DreamuxLogger) {}

  subscribe(listener: TeamClosedListener): TeamClosedSubscription {
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

  publish(record: TeamRecord): void {
    const fact: TeamClosedFact = Object.freeze({
      schema_version: 1,
      kind: 'team.closed',
      dispatcher_id: record.dispatcher_id,
      team_id: record.team_id,
      closed_at: record.closed_at ?? Date.now(),
    });
    const listeners = [...this.listeners];
    queueMicrotask(() => {
      for (const listener of listeners) this.deliver(listener, fact);
    });
  }

  private deliver(listener: TeamClosedListener, fact: TeamClosedFact): void {
    const failed = (error: unknown): void => {
      this.log.warn(
        { team_id: fact.team_id, err: teamErrorInfo(error) },
        'Team closed listener failed',
      );
    };
    try {
      void Promise.resolve(listener(fact)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
