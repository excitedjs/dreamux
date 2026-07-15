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
  CollaborationBindingSnapshot,
  CollaborationSpaceStatusInput,
  CollaborationSpaceView,
  ProvisionedTargetRecord,
  ProvisionedTargetView,
  ResolvedCollaborationRepositoryPolicy,
} from './types.js';
import { createDefaultBoundSpace } from './default-binding.js';
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
      spaceContainerLockKey(
        channelId,
        container.container_type,
        container.container_key,
      ),
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

  async dissolve(
    input: CollaborationSpaceDissolveInput,
    options: {
      assertCanDissolve?: (space: CollaborationSpaceRecord) => Promise<void> | void;
    } = {},
  ): Promise<{
    space: CollaborationSpaceView;
    detached_targets: number;
    released_bindings: number;
  }> {
    this.assertNotShuttingDown();
    const initial = await this.mustSpace(input.spaceName);
    return this.spaceLocks.run(spaceLockKey(initial), async () => {
      const space = await this.mustSpace(input.spaceName);
      await options.assertCanDissolve?.(space);
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

  async inspectTaskBinding(input: {
    channelId: string;
    container: CollaborationSpaceProvisionInput['container'];
    repository: ResolvedCollaborationRepositoryPolicy;
  }): Promise<CollaborationBindingSnapshot | null> {
    const space = await this.store.findSpaceByContainer({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      containerType: input.container.container_type,
      containerKey: input.container.container_key,
    });
    if (space === null) return null;
    return taskBindingSnapshot(space, input.repository);
  }

  async ensureTaskBinding(input: {
    channelId: string;
    provider: string;
    container: CollaborationSpaceProvisionInput['container'];
    repository: ResolvedCollaborationRepositoryPolicy;
    leaderAgentRuntime: string;
    identity: string | null;
  }): Promise<CollaborationBindingSnapshot> {
    return this.spaceLocks.run(
      spaceContainerLockKey(
        input.channelId,
        input.container.container_type,
        input.container.container_key,
      ),
      async () => {
        const existing = await this.store.findSpaceByContainer({
          dispatcherId: this.dispatcherId,
          channelId: input.channelId,
          containerType: input.container.container_type,
          containerKey: input.container.container_key,
        });
        let space = existing ?? await createDefaultBoundSpace({
          dispatcherId: this.dispatcherId,
          config: this.config,
          store: this.store,
          channelId: input.channelId,
          provider: input.provider,
          container: input.container,
          binding: {
            leaderAgentRuntime: input.leaderAgentRuntime,
            repo: {
              cwd: input.repository.repo_cwd,
              ...(input.repository.base_ref !== null
                ? { baseRef: input.repository.base_ref }
                : {}),
            },
            repositoryPolicy: {
              source: input.repository.source,
              logical_key: input.repository.logical_key,
              binding_revision: input.repository.binding_revision,
              fingerprint: input.repository.fingerprint,
            },
            ...(input.identity !== null ? { identity: input.identity } : {}),
          },
        });
        if (
          space.current_binding?.repository_policy === undefined &&
          input.repository.source === 'static'
        ) {
          space = await this.store.pinRepositoryPolicy({
            dispatcherId: this.dispatcherId,
            channelId: input.channelId,
            containerType: input.container.container_type,
            containerKey: input.container.container_key,
            repoCwd: input.repository.repo_cwd,
            baseRef: input.repository.base_ref,
            policy: {
              source: input.repository.source,
              logical_key: input.repository.logical_key,
              binding_revision: input.repository.binding_revision,
              fingerprint: input.repository.fingerprint,
            },
          });
        }
        return taskBindingSnapshot(space, input.repository);
      },
    );
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
  return spaceContainerLockKey(
    space.channel_id,
    space.container_type,
    space.container_key,
  );
}

function spaceContainerLockKey(
  channelId: string,
  containerType: string,
  containerKey: string,
): string {
  return [channelId, containerType, containerKey].join('\0');
}

function taskBindingSnapshot(
  space: CollaborationSpaceRecord,
  expected: ResolvedCollaborationRepositoryPolicy,
): CollaborationBindingSnapshot {
  const binding = space.current_binding;
  if (
    space.status !== 'bound' ||
    binding === null ||
    binding.repo_cwd === null ||
    binding.worktree.mode !== 'managed'
  ) {
    throw new Error('collaboration space has no managed repository binding');
  }
  const policy = binding.repository_policy;
  const compatibleStaticPolicy =
    policy === undefined &&
    expected.source === 'static' &&
    binding.repo_cwd === expected.repo_cwd &&
    binding.worktree.base_ref === expected.base_ref;
  if (
    (!compatibleStaticPolicy &&
      (policy === undefined ||
        policy.source !== expected.source ||
        policy.logical_key !== expected.logical_key ||
        policy.binding_revision !== expected.binding_revision ||
        policy.fingerprint !== expected.fingerprint)) ||
    binding.repo_cwd !== expected.repo_cwd ||
    binding.worktree.base_ref !== expected.base_ref
  ) {
    throw new Error('collaboration space repository binding does not match the task');
  }
  return {
    space_name: space.space_name,
    generation: binding.generation,
    repository: structuredClone(expected),
    leader_agent_runtime: binding.leader_agent_runtime,
    identity: binding.identity,
  };
}
