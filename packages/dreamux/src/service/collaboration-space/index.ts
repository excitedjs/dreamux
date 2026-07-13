import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../../config/config.js';
import type { ChannelService } from '../channel-service/index.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import type { TeamCollection } from '../team-collection/index.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import { validateTeamId } from '../team-collection/types.js';
import {
  type AcceptedTargetClose,
  type AcceptedTargetProvision,
  type AcceptTargetCreatedOptions,
  CollaborationTargetLifecycle,
} from './target-lifecycle.js';
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
import { spaceView, targetView } from './view.js';
import {
  assertSameContainer,
  containerFromSpace,
  parseMessage,
  requiredSpace,
} from './support.js';

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
  private readonly targets: CollaborationTargetLifecycle;
  private readonly spaceLocks = new KeyedAsyncQueue();
  private readonly lifecycleTasks = new Set<Promise<void>>();

  constructor(private readonly opts: CollaborationSpaceServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.config = opts.config;
    this.teams = opts.teams;
    this.channels = opts.channels;
    this.store = opts.store ?? new CollaborationSpaceStore();
    this.targets = new CollaborationTargetLifecycle({
      dispatcherId: this.dispatcherId,
      config: this.config,
      teams: this.teams,
      channels: this.channels,
      store: this.store,
      spaceLocks: this.spaceLocks,
      log: opts.log,
      isShuttingDown: opts.isShuttingDown,
    });
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
        repo_cwd: input.repo?.cwd ?? null,
        worktree: input.repo === undefined
          ? { mode: 'default' }
          : {
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
    const initial = await this.mustSpace(input.spaceName);
    return this.spaceLocks.run(spaceLockKey(initial), async () => {
      const space = await this.mustSpace(input.spaceName);
      if (space.current_binding === null || space.status === 'unbound') {
        return {
          space: await this.view(space),
          detached_targets: 0,
          released_bindings: 0,
        };
      }
      const detached = await this.targets.detachActiveTargets(space);
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
        detached_targets: detached.detached_targets,
        released_bindings: detached.released_bindings,
      };
    });
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
    return this.targets.provisionTarget(input);
  }

  async acceptAndProvisionTarget(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<ProvisionedTargetRecord | null> {
    return this.targets.acceptAndProvisionTarget(input, options);
  }

  async acceptTargetCreated(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<boolean> {
    return this.targets.acceptTargetCreated(input, options);
  }

  async acceptTargetCreatedForProvision(
    input: CollaborationSpaceProvisionInput,
    options: AcceptTargetCreatedOptions = {},
  ): Promise<AcceptedTargetProvision | null> {
    return this.targets.acceptTargetCreatedForProvision(input, options);
  }

  async closeTarget(input: CollaborationSpaceCloseTargetInput): Promise<{
    closed: boolean;
    target: ProvisionedTargetView | null;
  }> {
    return this.targets.closeTarget(input);
  }

  async acceptTargetClosed(input: CollaborationSpaceCloseTargetInput): Promise<boolean> {
    return this.targets.acceptTargetClosed(input);
  }

  async acceptTargetClosedForClose(
    input: CollaborationSpaceCloseTargetInput,
  ): Promise<AcceptedTargetClose | null> {
    return this.targets.acceptTargetClosedForClose(input);
  }

  async provisionClaimedTarget(input: {
    channelId: string;
    provider: string;
    target: CollaborationSpaceProvisionInput['target'];
  }): Promise<ProvisionedTargetRecord | null> {
    return this.targets.provisionClaimedTarget(input);
  }

  startAcceptedTargetProvision(accepted: AcceptedTargetProvision): void {
    this.trackLifecycleTask(
      'provision',
      accepted.provision().then(() => undefined),
    );
  }

  startTargetClose(accepted: AcceptedTargetClose): void {
    this.trackLifecycleTask(
      'close',
      accepted.close().then(() => undefined),
    );
  }

  async resumePendingTargets(): Promise<void> {
    await this.targets.resumePendingTargets();
  }

  async drainLifecycleTasks(): Promise<void> {
    while (this.lifecycleTasks.size > 0) {
      await Promise.allSettled([...this.lifecycleTasks]);
    }
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
    return spaceView(space, targets);
  }

  private assertNotShuttingDown(): void {
    if (this.opts.isShuttingDown()) {
      throw new Error(`dispatcher '${this.dispatcherId}' is shutting down`);
    }
  }

  trackLifecycleTask(
    kind: 'accept' | 'provision' | 'close',
    task: Promise<void>,
  ): void {
    const tracked = task
      .catch((err) => {
        this.opts.log.error(
          {
            dispatcher_id: this.dispatcherId,
            kind,
            err: { message: parseMessage(err) },
          },
          'collaboration target lifecycle task failed',
        );
      })
      .finally(() => {
        this.lifecycleTasks.delete(tracked);
      });
    this.lifecycleTasks.add(tracked);
  }
}

function spaceLockKey(space: CollaborationSpaceRecord): string {
  return [space.channel_id, space.container_key].join('\0');
}
