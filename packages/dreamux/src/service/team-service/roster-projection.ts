import type {
  TeamContainedRole,
  TeamStateTeammateSummary,
  TeammateStatus,
} from '@excitedjs/dreamux-types';

import type {
  AgentEntityIdentity,
  AgentEntityRuntimeStatus,
} from '../agent/identity.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import type { TeamStore } from '../team-collection/store.js';
import type { TeamRecord } from '../team-collection/types.js';

/**
 * One Team's contained Agents, as the aggregate event reports them.
 *
 * A runtime projection and nothing else: it is seeded when the Team
 * materializes and kept current by the same persistence hook that publishes
 * `teammate.state`, so it never disagrees with the identity stores that own the
 * fact. Nothing reads it back into a decision, and it is never persisted — role
 * in particular is derived from which owner holds the Agent, which is exactly
 * what this map records.
 */
export class TeamRosterProjection {
  private readonly members = new Map<string, TeamStateTeammateSummary>();

  constructor(
    private readonly deps: {
      teamId: string;
      store: TeamStore;
      coreEvents: DispatcherCoreEventPublisher;
      /**
       * The Team record this projection is published against. `publish`
       * below is only ever reached from an identity's `onPersisted` hook,
       * which fires no earlier than the Team's own record has already been
       * published or loaded (`TeamService` wires this accessor only after
       * that point) — so this never runs before there is a record to read.
       */
      record: () => TeamRecord;
    },
  ) {}

  /**
   * Publish one contained Agent's state on the Team's behalf, and republish the
   * Team aggregate that contains it.
   *
   * The role is the owner's, not the record's: this Team's leader is
   * `team_leader` and everything in its TeammateCollection is `teammate`. A
   * Dispatcher and its own TeamMates are published by the dispatcher that owns
   * them, under the roles only it can state.
   */
  publish(identity: AgentEntityIdentity, role: TeamContainedRole): void {
    this.remember(identity.name, role, identity.status);
    this.deps.coreEvents.publish(identity.dispatcher_id, {
      schemaVersion: 1,
      kind: 'teammate.state',
      occurredAt: identity.updated_at,
      teammateName: identity.name,
      role,
      teamName: this.deps.teamId,
      status: identity.status,
    });
    // The aggregate is redundant with the event above by design, so it is
    // republished from the roster this call just updated rather than being
    // recomputed from any second source — and timed by the identity
    // transition that changed it, not by the Team record it still sits on.
    this.deps.store.publishRosterState(
      this.deps.record(),
      identity.updated_at,
      this.summary(),
    );
  }

  /** This Team's contained Agents, as a fresh summary per publication. */
  summary(): readonly TeamStateTeammateSummary[] {
    return [...this.members.values()];
  }

  /**
   * Take this Team's existing Agents into the roster once, at materialization.
   *
   * The leader is passed in because it was already read to decide whether it
   * could be restored; a leader the Team is about to create instead announces
   * itself through the ordinary persistence hook.
   */
  async seed(
    leader: AgentEntityIdentity | null,
    members: () => Promise<readonly AgentEntityRuntimeStatus[]>,
  ): Promise<void> {
    if (leader !== null) {
      this.remember(leader.name, 'team_leader', leader.status);
    }
    for (const member of await members()) {
      this.remember(member.name, 'teammate', member.status);
    }
  }

  private remember(
    name: string,
    role: TeamContainedRole,
    status: TeammateStatus,
  ): void {
    this.members.set(name, { teammateName: name, role, status });
  }
}
