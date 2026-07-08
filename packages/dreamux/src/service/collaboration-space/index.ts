import type {
  ChannelContainer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../../config/config.js';
import type { ChannelService } from '../channel-service/index.js';
import type { TeamCollection } from '../team-collection/index.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import { validateTeamId } from '../team-collection/types.js';
import type {
  CollaborationSpaceBindInput,
  CollaborationSpaceCloseTargetInput,
  CollaborationSpaceDissolveInput,
  CollaborationSpaceProvisionInput,
  CollaborationSpaceRecord,
  CollaborationSpaceStatusInput,
  CollaborationSpaceView,
  ProvisionedTargetRecord,
  ProvisionedTargetView,
} from './types.js';
import { COLLABORATION_SPACE_RECORD_VERSION } from './types.js';
import { CollaborationSpaceStore } from './store.js';
import { hashTarget, nonBlank, slugFor, targetIntent } from './naming.js';
import { ownerForTarget, targetFromRecord } from './target.js';
import { targetCounts, targetView } from './view.js';

export interface CollaborationSpaceServiceOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  teams: TeamCollection;
  channels: ChannelService;
  store?: CollaborationSpaceStore;
  log: DreamuxLogger;
  isShuttingDown: () => boolean;
}

export class CollaborationSpaceService {
  private readonly dispatcherId: string;
  private readonly config: DreamuxConfig;
  private readonly teams: TeamCollection;
  private readonly channels: ChannelService;
  private readonly store: CollaborationSpaceStore;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly opts: CollaborationSpaceServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.config = opts.config;
    this.teams = opts.teams;
    this.channels = opts.channels;
    this.store = opts.store ?? new CollaborationSpaceStore();
  }

  async bind(input: CollaborationSpaceBindInput): Promise<{
    space: CollaborationSpaceView;
  }> {
    this.assertNotShuttingDown();
    const spaceName = validateTeamId(input.spaceName);
    const channelId = this.channels.resolveChannelId(input.channelId);
    const provider = this.channels.channelProviderRef(channelId);
    resolveAgent(this.config, this.dispatcherId, input.leaderAgentRuntime);

    const existing = await this.store.getSpace(this.dispatcherId, spaceName);
    if (existing === null && input.container === undefined) {
      throw new Error('container is required when binding a new collaboration space');
    }
    const container = input.container ?? containerFromSpace(requiredSpace(existing));
    if (existing !== null) {
      assertSameContainer(existing, channelId, container);
      if (existing.status === 'bound') {
        throw new Error(
          `collaboration space ${JSON.stringify(spaceName)} is already bound; ` +
            'dissolve it before binding it again',
        );
      }
    }
    const byContainer = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
      channelId,
      containerKey: container.container_key,
    });
    if (byContainer !== null && byContainer.space_name !== spaceName) {
      throw new Error(
        `channel container ${JSON.stringify(container.container_key)} is already ` +
          `registered as collaboration space ${JSON.stringify(byContainer.space_name)}`,
      );
    }

    const now = Date.now();
    const generation = (existing?.last_binding_generation ?? 0) + 1;
    const record: CollaborationSpaceRecord = {
      version: COLLABORATION_SPACE_RECORD_VERSION,
      dispatcher_id: this.dispatcherId,
      space_name: spaceName,
      channel_id: channelId,
      provider,
      container_type: container.container_type,
      container_key: container.container_key,
      display: input.display ?? container.display ?? existing?.display ?? null,
      canonical_url: container.canonical_url ?? existing?.canonical_url ?? null,
      current_binding: {
        generation,
        repo_cwd: input.repo.cwd,
        worktree: {
          mode: 'managed',
          base_ref: input.repo.baseRef ?? null,
          cleanup: 'delete-on-close',
        },
        leader_agent_runtime: input.leaderAgentRuntime,
        identity: input.identity ?? null,
        bound_at: now,
      },
      last_binding_generation: generation,
      status: 'bound',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      unbound_at: null,
      unbound_note: null,
    };
    const saved = await this.store.saveSpace(record);
    return { space: await this.view(saved) };
  }

  async dissolve(input: CollaborationSpaceDissolveInput): Promise<{
    space: CollaborationSpaceView;
    detached_targets: number;
    released_bindings: number;
  }> {
    this.assertNotShuttingDown();
    const space = await this.mustSpace(input.spaceName);
    if (space.current_binding === null || space.status === 'unbound') {
      return {
        space: await this.view(space),
        detached_targets: 0,
        released_bindings: 0,
      };
    }
    const generation = space.current_binding.generation;
    const targets = await this.store.listTargets(this.dispatcherId, {
      spaceName: space.space_name,
      channelId: space.channel_id,
      containerKey: space.container_key,
      bindingGeneration: generation,
    });
    let detached = 0;
    let released = 0;
    for (const target of targets) {
      if (target.lifecycle_status !== 'active' && target.lifecycle_status !== 'creating') {
        continue;
      }
      await this.withTargetLock(targetKey(target), async () => {
        const latest = await this.store.getTarget(this.dispatcherId, {
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
          const binding = await this.channels.transferResolvedTargetBack({
            expectedOwner: ownerForTarget(latest),
            channelId: latest.channel_id,
            target: targetFromRecord(latest),
          });
          if (binding !== null) released += 1;
        }
        await this.store.saveTarget({
          ...latest,
          lifecycle_status: 'detached',
          updated_at: Date.now(),
          detached_at: Date.now(),
        });
        detached += 1;
      });
    }
    const now = Date.now();
    const saved = await this.store.saveSpace({
      ...space,
      current_binding: null,
      status: 'unbound',
      updated_at: now,
      unbound_at: now,
      unbound_note: input.note,
    });
    return {
      space: await this.view(saved),
      detached_targets: detached,
      released_bindings: released,
    };
  }

  async status(input: CollaborationSpaceStatusInput): Promise<{
    space: CollaborationSpaceView;
    targets: ProvisionedTargetView[];
  }> {
    const space = await this.mustSpace(input.spaceName);
    return {
      space: await this.view(space),
      targets: (await this.store.listTargets(this.dispatcherId, {
        spaceName: space.space_name,
      })).map(targetView),
    };
  }

  async list(): Promise<{ spaces: CollaborationSpaceView[] }> {
    const spaces = await this.store.listSpaces(this.dispatcherId);
    return { spaces: await Promise.all(spaces.map((space) => this.view(space))) };
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
    const space = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null || space.current_binding === null || space.status !== 'bound') {
      return null;
    }
    return this.withTargetLock(
      lockKey({
        channelId: input.channelId,
        containerKey: input.container.container_key,
        bindingGeneration: space.current_binding.generation,
        targetKey: input.target.target_key,
      }),
      () => this.provisionUnderLock(space, input),
    );
  }

  async acceptAndProvisionTarget(input: CollaborationSpaceProvisionInput): Promise<ProvisionedTargetRecord | null> {
    const accepted = await this.acceptTargetCreated(input);
    return accepted ? this.provisionTarget(input) : null;
  }

  async acceptTargetCreated(input: CollaborationSpaceProvisionInput): Promise<boolean> {
    this.assertNotShuttingDown();
    if (!input.target.bindable) {
      throw new Error(
        `collaboration-space target ${JSON.stringify(input.target.target_key)} is not bindable`,
      );
    }
    const space = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
    });
    if (space === null || space.current_binding === null || space.status !== 'bound') {
      return false;
    }
    const binding = space.current_binding;
    await this.withTargetLock(
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
        const existing = await this.store.getTarget(this.dispatcherId, key);
        if (existing === null) {
          await this.createTargetClaim(space, input);
          return;
        }
        if (existing.lifecycle_status === 'closed') {
          throw new Error(
            `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
          );
        }
      },
    );
    return true;
  }

  async closeTarget(input: CollaborationSpaceCloseTargetInput): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    const space = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
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
    return this.withTargetLock(key, async () => {
      const record = await this.store.getTarget(this.dispatcherId, {
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
      const closing = await this.store.saveTarget({
        ...record,
        lifecycle_status: 'closing',
        close_event_id: input.eventId ?? record.close_event_id,
        updated_at: Date.now(),
      });
      if (closing.leader_name !== null) {
        try {
          await this.channels.transferResolvedTargetBack({
            expectedOwner: ownerForTarget(closing),
            channelId: closing.channel_id,
            target: targetFromRecord(closing),
          });
          await this.teams.get(closing.team_name).then((team) =>
            team.dissolve({
              teamId: closing.team_name,
              note: `Collaboration target ${closing.target_key} closed.`,
            }),
          );
        } catch (err) {
          const msg = parseMessage(err);
          await this.store.saveTarget({ ...closing, last_error: msg, updated_at: Date.now() });
          this.opts.log.error(
            { dispatcher_id: this.dispatcherId, space_name: closing.space_name, target_key: closing.target_key, err: { message: msg } },
            'collaboration target close failed (target remains in closing state for retry)',
          );
          throw err;
        }
      }
      const closed = await this.store.saveTarget({
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
    const space = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
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
    return this.withTargetLock(key, async () => {
      const record = await this.store.getTarget(this.dispatcherId, {
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
      await this.store.saveTarget({
        ...record,
        lifecycle_status: 'closing',
        close_event_id: input.eventId ?? record.close_event_id,
        updated_at: Date.now(),
      });
      return true;
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
    const existing = await this.store.getTarget(this.dispatcherId, key);
    if (existing !== null) {
      if (existing.lifecycle_status === 'active') return existing;
      if (existing.lifecycle_status === 'closed') {
        throw new Error(
          `collaboration target ${JSON.stringify(input.target.target_key)} is closed and cannot be reopened`,
        );
      }
      if (existing.lifecycle_status === 'detached') return existing;
    }
    let record = existing ?? await this.createTargetClaim(space, input);
    try {
      const routed = await this.channels.resolveInboundBinding({
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
        if (!(await this.teams.isOpenTeam(record.team_name))) {
          await this.teams.create({
            name: record.team_name,
            repoCwd: binding.repo_cwd,
            leaderAgentRuntime: binding.leader_agent_runtime,
            intent: targetIntent(input.target, record),
            ...(binding.identity !== null ? { identity: binding.identity } : {}),
            worktree: {
              mode: 'managed',
              slug: record.worktree_slug,
              branch: record.team_name,
              ...(binding.worktree.base_ref !== null
                ? { base_ref: binding.worktree.base_ref }
                : {}),
              cleanup: binding.worktree.cleanup,
            },
          });
        }
        const owner = await this.teams.requireOpenTeamRouteOwner(record.team_name);
        record = await this.store.saveTarget({
          ...record,
          leader_name: owner.leaderName,
          phase: 'team_created',
          updated_at: Date.now(),
        });
      }
      const owner = await this.teams.requireOpenTeamRouteOwner(record.team_name);
      const latestBinding = await this.channels.resolveInboundBinding({
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
      await this.channels.bindResolvedTarget({
        owner,
        channelId: input.channelId,
        target: input.target,
      });
      return this.store.saveTarget({
        ...record,
        leader_name: owner.leaderName,
        phase: 'bound',
        lifecycle_status: 'active',
        last_error: null,
        updated_at: Date.now(),
      });
    } catch (err) {
      const failed = await this.store.saveTarget({
        ...record,
        lifecycle_status: 'failed',
        last_error: parseMessage(err),
        updated_at: Date.now(),
      });
      this.opts.log.error(
        {
          dispatcher_id: this.dispatcherId,
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
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      containerKey: input.container.container_key,
      bindingGeneration: binding.generation,
      targetKey: input.target.target_key,
    });
    const display = nonBlank(input.title) ?? nonBlank(input.target.display) ?? null;
    const titleSlug = slugFor(display);
    const teamName = validateTeamId(`space-${titleSlug}-${targetHash}`);
    if (await this.teams.isOpenTeam(teamName)) {
      throw new Error(
        `generated collaboration Team name ${JSON.stringify(teamName)} already exists`,
      );
    }
    const now = Date.now();
    return this.store.saveTarget({
      version: COLLABORATION_SPACE_RECORD_VERSION,
      dispatcher_id: this.dispatcherId,
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

  private async mustSpace(spaceName: string): Promise<CollaborationSpaceRecord> {
    const name = validateTeamId(spaceName);
    const space = await this.store.getSpace(this.dispatcherId, name);
    if (space === null) {
      throw new Error(`collaboration space ${JSON.stringify(name)} does not exist`);
    }
    return space;
  }

  private async view(space: CollaborationSpaceRecord): Promise<CollaborationSpaceView> {
    const targets = await this.store.listTargets(this.dispatcherId, {
      spaceName: space.space_name,
    });
    return {
      space_name: space.space_name,
      channel_id: space.channel_id,
      provider: space.provider,
      container_type: space.container_type,
      container_key: space.container_key,
      display: space.display,
      canonical_url: space.canonical_url,
      status: space.status,
      current_binding: space.current_binding === null
        ? null
        : {
            generation: space.current_binding.generation,
            worktree: space.current_binding.worktree,
            leader_agent_runtime: space.current_binding.leader_agent_runtime,
            has_identity: space.current_binding.identity !== null,
            bound_at: space.current_binding.bound_at,
          },
      last_binding_generation: space.last_binding_generation,
      target_counts: targetCounts(targets),
      created_at: space.created_at,
      updated_at: space.updated_at,
      unbound_at: space.unbound_at,
      unbound_note: space.unbound_note,
    };
  }

  private async withTargetLock<T>(
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = previous.catch(() => undefined).then(() => next);
    this.locks.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }

  private assertNotShuttingDown(): void {
    if (this.opts.isShuttingDown()) {
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    }
  }
}

function requiredSpace(
  space: CollaborationSpaceRecord | null,
): CollaborationSpaceRecord {
  if (space === null) {
    throw new Error('collaboration space record is required');
  }
  return space;
}

function requiredBinding(
  space: CollaborationSpaceRecord,
): NonNullable<CollaborationSpaceRecord['current_binding']> {
  if (space.current_binding === null) {
    throw new Error(
      `collaboration space ${JSON.stringify(space.space_name)} is not bound`,
    );
  }
  return space.current_binding;
}

function containerFromSpace(space: CollaborationSpaceRecord): ChannelContainer {
  return {
    container_type: space.container_type,
    container_key: space.container_key,
    ...(space.display !== null ? { display: space.display } : {}),
    ...(space.canonical_url !== null ? { canonical_url: space.canonical_url } : {}),
  };
}

function assertSameContainer(
  space: CollaborationSpaceRecord,
  channelId: string,
  container: ChannelContainer,
): void {
  if (
    space.channel_id !== channelId ||
    space.container_type !== container.container_type ||
    space.container_key !== container.container_key
  ) {
    throw new Error(
      `collaboration space ${JSON.stringify(space.space_name)} is already ` +
        'registered for a different channel container',
    );
  }
}

function lockKey(input: {
  channelId: string;
  containerKey: string;
  bindingGeneration: number;
  targetKey: string;
}): string {
  return [
    input.channelId,
    input.containerKey,
    String(input.bindingGeneration),
    input.targetKey,
  ].join('\0');
}

function targetKey(target: ProvisionedTargetRecord): string {
  return lockKey({
    channelId: target.channel_id,
    containerKey: target.container_key,
    bindingGeneration: target.binding_generation,
    targetKey: target.target_key,
  });
}

function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
