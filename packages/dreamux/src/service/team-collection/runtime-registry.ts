import type { CompletionInitiator } from '../completion-router/index.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import {
  TeamService,
  type TeamServiceDeps,
} from '../team-service/index.js';
import type { TeamSchedulerLifecycle } from '../team-service/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { teamErrorInfo } from './errors.js';
import { isActiveDissolve } from './dissolve-lifecycle.js';
import type { TeamStore } from './store.js';
import type {
  TeamCollectionOptions,
  TeamCreateAtNameInput,
  TeamCreateResult,
  TeamLeaderLease,
  TeamRecord,
} from './types.js';

interface TeamRuntimeRegistryOptions {
  dispatcherId: string;
  collection: TeamCollectionOptions;
  store: TeamStore;
  worktrees: WorktreeManager;
  routeLifecycle: KeyedAsyncQueue;
  mustTeam(teamId: string): Promise<TeamRecord>;
  admitAvailable<T>(teamId: string, task: () => Promise<T>): Promise<T>;
  completionInitiator(
    teamId: string,
    delegate: CompletionInitiator,
  ): CompletionInitiator;
  withTeamLeaderLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T>;
}

/** Owns materialized TeamService instances and their private lifecycle handles. */
export class TeamRuntimeRegistry {
  private readonly cache = new Map<string, TeamService>();
  private readonly schedulers = new Map<
    string,
    { service: TeamService; lifecycle: TeamSchedulerLifecycle }
  >();
  private readonly materialized = new Set<TeamService>();
  private readonly rebuilding = new Map<string, Promise<TeamService>>();

  constructor(private readonly opts: TeamRuntimeRegistryOptions) {}

  async create(
    input: TeamCreateAtNameInput,
    teamId: string,
    nameClaimToken: string,
  ): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const existing = await this.opts.store.get(this.opts.dispatcherId, teamId);
    if (existing !== null) {
      throw new Error(
        `Team ${JSON.stringify(teamId)} already exists; concrete Team names are never reused`,
      );
    }
    const workspaceRoot = await dispatcherWorkspace(
      this.opts.collection.config,
      this.opts.dispatcherId,
    );
    const workspace = input.worktree === undefined && input.repoCwd === undefined
      ? await this.opts.worktrees.prepareDefaultWorkspace({
          dispatcherWorkspace: workspaceRoot,
          slug: teamId,
          workspaceEnabled: defaultWorkspaceEnabled(
            this.opts.collection.config,
            this.opts.dispatcherId,
          ),
        })
      : await this.opts.worktrees.prepare({
          dispatcherId: this.opts.dispatcherId,
          teammateName: `team-${teamId}`,
          cwd: input.repoCwd ?? workspaceRoot,
          dispatcherWorkspace: workspaceRoot,
          request: input.worktree ?? {
            mode: 'managed',
            slug: `team-${teamId}`,
            cleanup: 'keep',
          },
        });
    const { service, schedulerLifecycle, leaderResult } =
      await TeamService.createNew(
        {
          ...this.depsBase(teamId),
          evict: (evicted) => this.evict(teamId, evicted),
        },
        {
          teamId,
          name: input.name,
          nameClaimToken,
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          leaderAgentRuntime: input.leaderAgentRuntime,
          intent: input.intent,
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
          ...(input.skillSources !== undefined
            ? { skillSources: input.skillSources }
            : {}),
          workspace,
        },
      );
    this.publish(service, schedulerLifecycle);
    return {
      team: service.view(),
      leader: leaderResult.teammate,
      member_count: await service.memberCount(),
      turn: leaderResult.turn,
    };
  }

  async get(teamId: string): Promise<TeamService> {
    const cached = this.cache.get(teamId);
    if (cached !== undefined) return cached;
    return dedupe(this.rebuilding, teamId, async () =>
      this.rebuild(await this.opts.mustTeam(teamId)),
    );
  }

  cached(teamId: string): TeamService | undefined {
    return this.cache.get(teamId);
  }

  replaceCachedRecord(teamId: string, record: TeamRecord): void {
    this.cache.get(teamId)?.replaceRecord(record);
  }

  closeAdmissionAndStopScheduler(teamId: string, service: TeamService): void {
    service.closeWorkflowAdmission();
    const scheduler = this.schedulers.get(teamId);
    if (scheduler?.service === service) scheduler.lifecycle.stop();
  }

  async stopCachedWorkflowsForClosing(teamId: string): Promise<void> {
    await this.cache.get(teamId)?.stopWorkflowsForClosing();
  }

  async reopen(teamId: string): Promise<void> {
    const service = this.cache.get(teamId);
    if (service !== undefined) await service.startWorkflowAdmission();
    await this.schedulers.get(teamId)?.lifecycle.start();
  }

  async scheduler(teamId: string): Promise<SchedulerCommands> {
    return (await this.get(teamId)).scheduler;
  }

  async startSchedulers(): Promise<void> {
    for (const team of await this.opts.store.list(this.opts.dispatcherId)) {
      if (team.status === 'closed' || isActiveDissolve(team.dissolve)) continue;
      try {
        const service = await this.get(team.team_id);
        const scheduler = this.schedulers.get(service.id);
        if (scheduler === undefined || scheduler.service !== service) {
          throw new Error(
            `Team ${JSON.stringify(service.id)} scheduler lifecycle is unavailable`,
          );
        }
        await scheduler.lifecycle.start();
      } catch (error) {
        this.opts.collection.log.error(
          {
            dispatcher_id: this.opts.dispatcherId,
            team_id: team.team_id,
            err: teamErrorInfo(error),
          },
          'TeamLeader scheduler start failed',
        );
      }
    }
  }

  async startWorkflows(): Promise<void> {
    for (const team of await this.opts.store.list(this.opts.dispatcherId)) {
      if (team.status === 'closed' || isActiveDissolve(team.dissolve)) continue;
      await (await this.get(team.team_id)).startWorkflowAdmission();
    }
  }

  async recoverWorkflows(): Promise<void> {
    for (const team of await this.opts.store.list(this.opts.dispatcherId)) {
      if (team.status === 'closed' || isActiveDissolve(team.dissolve)) continue;
      await (await this.get(team.team_id)).recoverWorkflows();
    }
  }

  closeWorkflowAdmissions(): void {
    for (const service of this.materialized) service.closeWorkflowAdmission();
  }

  /** Wake Workflow terminal waits through already-materialized Team services. */
  interruptWorkflowsForShutdown(): void {
    for (const service of this.materialized) {
      service.interruptWorkflowsForShutdown();
    }
  }

  stopSchedulers(): void {
    for (const scheduler of this.schedulers.values()) scheduler.lifecycle.stop();
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.materialized].map((service) =>
        this.opts.routeLifecycle.run(service.id, () => service.stopAll())),
    );
    throwSettledFailures(results, 'multiple Team runtimes failed to stop');
  }

  private async rebuild(record: TeamRecord): Promise<TeamService> {
    const { service, schedulerLifecycle } = await TeamService.rebuild(
      {
        ...this.depsBase(record.team_id),
        evict: (evicted) => this.evict(record.team_id, evicted),
      },
      record,
    );
    this.publish(service, schedulerLifecycle);
    return service;
  }

  private publish(
    service: TeamService,
    lifecycle: TeamSchedulerLifecycle,
  ): void {
    this.cache.set(service.id, service);
    this.schedulers.set(service.id, { service, lifecycle });
  }

  private evict(teamId: string, expectedService: TeamService): void {
    if (this.cache.get(teamId) !== expectedService) return;
    this.cache.delete(teamId);
    const scheduler = this.schedulers.get(teamId);
    if (scheduler?.service === expectedService) this.schedulers.delete(teamId);
  }

  private depsBase(teamId: string): Omit<TeamServiceDeps, 'evict'> {
    const collection = this.opts.collection;
    return {
      dispatcherId: this.opts.dispatcherId,
      config: collection.config,
      agentRuntimeProviders: collection.agentRuntimeProviders,
      worktrees: this.opts.worktrees,
      identities: collection.identities,
      turnsStore: collection.turnsStore,
      router: collection.router,
      initiatorFor: collection.initiatorFor,
      isShuttingDown: collection.isShuttingDown,
      admitOperation: collection.admitOperation ?? ((task) => task()),
      availability: {
        admit: (task) => this.opts.admitAvailable(teamId, task),
        completionInitiator: (delegate) =>
          this.opts.completionInitiator(teamId, delegate),
      },
      withTeamLeaderLease: (lease, task) =>
        this.opts.withTeamLeaderLease(lease, task),
      store: this.opts.store,
      adminSocketPath: collection.adminSocketPath,
      leaderChannelDescriptors: collection.leaderChannelDescriptors,
      trackMaterialized: (service) => this.materialized.add(service),
      log: collection.log,
      workflowLog: collection.workflowLog ?? collection.log,
      ...(collection.agentNameSuffixGenerator !== undefined
        ? { agentNameSuffixGenerator: collection.agentNameSuffixGenerator }
        : {}),
      ...(collection.workflowStopGraceMs !== undefined
        ? { workflowStopGraceMs: collection.workflowStopGraceMs }
        : {}),
    };
  }
}

function dedupe<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = start().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
