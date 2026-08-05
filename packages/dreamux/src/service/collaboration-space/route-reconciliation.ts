import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { ChannelRouteOwner, ChannelService } from '../channel-service/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import type {
  AcceptedTeamDissolve,
  AcceptedTeamLogicalClose,
  TeamDissolveInput,
  TeamLeaderLease,
} from '../team-collection/types.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { CollaborationSpaceStore } from './store.js';
import {
  ownerForTarget,
  routeClaimIdForTarget,
  targetFromRecord,
} from './target.js';
import { parseMessage, routeKey, targetRouteKey } from './support.js';
import type { ProvisionedTargetRecord } from './types.js';

type ResolvedChannelRoute = Awaited<
  ReturnType<ChannelService['resolveInboundBinding']>
>;

interface CollaborationRouteReconcilerOptions {
  dispatcherId: string;
  teams: TeamCollection;
  channels: ChannelService;
  store: CollaborationSpaceStore;
  locks: KeyedAsyncQueue;
  isShuttingDown: () => boolean;
}

/**
 * Reconciles durable collaboration provisioning intent with the authoritative
 * channel route and Team readiness facts. Explicit transfer-back records intent
 * before removing a route; explicit bind commits the replacement route before
 * detaching intent. Both failure orders are recoverable from durable provenance.
 */
export class CollaborationRouteReconciler {
  constructor(private readonly opts: CollaborationRouteReconcilerOptions) {}

  /**
   * Replace a managed route with an explicit Team binding. The authoritative
   * binding commits before collaboration intent is detached: a failed bind
   * leaves the old managed facts intact, while a failed detach is repaired by
   * inbound reconciliation from the explicit route provenance.
   */
  async bindTargetRoute(input: {
    teamId: string;
    channelId: string;
    target: ChannelTarget;
  }) {
    return this.opts.locks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), () => this.opts.teams.withRoutableTeamProjection(input.teamId, async (team) => {
      const binding = await this.opts.channels.bindResolvedTarget({
        team,
        channelId: input.channelId,
        target: input.target,
      });
      const latest = await this.latestTarget(input.channelId, input.target.target_key);
      if (
        latest !== null &&
        latest.lifecycle_status !== 'closed' &&
        latest.lifecycle_status !== 'detached'
      ) {
        await this.saveDetached(latest);
      }
      return binding;
    }));
  }

  /**
   * Publish a descriptor-scoped TeamLeader route without replacing any active
   * owner or consuming collaboration-managed intent.
   */
  async bindLeasedTargetRoute(input: {
    lease: TeamLeaderLease;
    channelId: string;
    target: ChannelTarget;
  }) {
    return this.opts.locks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), () => this.opts.teams.withRoutableTeamLeaderLease(
      input.lease,
      async (team) => {
        const latest = await this.latestTarget(
          input.channelId,
          input.target.target_key,
        );
        if (
          latest !== null &&
          latest.lifecycle_status !== 'closed' &&
          latest.lifecycle_status !== 'detached'
        ) {
          throw new Error(
            `channel target ${JSON.stringify(input.target.target_key)} is managed ` +
              'by an active collaboration route',
          );
        }
        return this.opts.channels.bindResolvedTargetIfAvailableToOwner({
          team,
          channelId: input.channelId,
          target: input.target,
        });
      },
    ));
  }

  async mutateTargetRoute<T>(input: {
    channelId: string;
    target: ChannelTarget;
    expectedOwner?: ChannelRouteOwner;
  }, mutation: () => Promise<T>): Promise<T> {
    return this.opts.locks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), () => this.mutateTargetRouteUnderLock(input, mutation));
  }

  /** Target lock precedes the Team generation lease across scoped mutation. */
  async mutateLeasedTargetRoute<T>(input: {
    lease: TeamLeaderLease;
    channelId: string;
    target: ChannelTarget;
  }, mutation: () => Promise<T>): Promise<T> {
    const expectedOwner: ChannelRouteOwner = {
      kind: 'team',
      teamName: input.lease.teamId,
      leaderName: input.lease.leaderName,
    };
    return this.opts.locks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), () => this.opts.teams.withTeamLeaderLease(input.lease, () =>
      this.mutateTargetRouteUnderLock({
        channelId: input.channelId,
        target: input.target,
        expectedOwner,
      }, mutation),
    ));
  }

  async detachTargetsForOwner(owner: ChannelRouteOwner): Promise<number> {
    return this.detachOwnedTargets(owner, null);
  }

  /** Accept and start the Dispatcher-facing Team dissolve capability. */
  async dissolveTeam(
    input: TeamDissolveInput & { decisionDeadlineAt?: number },
  ): Promise<AcceptedTeamDissolve> {
    const accepted = await this.opts.teams.acceptDissolve({
      ...input,
      requester: { kind: 'dispatcher' },
    });
    this.startTeamDissolve(accepted);
    return accepted;
  }

  async dissolveTeamForLeader(input: {
    lease: TeamLeaderLease;
    note: string;
  }): Promise<AcceptedTeamDissolve> {
    const accepted = await this.opts.teams.acceptDissolve({
      teamId: input.lease.teamId,
      note: input.note,
      requester: {
        kind: 'team_leader',
        leaderName: input.lease.leaderName,
      },
    });
    this.startTeamDissolve(accepted);
    return accepted;
  }

  /** Accept a target-owned join; caller persists the operation id before start. */
  async acceptTargetTeamDissolve(
    record: ProvisionedTargetRecord,
    note: string,
  ): Promise<AcceptedTeamDissolve | null> {
    try {
      return await this.opts.teams.acceptDissolve({
        teamId: record.team_name,
        note,
        requester: {
          kind: 'collaboration_target',
          leaderName: record.leader_name,
          handoffId: requireTargetHandoffId(record),
        },
      });
    } catch (error) {
      if (!(await this.opts.teams.isOpenTeam(record.team_name))) return null;
      throw error;
    }
  }

  startTeamDissolve(accepted: AcceptedTeamDissolve): void {
    this.opts.teams.startAcceptedDissolve(
      accepted,
      (input) => this.closeAcceptedTeam(input),
    );
  }

  async recoverTeamDissolves(): Promise<void> {
    await this.opts.teams.recoverDissolves((input) =>
      this.closeAcceptedTeam(input),
    );
  }

  /** Caller holds the exact target lock while finalizing its close record. */
  async releaseClaimedTargetRoute(record: ProvisionedTargetRecord): Promise<void> {
    await this.releaseClaimedRoute(record, targetFromRecord(record));
  }

  private async closeAcceptedTeam(
    input: AcceptedTeamLogicalClose,
  ) {
    await this.detachOwnedTargets(input.owner, {
      teamId: input.teamId,
      operationId: input.operationId,
    });
    await this.opts.channels.transferAllForOwner(input.owner);
    return this.opts.teams.closeAcceptedResources(input);
  }

  private async detachOwnedTargets(
    owner: ChannelRouteOwner,
    accepted: {
      teamId: string;
      operationId: string;
    } | null,
  ): Promise<number> {
    const targets = await this.opts.store.listTargets(this.opts.dispatcherId);
    let detached = 0;
    for (const target of targets) {
      if (!targetCanBelongToOwner(target, owner)) continue;
      const result = await this.opts.locks.run(targetRouteKey(target), async () => {
        const latest = await this.opts.store.getTarget(this.opts.dispatcherId, {
          channelId: target.channel_id,
          containerKey: target.container_key,
          bindingGeneration: target.binding_generation,
          targetKey: target.target_key,
        });
        if (latest === null || !targetCanBelongToOwner(latest, owner)) return null;
        if (
          accepted !== null &&
          latest.lifecycle_status === 'closing' &&
          latest.team_dissolve_handoff_id !== null &&
          await this.opts.teams.hasAcceptedTargetDissolveHandoff({
            ...accepted,
            handoffId: latest.team_dissolve_handoff_id,
          })
        ) {
          return null;
        }
        const wasDetached = latest.lifecycle_status === 'detached';
        const next = latest.lifecycle_status === 'closed' || wasDetached
          ? latest : await this.saveDetached(latest);
        await this.releaseClaimedRoute(next, targetFromRecord(next));
        return wasDetached ? null : next;
      });
      if (result?.lifecycle_status === 'detached') detached += 1;
    }
    return detached;
  }

  private async mutateTargetRouteUnderLock<T>(input: {
    channelId: string;
    target: ChannelTarget;
    expectedOwner?: ChannelRouteOwner;
  }, mutation: () => Promise<T>): Promise<T> {
    const latest = await this.latestTarget(
      input.channelId,
      input.target.target_key,
    );
    if (
      latest !== null &&
      latest.lifecycle_status !== 'closed' &&
      latest.lifecycle_status !== 'detached' &&
      input.expectedOwner !== undefined &&
      !targetCanBelongToOwner(latest, input.expectedOwner)
    ) {
      return mutation();
    }
    if (
      latest !== null &&
      latest.lifecycle_status !== 'closed' &&
      latest.lifecycle_status !== 'detached'
    ) {
      await this.saveDetached(latest);
    }
    return mutation();
  }

  async releaseInactiveTargetRoute(
    target: ProvisionedTargetRecord,
  ): Promise<void> {
    await this.opts.locks.run(targetRouteKey(target), async () => {
      const current = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: target.channel_id,
        containerKey: target.container_key,
        bindingGeneration: target.binding_generation,
        targetKey: target.target_key,
      });
      if (current === null || current.lifecycle_status === 'active') return;
      await this.releaseClaimedRoute(current, targetFromRecord(current));
    });
  }

  async reconcileInboundTargetRoute(input: {
    channelId: string;
    target: ChannelTarget;
  }): Promise<ProvisionedTargetRecord | null> {
    return this.opts.locks.run(routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    }), async () => {
      const latest = await this.latestTarget(input.channelId, input.target.target_key);
      if (latest === null) return null;
      const currentRoute = await this.opts.channels.resolveInboundBinding({
        channelId: input.channelId,
        target: input.target,
      });
      if (
        latest.lifecycle_status !== 'active' &&
        routeBelongsToTarget(latest, currentRoute)
      ) {
        await this.releaseClaimedRoute(latest, input.target);
        return latest;
      }
      if (latest.lifecycle_status !== 'active') return latest;
      return this.reconcileActiveUnderLock(latest, input.target, currentRoute);
    });
  }

  async reconcileActiveUnderLock(
    record: ProvisionedTargetRecord,
    target: ChannelTarget,
    currentRoute: ResolvedChannelRoute,
  ): Promise<ProvisionedTargetRecord> {
    if (record.leader_name === null) {
      return this.detachAndRelease(
        record,
        target,
        new Error(`collaboration target ${JSON.stringify(record.target_key)} has no TeamLeader`),
      );
    }
    const expectedOwner = ownerForTarget(record);
    if (currentRoute !== null && !routeBelongsToTarget(record, currentRoute)) {
      return this.saveDetached(record);
    }
    if (currentRoute !== null && !sameOwner(currentRoute.owner, expectedOwner)) {
      return this.detachAndRelease(record, target);
    }

    this.assertNotShuttingDown();
    let routeLeaseAcquired = false;
    try {
      return await this.opts.teams.withRoutableTeamProjection(
        record.team_name,
        async (routableTeam) => {
          routeLeaseAcquired = true;
          this.assertNotShuttingDown();
          if (!sameProjectionOwner(routableTeam, expectedOwner)) {
            return this.detachAndRelease(record, target);
          }
          if (currentRoute === null) {
            try {
              await this.opts.channels.claimResolvedTarget({
                team: routableTeam,
                channelId: record.channel_id,
                target,
                claimId: routeClaimIdForTarget(record),
              });
              if (this.opts.isShuttingDown()) {
                await this.releaseClaimedRoute(record, target);
                this.assertNotShuttingDown();
              }
            } catch (err) {
              const latestRoute = await this.opts.channels.resolveInboundBinding({
                channelId: record.channel_id,
                target,
              });
              if (latestRoute !== null && !routeBelongsToTarget(record, latestRoute)) {
                return this.saveDetached(record);
              }
              throw err;
            }
          }
          return record;
        },
      );
    } catch (err) {
      if (!routeLeaseAcquired) {
        return this.detachAndRelease(record, target, err);
      }
      throw err;
    }
  }

  async saveDetached(
    record: ProvisionedTargetRecord,
    error?: unknown,
  ): Promise<ProvisionedTargetRecord> {
    const now = Date.now();
    return this.opts.store.saveTarget({
      ...record,
      lifecycle_status: 'detached',
      last_error: error === undefined ? null : parseMessage(error),
      updated_at: now,
      detached_at: now,
    });
  }

  private async detachAndRelease(
    record: ProvisionedTargetRecord,
    target: ChannelTarget,
    error?: unknown,
  ): Promise<ProvisionedTargetRecord> {
    const detached = await this.saveDetached(record, error);
    await this.releaseClaimedRoute(detached, target);
    return detached;
  }

  private releaseClaimedRoute(
    record: ProvisionedTargetRecord,
    target: ChannelTarget,
  ) {
    return this.opts.channels.releaseResolvedTargetIfClaimed({
      claimId: routeClaimIdForTarget(record),
      channelId: record.channel_id,
      target,
    });
  }

  private latestTarget(
    channelId: string,
    targetKeyValue: string,
  ): Promise<ProvisionedTargetRecord | null> {
    return this.opts.store.findLatestTargetByChannelTarget(
      this.opts.dispatcherId,
      { channelId, targetKey: targetKeyValue },
    );
  }

  private assertNotShuttingDown(): void {
    if (this.opts.isShuttingDown()) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' is shutting down`);
    }
  }
}

function requireTargetHandoffId(target: ProvisionedTargetRecord): string {
  const handoffId = target.team_dissolve_handoff_id;
  if (handoffId === null || handoffId.trim() === '') {
    throw new Error('collaboration target dissolve handoff is unavailable');
  }
  return handoffId;
}

function routeBelongsToTarget(
  target: ProvisionedTargetRecord,
  route: ResolvedChannelRoute,
): boolean {
  return route !== null && route.binding.claim_id === routeClaimIdForTarget(target);
}

function sameOwner(left: ChannelRouteOwner, right: ChannelRouteOwner): boolean {
  return left.teamName === right.teamName && left.leaderName === right.leaderName;
}

function sameProjectionOwner(
  left: {
    team_name: string;
    leader_name: string;
  },
  right: ChannelRouteOwner,
): boolean {
  return left.team_name === right.teamName && left.leader_name === right.leaderName;
}

function targetCanBelongToOwner(
  target: ProvisionedTargetRecord,
  owner: ChannelRouteOwner,
): boolean {
  return target.team_name === owner.teamName &&
    (target.leader_name === null || target.leader_name === owner.leaderName);
}
