import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { ChannelRouteOwner, ChannelService } from '../channel-service/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import type {
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
      const binding = await this.opts.channels.bindResolvedTargetWithTransition({
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
    }), () => this.opts.teams.withRoutableTeamLeaderProjectionLease(
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
        return this.opts.channels.bindResolvedTargetIfAvailableToOwnerWithTransition({
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
    }), async () => {
      const latest = await this.latestTarget(input.channelId, input.target.target_key);
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
    });
  }

  async detachTargetsForOwner(owner: ChannelRouteOwner): Promise<number> {
    return this.detachTargetsForOwnerExcept(owner, null);
  }

  /** Close a Team only after every collaboration intent and channel route is released. */
  async dissolveTeam(
    input: TeamDissolveInput,
    lockedTarget: ProvisionedTargetRecord | null = null,
  ) {
    return this.opts.teams.withTeamRouteClosing(input.teamId, async (owner) => {
      await this.detachTargetsForOwnerExcept(owner, lockedTarget);
      await this.opts.channels.transferAllForOwner(owner);
      return (await this.opts.teams.get(input.teamId)).dissolve(input);
    });
  }

  /**
   * Target lifecycle callers already hold this target's route lock. Skip that
   * one during the all-owner detach sweep, but close every other route before
   * dissolving the Team. A previously closed Team still gets route cleanup.
   */
  async closeTargetTeam(
    record: ProvisionedTargetRecord,
    note: string,
  ): Promise<void> {
    if (await this.opts.teams.isOpenTeam(record.team_name)) {
      await this.dissolveTeam({ teamId: record.team_name, note }, record);
      return;
    }
    if (record.leader_name === null) {
      await this.releaseClaimedRoute(record, targetFromRecord(record));
      return;
    }
    const owner = ownerForTarget(record);
    await this.detachTargetsForOwnerExcept(owner, record);
    await this.opts.channels.transferAllForOwner(owner);
  }

  private async detachTargetsForOwnerExcept(
    owner: ChannelRouteOwner,
    lockedTarget: ProvisionedTargetRecord | null,
  ): Promise<number> {
    const targets = await this.opts.store.listTargets(this.opts.dispatcherId);
    let detached = 0;
    for (const target of targets) {
      if (!targetCanBelongToOwner(target, owner)) continue;
      if (
        lockedTarget !== null &&
        targetRouteKey(target) === targetRouteKey(lockedTarget)
      ) {
        continue;
      }
      const wasDetached = target.lifecycle_status === 'detached';
      const result = await this.opts.locks.run(targetRouteKey(target), async () => {
        const latest = await this.latestTarget(target.channel_id, target.target_key);
        if (latest === null || !targetCanBelongToOwner(latest, owner)) return null;
        const next = latest.lifecycle_status === 'closed' ||
          latest.lifecycle_status === 'detached'
          ? latest
          : await this.saveDetached(latest);
        await this.releaseClaimedRoute(next, targetFromRecord(next));
        return next;
      });
      if (!wasDetached && result?.lifecycle_status === 'detached') detached += 1;
    }
    return detached;
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
              await this.opts.channels.claimResolvedTargetWithTransition({
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
