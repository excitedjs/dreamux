import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../../config/config.js';
import type { ChannelService } from '../channel-service/index.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import type { TeamCollection } from '../team-collection/index.js';
import { validateTeamId } from '../team-collection/types.js';
import { createDefaultBoundSpace } from './default-binding.js';
import {
  hashTarget,
  nonBlank,
  slugFor,
  targetIntent,
} from './naming.js';
import { CollaborationSpaceStore } from './store.js';
import {
  lockKey,
  parseMessage,
  requiredBinding,
  targetKey,
} from './support.js';
import { ownerForTarget, targetFromRecord } from './target.js';
import type {
  CollaborationSpaceCloseTargetInput,
  CollaborationSpaceDefaultBindingInput,
  CollaborationSpaceProvisionInput,
  CollaborationSpaceRecord,
  ProvisionedTargetRecord,
  ProvisionedTargetView,
} from './types.js';
import { COLLABORATION_SPACE_RECORD_VERSION } from './types.js';
import { targetView } from './view.js';

export interface AcceptTargetCreatedOptions {
  allowMissing?: boolean;
  defaultBinding?: CollaborationSpaceDefaultBindingInput;
}

export interface AcceptedTargetProvision {
  provision: () => Promise<ProvisionedTargetRecord>;
}

export interface CollaborationTargetLifecycleOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  teams: TeamCollection;
  channels: ChannelService;
  store: CollaborationSpaceStore;
  log: DreamuxLogger;
  isShuttingDown: () => boolean;
}

interface AcceptedTargetCreated {
  space: CollaborationSpaceRecord;
}

export class CollaborationTargetLifecycle {
  private readonly locks = new KeyedAsyncQueue();

  constructor(private readonly opts: CollaborationTargetLifecycleOptions) {}

  async detachActiveTargets(space: CollaborationSpaceRecord): Promise<{
    detached_targets: number;
    released_bindings: number;
  }> {
    const binding = requiredBinding(space);
    const targets = await this.opts.store.listTargets(this.opts.dispatcherId, {
      spaceName: space.space_name,
      channelId: space.channel_id,
      containerKey: space.container_key,
      bindingGeneration: binding.generation,
    });
    let detached = 0;
    let released = 0;
    for (const target of targets) {
      if (target.lifecycle_status !== 'active' && target.lifecycle_status !== 'creating') {
        continue;
      }
      await this.locks.run(targetKey(target), async () => {
        const latest = await this.opts.store.getTarget(this.opts.dispatcherId, {
          channelId: target.channel_id,
          containerKey: target.container_key,
          bindingGeneration: target.binding_generation,
          targetKey: target.target_key,
        });
        if (
          latest === null ||
          (latest.lifecycle_status !== 'active' &&
            latest.lifecycle_status !== 'creating')
        ) {
          return;
        }
        if (latest.leader_name !== null) {
          const bindingRow = await this.opts.channels.transferResolvedTargetBack({
            expectedOwner: ownerForTarget(latest),
            channelId: latest.channel_id,
            target: targetFromRecord(latest),
          });
          if (bindingRow !== null) released += 1;
        }
        await this.opts.store.saveTarget({
          ...latest,
          lifecycle_status: 'detached',
          updated_at: Date.now(),
          detached_at: Date.now(),
        });
        detached += 1;
      });
    }
    return { detached_targets: detached, released_bindings: released };
  }

  async provisionTarget(
    input: CollaborationSpaceProvisionInput,
  ): Promise<ProvisionedTargetRecord | null> {
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
  }

  async acceptAndProvisionTarget(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<ProvisionedTargetRecord | null> {
    const accepted = await this.acceptTargetCreatedContext(input, {
      ...options,
      allowMissing: true,
    });
    return accepted === null
      ? null
      : this.provisionTargetForSpace(accepted.space, input);
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
    const key = lockKey({
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: generation,
      targetKey: input.target.target_key,
    });
    return this.locks.run(key, async () => {
      const record = await this.opts.store.getTarget(this.opts.dispatcherId, {
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: generation,
        targetKey: input.target.target_key,
      });
      if (record === null || record.lifecycle_status === 'detached') {
        return { closed: false, target: record === null ? null : targetView(record) };
      }
      if (record.lifecycle_status === 'closed') {
        return { closed: false, target: targetView(record) };
      }
      const closing = await this.opts.store.saveTarget({
        ...record,
        lifecycle_status: 'closing',
        close_event_id: input.eventId ?? record.close_event_id,
        updated_at: Date.now(),
      });
      if (closing.leader_name !== null) {
        try {
          await this.opts.channels.transferResolvedTargetBack({
            expectedOwner: ownerForTarget(closing),
            channelId: closing.channel_id,
            target: targetFromRecord(closing),
          });
          await this.opts.teams.get(closing.team_name).then((team) =>
            team.dissolve({
              teamId: closing.team_name,
              note: `Collaboration target ${closing.target_key} closed.`,
            }),
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
      }
      const closed = await this.opts.store.saveTarget({
        ...closing,
        lifecycle_status: 'closed',
        phase: 'closed',
        updated_at: Date.now(),
        closed_at: Date.now(),
      });
      return { closed: true, target: targetView(closed) };
    });
  }

  async acceptTargetClosed(input: CollaborationSpaceCloseTargetInput): Promise<boolean> {
    const space = await this.opts.store.findSpaceByContainer({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null) return false;
    const generation = space.current_binding?.generation ?? space.last_binding_generation;
    const key = lockKey({
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: generation,
      targetKey: input.target.target_key,
    });
    return this.locks.run(key, async () => {
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
        return false;
      }
      await this.opts.store.saveTarget({
        ...record,
        lifecycle_status: 'closing',
        close_event_id: input.eventId ?? record.close_event_id,
        updated_at: Date.now(),
      });
      return true;
    });
  }

  private async provisionTargetForSpace(
    space: CollaborationSpaceRecord,
    input: CollaborationSpaceProvisionInput,
  ): Promise<ProvisionedTargetRecord> {
    const binding = requiredBinding(space);
    return this.locks.run(
      lockKey({
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: binding.generation,
        targetKey: input.target.target_key,
      }),
      () => this.provisionUnderLock(space, input),
    );
  }

  private async acceptTargetCreatedContext(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions,
  ): Promise<AcceptedTargetCreated | null> {
    this.assertNotShuttingDown();
    if (!input.target.bindable) {
      throw new Error(
        `collaboration-space target ${JSON.stringify(input.target.target_key)} is not bindable`,
      );
    }
    const space = await this.boundSpaceForTarget(input, options.defaultBinding);
    if (space === null) {
      if (options.allowMissing === true) return null;
      throw new Error(
        `collaboration space for channel container ` +
          `${JSON.stringify(input.container.container_key)} is not bound`,
      );
    }
    const binding = requiredBinding(space);
    await this.locks.run(
      lockKey({
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: binding.generation,
        targetKey: input.target.target_key,
      }),
      async () => {
        const key = {
          channelId: input.channelId,
          containerKey: input.container.container_key,
          bindingGeneration: binding.generation,
          targetKey: input.target.target_key,
        };
        const existing = await this.opts.store.getTarget(this.opts.dispatcherId, key);
        if (existing === null) {
          await this.createTargetClaim(space, input);
          return;
        }
        if (existing.lifecycle_status === 'closed') {
          throw new Error(
            `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
          );
        }
        if (existing.lifecycle_status === 'closing') {
          throw new Error(
            `collaboration target ${JSON.stringify(input.target.target_key)} is closing and cannot be provisioned`,
          );
        }
      },
    );
    return { space };
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
    return createDefaultBoundSpace({
      dispatcherId: this.opts.dispatcherId,
      config: this.opts.config,
      store: this.opts.store,
      provision: input,
      binding: defaultBinding,
    });
  }

  private async provisionUnderLock(
    space: CollaborationSpaceRecord,
    input: CollaborationSpaceProvisionInput,
  ): Promise<ProvisionedTargetRecord> {
    const binding = requiredBinding(space);
    const key = {
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: binding.generation,
      targetKey: input.target.target_key,
    };
    const existing = await this.opts.store.getTarget(this.opts.dispatcherId, key);
    if (existing !== null) {
      if (existing.lifecycle_status === 'active') return existing;
      if (existing.lifecycle_status === 'closed') {
        throw new Error(
          `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
        );
      }
      if (existing.lifecycle_status === 'closing') {
        throw new Error(
          `collaboration target ${JSON.stringify(input.target.target_key)} is closing and cannot be provisioned`,
        );
      }
      if (existing.lifecycle_status === 'detached') return existing;
    }
    let record = existing ?? await this.createTargetClaim(space, input);
    try {
      const routed = await this.opts.channels.resolveInboundBinding({
        channelId: input.channelId,
        target: input.target,
      });
      if (
        routed !== null &&
        (routed.owner.teamName !== record.team_name ||
          routed.owner.leaderName !== record.leader_name)
      ) {
        throw new Error(
          `channel target ${JSON.stringify(input.target.target_key)} is already bound to Team ` +
            `${JSON.stringify(routed.owner.teamName)}`,
        );
      }
      if (record.phase === 'claimed') {
        if (!(await this.opts.teams.isOpenTeam(record.team_name))) {
          await this.opts.teams.create({
            name: record.team_name,
            leaderAgentRuntime: binding.leader_agent_runtime,
            intent: targetIntent(input.target, record),
            ...(binding.identity !== null ? { identity: binding.identity } : {}),
            ...(binding.repo_cwd !== null && binding.worktree.mode === 'managed'
              ? {
                  repoCwd: binding.repo_cwd,
                  worktree: {
                    mode: 'managed' as const,
                    slug: record.worktree_slug,
                    branch: record.team_name,
                    ...(binding.worktree.base_ref !== null
                      ? { base_ref: binding.worktree.base_ref }
                      : {}),
                    cleanup: binding.worktree.cleanup,
                  },
                }
              : {}),
          });
        }
        const owner = await this.opts.teams.requireOpenTeamRouteOwner(record.team_name);
        record = await this.opts.store.saveTarget({
          ...record,
          leader_name: owner.leaderName,
          phase: 'team_created',
          updated_at: Date.now(),
        });
      }
      const owner = await this.opts.teams.requireOpenTeamRouteOwner(record.team_name);
      const latestBinding = await this.opts.channels.resolveInboundBinding({
        channelId: input.channelId,
        target: input.target,
      });
      if (
        latestBinding !== null &&
        (latestBinding.owner.teamName !== owner.teamName ||
          latestBinding.owner.leaderName !== owner.leaderName)
      ) {
        throw new Error(
          `channel target ${JSON.stringify(input.target.target_key)} is already bound to Team ` +
            `${JSON.stringify(latestBinding.owner.teamName)}`,
        );
      }
      await this.opts.channels.bindResolvedTarget({
        owner,
        channelId: input.channelId,
        target: input.target,
      });
      return this.opts.store.saveTarget({
        ...record,
        leader_name: owner.leaderName,
        phase: 'bound',
        lifecycle_status: 'active',
        last_error: null,
        updated_at: Date.now(),
      });
    } catch (err) {
      const failed = await this.opts.store.saveTarget({
        ...record,
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

  private async createTargetClaim(
    space: CollaborationSpaceRecord,
    input: CollaborationSpaceProvisionInput,
  ): Promise<ProvisionedTargetRecord> {
    const binding = requiredBinding(space);
    const targetHash = hashTarget({
      dispatcherId: this.opts.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: binding.generation,
      targetKey: input.target.target_key,
    });
    const display = nonBlank(input.title) ?? nonBlank(input.target.display) ?? null;
    const titleSlug = slugFor(display);
    const teamName = validateTeamId(`space-${titleSlug}-${targetHash}`);
    if (await this.opts.teams.isOpenTeam(teamName)) {
      throw new Error(
        `generated collaboration Team name ${JSON.stringify(teamName)} already exists`,
      );
    }
    const now = Date.now();
    return this.opts.store.saveTarget({
      version: COLLABORATION_SPACE_RECORD_VERSION,
      dispatcher_id: this.opts.dispatcherId,
      space_name: space.space_name,
      channel_id: input.channelId,
      provider: input.provider,
      container_key: input.container.container_key,
      binding_generation: binding.generation,
      target_key: input.target.target_key,
      target_type: input.target.target_type,
      target_display: display,
      team_name: teamName,
      leader_name: null,
      worktree_slug: teamName,
      lifecycle_status: 'creating',
      phase: 'claimed',
      claim_event_id: input.eventId ?? null,
      close_event_id: null,
      last_error: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
      detached_at: null,
    });
  }

  private assertNotShuttingDown(): void {
    if (this.opts.isShuttingDown()) {
      throw new Error(`dispatcher '${this.opts.dispatcherId}' is shutting down`);
    }
  }
}
