import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { DreamuxConfig } from '../../config/config.js';
import type {
  ChannelRouteOwner,
  ChannelService,
} from '../channel-service/index.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import type { TeamCollection } from '../team-collection/index.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import {
  type TeamDissolveInput,
  validateTeamId,
} from '../team-collection/types.js';
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
import { CollaborationSpaceStore } from './store.js';
import { CollaborationRouteReconciler } from './route-reconciliation.js';
import { spaceView, targetView } from './view.js';
import {
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
  private readonly routes: CollaborationRouteReconciler;
  private readonly spaceLocks = new KeyedAsyncQueue();
  private readonly lifecycleTasks = new Set<Promise<void>>();

  constructor(private readonly opts: CollaborationSpaceServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.config = opts.config;
    this.teams = opts.teams;
    this.channels = opts.channels;
    this.store = opts.store ?? new CollaborationSpaceStore();
    const targetLocks = new KeyedAsyncQueue();
    this.routes = new CollaborationRouteReconciler({
      dispatcherId: this.dispatcherId,
      teams: this.teams,
      channels: this.channels,
      store: this.store,
      locks: targetLocks,
      isShuttingDown: opts.isShuttingDown,
    });
    this.targets = new CollaborationTargetLifecycle({
      dispatcherId: this.dispatcherId,
      config: this.config,
      teams: this.teams,
      channels: this.channels,
      store: this.store,
      spaceLocks: this.spaceLocks,
      targetLocks,
      routes: this.routes,
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

    const existingForContainer = input.container === undefined
      ? await this.store.getSpace(this.dispatcherId, spaceName)
      : null;
    const container = input.container ?? containerFromSpace(
      requiredSpace(existingForContainer),
    );
    return this.spaceLocks.run(
      spaceContainerLockKey(channelId, container.container_key),
      async () => {
        this.assertNotShuttingDown();
        const saved = await this.store.bindSpace({
          dispatcherId: this.dispatcherId,
          spaceName,
          channelId,
          provider,
          container,
          ...(input.display !== undefined ? { display: input.display } : {}),
          binding: {
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
          },
        });
        return { space: await this.view(saved) };
      },
    );
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

  mutateTargetRoute<T>(input: {
    channelId: string;
    target: CollaborationSpaceProvisionInput['target'];
    expectedOwner?: ChannelRouteOwner;
  }, mutation: () => Promise<T>): Promise<T> {
    return this.routes.mutateTargetRoute(input, mutation);
  }

  bindTargetRoute(input: {
    teamId: string;
    channelId: string;
    target: CollaborationSpaceProvisionInput['target'];
  }) {
    return this.routes.bindTargetRoute(input);
  }

  dissolveTeam(input: TeamDissolveInput) {
    return this.routes.dissolveTeam(input);
  }

  detachTargetsForOwner(owner: ChannelRouteOwner): Promise<number> {
    return this.routes.detachTargetsForOwner(owner);
  }

  reconcileInboundTargetRoute(input: {
    channelId: string;
    target: CollaborationSpaceProvisionInput['target'];
  }): Promise<ProvisionedTargetRecord | null> {
    return this.routes.reconcileInboundTargetRoute(input);
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
  return spaceContainerLockKey(space.channel_id, space.container_key);
}

function spaceContainerLockKey(channelId: string, containerKey: string): string {
  return [channelId, containerKey].join('\0');
}
