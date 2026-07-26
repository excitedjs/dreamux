import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type { DreamuxConfig } from '../../config/config.js';
import type { ChannelService } from '../channel-service/index.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { TeamCollection } from '../team-collection/index.js';
import { createDefaultBoundSpace } from './default-binding.js';
import { detachActiveTargets } from './detach-active-targets.js';
import { publishCollaborationSpaceBindTransition } from '../binding-events.js';
import { collaborationTeamNamePrefix, targetIntent } from './naming.js';
import type { CollaborationSpaceStore } from './store.js';
import type { CollaborationRouteReconciler } from './route-reconciliation.js';
import {
  containerFromSpace,
  parseMessage,
  requiredBinding,
  routeKey,
  spaceKey,
  targetRouteKey,
} from './support.js';
import {
  collaborationTargetFailure,
  type CollaborationTargetStrictOperations,
} from './strict-operations.js';
import { createTargetClaim, routeClaimIdForTarget, targetFromRecord } from './target.js';
import type {
  AcceptedTargetClose, AcceptedTargetProvision, AcceptTargetCreatedOptions,
  CollaborationSpaceCloseTargetInput, CollaborationSpaceDefaultBindingInput,
  CollaborationSpaceProvisionInput, CollaborationSpaceRecord,
  ProvisionedTargetRecord, ProvisionedTargetView,
} from './types.js';
import { targetView } from './view.js';

export interface CollaborationTargetLifecycleOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  teams: TeamCollection;
  channels: ChannelService;
  store: CollaborationSpaceStore;
  coreEvents?: import('../dispatcher-core-events/index.js').DispatcherCoreEventPublisher;
  spaceLocks: KeyedAsyncQueue;
  targetLocks: KeyedAsyncQueue;
  routes: CollaborationRouteReconciler;
  strictOperations: CollaborationTargetStrictOperations;
  log: DreamuxLogger;
  isShuttingDown: () => boolean;
}
interface AcceptedTargetCreated { space: CollaborationSpaceRecord; }

export class CollaborationTargetLifecycle {
  constructor(private readonly opts: CollaborationTargetLifecycleOptions) {}

  async detachActiveTargets(space: CollaborationSpaceRecord): Promise<{
    detached_targets: number;
    released_bindings: number;
  }> {
    return detachActiveTargets({
      dispatcherId: this.opts.dispatcherId,
      channels: this.opts.channels,
      store: this.opts.store,
      targetLocks: this.opts.targetLocks,
      routes: this.opts.routes,
      space,
    });
  }

  async provisionTarget(
    input: CollaborationSpaceProvisionInput,
  ): Promise<ProvisionedTargetRecord | null> {
    return this.opts.spaceLocks.run(spaceKey(input), async () => {
      this.assertNotShuttingDown();
      if (!input.target.bindable) {
        throw new Error(
          `collaboration-space target ${JSON.stringify(input.target.target_key)} is not bindable`,
        );
      }
      const space = await this.opts.store.findSpaceByContainer({
        dispatcherId: this.opts.dispatcherId,
        channelId: input.channelId,
        containerKey: input.container.container_key,
      });
      if (space === null || space.current_binding === null || space.status !== 'bound') {
        return null;
      }
      return this.provisionTargetForSpace(space, input);
    });
  }

  async acceptAndProvisionTarget(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<ProvisionedTargetRecord | null> {
    const accepted = await this.acceptTargetCreatedContext(input, {
      ...options,
      allowMissing: options.allowMissing ?? true,
    });
    return accepted === null
      ? null
      : this.provisionTargetForSpace(accepted.space, input, options.strict === true);
  }

  async acceptTargetCreated(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<boolean> {
    return (await this.acceptTargetCreatedContext(input, options)) !== null;
  }

  async acceptTargetCreatedForProvision(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<AcceptedTargetProvision | null> {
    const accepted = await this.acceptTargetCreatedContext(input, options);
    return accepted === null
      ? null
      : { provision: () => this.provisionTargetForSpace(accepted.space, input) };
  }

  async closeTarget(input: CollaborationSpaceCloseTargetInput): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null) return { closed: false, target: null };
    const generation = space.current_binding?.generation ?? space.last_binding_generation;
    const key = routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    });
    return this.opts.targetLocks.run(key, async () => {
      const record = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: generation,
        targetKey: input.target.target_key,
      });
      return this.closeTargetUnderLock(record, input.eventId);
    });
  }

  async acceptTargetClosed(input: CollaborationSpaceCloseTargetInput): Promise<boolean> {
    return (await this.acceptTargetClosedForClose(input)) !== null;
  }

  async acceptTargetClosedForClose(
    input: CollaborationSpaceCloseTargetInput,
  ): Promise<AcceptedTargetClose | null> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null) return null;
    const generation = space.current_binding?.generation ?? space.last_binding_generation;
    const key = routeKey({
      channelId: input.channelId,
      targetKey: input.target.target_key,
    });
    return this.opts.targetLocks.run(key, async () => {
      const record = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: generation,
        targetKey: input.target.target_key,
      });
      if (
        record === null ||
        record.lifecycle_status === 'closed' ||
        record.lifecycle_status === 'detached'
      ) {
        return null;
      }
      const closing = await this.opts.store.saveTarget({
        ...record,
        lifecycle_status: 'closing',
        close_event_id: input.eventId ?? record.close_event_id,
        updated_at: Date.now(),
      });
      return { close: () => this.closeTargetRecord(closing) };
    });
  }

  async provisionClaimedTarget(input: {
    channelId: string;
    provider: string;
    target: CollaborationSpaceProvisionInput['target'];
  }): Promise<ProvisionedTargetRecord | null> {
    const record = await this.opts.store.findOpenTargetByChannelTarget(
      this.opts.dispatcherId,
      {
        channelId: input.channelId,
        targetKey: input.target.target_key,
      },
    );
    if (record === null) return null;
    const resumed = await this.resumeTargetRecord(record, input.provider);
    return resumed?.lifecycle_status === 'detached' ? null : resumed;
  }

  async resumePendingTargets(): Promise<void> {
    const targets = await this.opts.store.listTargets(this.opts.dispatcherId);
    for (const target of targets) {
      if (
        target.lifecycle_status === 'detached' ||
        target.lifecycle_status === 'closed'
      ) {
        try {
          await this.opts.routes.releaseInactiveTargetRoute(target);
        } catch (err) {
          this.logResumeFailure(target, err);
        }
        continue;
      }
      if (
        target.lifecycle_status !== 'creating' &&
        target.lifecycle_status !== 'failed' &&
        target.lifecycle_status !== 'closing'
      ) {
        continue;
      }
      try {
        await this.resumeTargetRecord(target, target.provider);
      } catch (err) {
        this.logResumeFailure(target, err);
      }
    }
  }

  private async provisionTargetForSpace(
    space: CollaborationSpaceRecord,
    input: CollaborationSpaceProvisionInput,
    strict = false,
  ): Promise<ProvisionedTargetRecord> {
    return this.opts.targetLocks.run(
      routeKey({
        channelId: input.channelId,
        targetKey: input.target.target_key,
      }),
      () => this.provisionUnderLock(space, input, strict),
    );
  }

  private async acceptTargetCreatedContext(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions,
  ): Promise<AcceptedTargetCreated | null> {
    return this.opts.spaceLocks.run(spaceKey(input), async () => {
      this.assertNotShuttingDown();
      if (!input.target.bindable) {
        throw new Error(
          `collaboration-space target ${JSON.stringify(input.target.target_key)} is not bindable`,
        );
      }
      const space = await this.boundSpaceForTarget(input, options.defaultBinding);
      if (space === null) {
        if (options.allowMissing === true) return null;
        throw collaborationTargetFailure(
          options.strict === true,
          'collaboration_space_unavailable',
          `collaboration space for channel container ` +
            `${JSON.stringify(input.container.container_key)} is not bound`,
        );
      }
      const binding = requiredBinding(space);
      await this.opts.targetLocks.run(
        routeKey({
          channelId: input.channelId,
          targetKey: input.target.target_key,
        }),
        async () => {
          if (options.strict === true) {
            await this.opts.strictOperations.assertTargetIdentity(
              input,
              binding.generation,
            );
          }
          const key = {
            channelId: input.channelId,
            containerKey: input.container.container_key,
            bindingGeneration: binding.generation,
            targetKey: input.target.target_key,
          };
          const existing = await this.opts.store.getTarget(this.opts.dispatcherId, key);
          if (existing === null) {
            await createTargetClaim(
              this.opts.dispatcherId,
              space,
              input,
              this.opts.teams,
              this.opts.store,
            );
            return;
          }
          if (existing.lifecycle_status === 'closed') {
            throw collaborationTargetFailure(
              options.strict === true,
              'target_closed',
              `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
            );
          }
          if (existing.lifecycle_status === 'closing') {
            throw collaborationTargetFailure(
              options.strict === true,
              'target_closing',
              `collaboration target ${JSON.stringify(input.target.target_key)} is closing and cannot be provisioned`,
            );
          }
        },
      );
      return { space };
    });
  }

  private async boundSpaceForTarget(
    input: CollaborationSpaceProvisionInput,
    defaultBinding: CollaborationSpaceDefaultBindingInput | undefined,
  ): Promise<CollaborationSpaceRecord | null> {
    const existing = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (existing !== null) {
      return existing.current_binding !== null && existing.status === 'bound'
        ? existing
        : null;
    }
    if (defaultBinding === undefined) return null;
    const transition = await createDefaultBoundSpace({
      dispatcherId: this.opts.dispatcherId,
      config: this.opts.config,
      store: this.opts.store,
      provision: input,
      binding: defaultBinding,
    });
    publishCollaborationSpaceBindTransition({
      coreEvents: this.opts.coreEvents,
      dispatcherId: this.opts.dispatcherId,
      transition,
    });
    return transition.space;
  }

  private async provisionUnderLock(
    space: CollaborationSpaceRecord,
    input: CollaborationSpaceProvisionInput,
    strict = false,
  ): Promise<ProvisionedTargetRecord> {
    this.assertNotShuttingDown();
    const binding = requiredBinding(space);
    const key = {
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: binding.generation,
      targetKey: input.target.target_key,
    };
    const existing = await this.opts.store.getTarget(this.opts.dispatcherId, key);
    if (existing !== null) {
      if (existing.lifecycle_status === 'closed') {
        throw collaborationTargetFailure(
          strict,
          'target_closed',
          `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
        );
      }
      if (existing.lifecycle_status === 'closing') {
        throw collaborationTargetFailure(
          strict,
          'target_closing',
          `collaboration target ${JSON.stringify(input.target.target_key)} is closing and cannot be provisioned`,
        );
      }
      if (existing.lifecycle_status === 'detached') return existing;
    }
    let record = existing ?? await createTargetClaim(
      this.opts.dispatcherId,
      space,
      input,
      this.opts.teams,
      this.opts.store,
    );
    const target = existing === null ? input.target : targetFromRecord(record);
    const teamIsOpen = await this.opts.teams.isOpenTeam(record.team_name);
    const needsTeamRecreation =
      record.lifecycle_status !== 'active' &&
      !teamIsOpen &&
      (await this.opts.teams.hasTeam(record.team_name));
    if (needsTeamRecreation) {
      // A Team checkpoint is usable only while its Team remains open. Concrete
      // Team names are never reused, so recovery reserves a fresh generation.
      const nameClaim = await this.opts.teams.claimName(
        collaborationTeamNamePrefix(record.target_display), routeClaimIdForTarget(record),
      );
      record = await this.opts.store.saveTarget({
        ...record,
        team_name: nameClaim.name,
        leader_name: null,
        worktree_slug: nameClaim.name,
        phase: 'claimed',
        updated_at: Date.now(),
      });
    }
    let createdTeamHere = false;
    try {
      const routed = await this.opts.channels.resolveInboundBinding({
        channelId: input.channelId,
        target,
      });
      if (record.lifecycle_status === 'active') {
        return this.opts.routes.reconcileActiveUnderLock(
          record,
          target,
          routed,
        );
      }
      if (
        routed !== null &&
        (routed.owner.teamName !== record.team_name ||
          routed.owner.leaderName !== record.leader_name)
      ) {
        throw collaborationTargetFailure(
          strict,
          'target_conflict',
          `channel target ${JSON.stringify(input.target.target_key)} is already bound to Team ` +
            `${JSON.stringify(routed.owner.teamName)}`,
        );
      }
      if (record.phase === 'claimed') {
        if (!(await this.opts.teams.isOpenTeam(record.team_name))) {
          this.assertNotShuttingDown();
          const repo = input.repo !== undefined
            ? { ...input.repo, cleanup: 'delete-on-close' as const }
            : binding.repo_cwd !== null && binding.worktree.mode === 'managed'
              ? { path: binding.repo_cwd, ...binding.worktree } : null;
          await this.opts.teams.create({
            name: record.team_name,
            nameClaimToken: routeClaimIdForTarget(record),
            leaderAgentRuntime: binding.leader_agent_runtime,
            intent: targetIntent(target, record),
            ...(binding.identity !== null ? { identity: binding.identity } : {}),
            ...(repo !== null
              ? {
                  repoCwd: repo.path, worktree: {
                    mode: 'managed' as const, slug: record.worktree_slug,
                    branch: record.team_name,
                    ...(repo.base_ref !== null ? { base_ref: repo.base_ref } : {}),
                    cleanup: repo.cleanup,
                  },
                }
              : {}),
          });
          createdTeamHere = true;
        }
      }
      this.assertNotShuttingDown();
      return await this.opts.teams.withRoutableTeamProjection(
        record.team_name,
        async (team) => {
          this.assertNotShuttingDown();
          if (record.phase === 'claimed') {
            record = await this.opts.store.saveTarget({
              ...record,
              leader_name: team.leader_name,
              phase: 'team_created',
              updated_at: Date.now(),
            });
            this.assertNotShuttingDown();
          }
          const latestBinding = await this.opts.channels.resolveInboundBinding({
            channelId: input.channelId,
            target,
          });
          if (
            latestBinding !== null &&
            (latestBinding.owner.teamName !== team.team_name ||
              latestBinding.owner.leaderName !== team.leader_name)
          ) {
            throw collaborationTargetFailure(
              strict,
              'target_conflict',
              `channel target ${JSON.stringify(input.target.target_key)} is already bound to Team ` +
                `${JSON.stringify(latestBinding.owner.teamName)}`,
            );
          }
          await this.opts.channels.claimResolvedTarget({
            team,
            channelId: input.channelId,
            target,
            claimId: routeClaimIdForTarget(record),
          });
          if (this.opts.isShuttingDown()) {
            await this.opts.channels.releaseResolvedTargetIfClaimed({
              claimId: routeClaimIdForTarget(record),
              channelId: input.channelId,
              target,
            });
            this.assertNotShuttingDown();
          }
          const active = await this.opts.store.saveTarget({
            ...record,
            leader_name: team.leader_name,
            phase: 'bound',
            lifecycle_status: 'active',
            last_error: null,
            updated_at: Date.now(),
          });
          if (this.opts.isShuttingDown()) {
            await this.opts.channels.releaseResolvedTargetIfClaimed({
              claimId: routeClaimIdForTarget(active),
              channelId: input.channelId,
              target,
            });
            this.assertNotShuttingDown();
          }
          return active;
        },
      );
    } catch (err) {
      let compensatedNewTeam = false;
      if (createdTeamHere && this.opts.isShuttingDown()) {
        try {
          await this.opts.routes.closeTargetTeam(
            record,
            'Collaboration provisioning aborted during dispatcher shutdown',
          );
          compensatedNewTeam = true;
        } catch (cleanupError) {
          this.opts.log.error(
            {
              dispatcher_id: this.opts.dispatcherId,
              team_name: record.team_name,
              err: { message: parseMessage(cleanupError) },
            },
            'collaboration Team shutdown compensation failed',
          );
        }
      }
      const failed = await this.opts.store.saveTarget({
        ...record,
        ...(compensatedNewTeam ? { leader_name: null, phase: 'claimed' as const } : {}),
        lifecycle_status: 'failed',
        last_error: parseMessage(err),
        updated_at: Date.now(),
      });
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          space_name: failed.space_name,
          target_key: failed.target_key,
          err: { message: parseMessage(err) },
        },
        'collaboration target provisioning failed',
      );
      throw err;
    }
  }

  private async resumeTargetRecord(
    target: ProvisionedTargetRecord,
    provider: string,
  ): Promise<ProvisionedTargetRecord | null> {
    return this.opts.targetLocks.run(targetRouteKey(target), async () => {
      const latest = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: target.channel_id,
        containerKey: target.container_key,
        bindingGeneration: target.binding_generation,
        targetKey: target.target_key,
      });
      if (latest === null) return null;
      if (
        latest.lifecycle_status === 'closed' ||
        latest.lifecycle_status === 'detached'
      ) {
        return null;
      }
      const space = await this.opts.store.getSpace(
        this.opts.dispatcherId,
        latest.space_name,
      );
      if (space === null) {
        throw new Error(
          `collaboration space ${JSON.stringify(latest.space_name)} does not exist`,
        );
      }
      if (latest.lifecycle_status === 'closing') {
        const result = await this.closeTargetUnderLock(
          latest,
          latest.close_event_id ?? undefined,
        );
        if (!result.closed) return latest;
        return this.opts.store.getTarget(this.opts.dispatcherId, {
          channelId: latest.channel_id,
          containerKey: latest.container_key,
          bindingGeneration: latest.binding_generation,
          targetKey: latest.target_key,
        });
      }
      if (
        space.current_binding === null ||
        space.status !== 'bound' ||
        space.current_binding.generation !== latest.binding_generation
      ) {
        return this.opts.routes.saveDetached(latest);
      }
      return this.provisionUnderLock(space, {
        channelId: latest.channel_id,
        provider,
        container: containerFromSpace(space),
        target: targetFromRecord(latest),
        ...(latest.claim_event_id !== null ? { eventId: latest.claim_event_id } : {}),
      }, false);
    });
  }

  private async closeTargetUnderLock(
    record: ProvisionedTargetRecord | null,
    eventId: string | undefined,
  ): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    if (record === null || record.lifecycle_status === 'detached') {
      return { closed: false, target: record === null ? null : targetView(record) };
    }
    if (record.lifecycle_status === 'closed') {
      return { closed: false, target: targetView(record) };
    }
    const closing = await this.opts.store.saveTarget({
      ...record,
      lifecycle_status: 'closing',
      close_event_id: eventId ?? record.close_event_id,
      updated_at: Date.now(),
    });
    try {
      await this.opts.routes.closeTargetTeam(
        closing,
        `Collaboration target ${closing.target_key} closed.`,
      );
    } catch (err) {
      const msg = parseMessage(err);
      await this.opts.store.saveTarget({
        ...closing,
        last_error: msg,
        updated_at: Date.now(),
      });
      this.opts.log.error(
        {
          dispatcher_id: this.opts.dispatcherId,
          space_name: closing.space_name,
          target_key: closing.target_key,
          err: { message: msg },
        },
        'collaboration target close failed (target remains in closing state for retry)',
      );
      throw err;
    }
    const closed = await this.opts.store.saveTarget({
      ...closing,
      lifecycle_status: 'closed',
      phase: 'closed',
      updated_at: Date.now(),
      closed_at: Date.now(),
    });
    return { closed: true, target: targetView(closed) };
  }

  private async closeTargetRecord(
    record: ProvisionedTargetRecord,
  ): Promise<{ closed: boolean; target: ProvisionedTargetView | null }> {
    return this.opts.targetLocks.run(targetRouteKey(record), async () =>
      this.closeTargetUnderLock(await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: record.channel_id,
        containerKey: record.container_key,
        bindingGeneration: record.binding_generation,
        targetKey: record.target_key,
      }), record.close_event_id ?? undefined));
  }

  private assertNotShuttingDown(): void {
    if (this.opts.isShuttingDown()) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' is shutting down`);
    }
  }

  private logResumeFailure(target: ProvisionedTargetRecord, error: unknown): void {
    const { dispatcherId, log } = this.opts;
    log.error(
      {
        dispatcher_id: dispatcherId,
        space_name: target.space_name,
        target_key: target.target_key,
        err: { message: parseMessage(error) },
      },
      'collaboration target resume failed',
    );
  }
}
