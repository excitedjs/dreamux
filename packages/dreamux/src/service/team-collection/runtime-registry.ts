import type { TeamStateTeammateSummary } from '@excitedjs/dreamux-types';

import type { CompletionInitiator } from '../completion-router/index.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import type { KeyedAsyncQueue } from '../serial-queue.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { throwSettledFailures } from '../shutdown-errors.js';
import { TeamService } from '../team-service/index.js';
import type {
  TeamSchedulerLifecycle,
  TeamServiceDeps,
} from '../team-service/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { teamErrorInfo } from './errors.js';
import { isActiveDissolve } from './dissolve-lifecycle.js';
import { readTeamRoster } from './roster-reader.js';
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
  /** This Team's own leader as a generation-bound completion recipient. */
  leaderCompletionInitiator(teamId: string): Promise<CompletionInitiator | null>;
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

  /**
   * Create one Team at this candidate name, or report the name as taken.
   *
   * `null` means a valid Team record already occupies the candidate — the
   * caller allocates another one. Nothing was created and no workspace side
   * effect survives beyond the prepared worktree.
   */
  async create(
    input: TeamCreateAtNameInput,
    teamId: string,
  ): Promise<TeamCreateResult | null> {
    requireLifecycleText(input.intent, 'Team create intent');
    // A cheap early-out before the expensive workspace preparation. The
    // authoritative answer is the exclusive record publication below, which
    // reports the same thing if the name is taken in between.
    if ((await this.opts.store.get(teamId)) !== null) return null;
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
    const created = await TeamService.createNew(
      {
        ...this.depsBase(teamId),
        evict: (evicted) => this.evict(teamId, evicted),
      },
      {
        teamId,
        name: input.name,
        ...(input.createRequest !== undefined
          ? { createRequest: input.createRequest }
          : {}),
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
    if (created === null) return null;
    const { service, schedulerLifecycle, leaderResult } = created;
    this.publish(service, schedulerLifecycle);
    return {
      team: service.view(),
      leader: leaderResult.teammate,
      member_count: await service.memberCount(),
      status: leaderResult.submission?.status ?? null,
      ...(leaderResult.submission?.error !== undefined
        ? { error: leaderResult.submission.error }
        : {}),
    };
  }

  async get(teamId: string): Promise<TeamService> {
    const cached = this.cache.get(teamId);
    if (cached !== undefined) return cached;
    const retained = [...this.materialized].find(
      (service) => service.id === teamId,
    );
    if (retained !== undefined) {
      if (!retained.leader.isRetired()) return retained;
      this.materialized.delete(retained);
    }
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
    for (const team of await this.opts.store.list()) {
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
    for (const team of await this.opts.store.list()) {
      if (team.status === 'closed' || isActiveDissolve(team.dissolve)) continue;
      await (await this.get(team.team_id)).startWorkflowAdmission();
    }
  }

  async recoverWorkflows(): Promise<void> {
    for (const team of await this.opts.store.list()) {
      if (team.status === 'closed' || isActiveDissolve(team.dissolve)) continue;
      await (await this.get(team.team_id)).recoverWorkflows();
    }
  }

  closeWorkflowAdmissions(): void {
    for (const service of this.materialized) service.closeWorkflowAdmission();
  }

  stopSchedulers(): void {
    for (const scheduler of this.schedulers.values()) scheduler.lifecycle.stop();
  }

  /**
   * Release the runtime authority this process took over its Teams.
   *
   * Only Teams this process materialized are swept, because only they hold a
   * runtime to release. The discovery pass this replaced listed every durable
   * non-closed record and materialized it first, which on a `starting` record
   * creates that Team's TeamLeader identity — durable work on the stop path,
   * done to entities the run never started.
   */
  async stopForHost(): Promise<void> {
    const services = [...this.materialized];
    const results = await Promise.allSettled(
      // The containment root publishes its aggregate admission fence before
      // this sweep. Do not hold a Team route lock while releasing members:
      // their captured completion delivery may resolve the same TeamLeader
      // through that route before the leader itself is released.
      services.map((service) => service.stopForHost()),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        this.evict(services[index]!.id, services[index]!);
      }
    });
    throwSettledFailures(results, 'multiple Team runtimes failed to stop');
  }

  /**
   * One Team's complete contained-Agent summary, for the aggregate event.
   *
   * A materialized Team answers for itself: it owns those Agents, and its
   * projection is current by construction. Any other Team is read from the
   * authoritative identity stores instead of being reported as empty, which in
   * that event would state that the Team has no Agents at all.
   *
   * The cache answers first because it is keyed and replacement-correct. A
   * Team still being created is not cached yet — it publishes its own
   * `running` transition before creation returns — and `materialized` is the
   * earlier exact fact: the service owns live resources from that moment.
   *
   * Reading only. It must not materialize a Team: the caller runs inside the
   * Team store's own write queue, which materialization writes through.
   */
  async roster(
    team: TeamRecord,
  ): Promise<readonly TeamStateTeammateSummary[] | null> {
    const cached = this.cache.get(team.team_id);
    if (cached !== undefined) return cached.teammatesSummary();
    for (const service of this.materialized) {
      if (service.id === team.team_id) return service.teammatesSummary();
    }
    return readTeamRoster({
      teamRoot: this.opts.store.teamRoot(team.team_id),
      record: team,
      log: this.opts.collection.log,
    });
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
    this.materialized.delete(expectedService);
    if (this.cache.get(teamId) !== expectedService) return;
    this.cache.delete(teamId);
    const scheduler = this.schedulers.get(teamId);
    if (scheduler?.service === expectedService) this.schedulers.delete(teamId);
  }

  private depsBase(
    teamId: string,
  ): Omit<TeamServiceDeps<TeamService>, 'evict'> {
    const collection = this.opts.collection;
    return {
      dispatcherId: this.opts.dispatcherId,
      config: collection.config,
      agentRuntimeProviders: collection.agentRuntimeProviders,
      worktrees: this.opts.worktrees,
      // Each Team gets its own already-resolved root; nothing below rebuilds it.
      teamRoot: this.opts.store.teamRoot(teamId),
      names: collection.names,
      admissions: collection.admissions,
      ...(collection.conversationProjection !== undefined
        ? { conversationProjection: collection.conversationProjection }
        : {}),
      completionDelivery: collection.completionDelivery,
      leaderCompletionInitiator: collection.dispatcherCompletionInitiator,
      teamMateCompletionInitiator: () =>
        this.opts.leaderCompletionInitiator(teamId),
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
      leaderMcp: collection.leaderMcp,
      trackMaterialized: (service) => this.materialized.add(service),
      ...(collection.coreEvents !== undefined
        ? { coreEvents: collection.coreEvents }
        : {}),
      log: collection.log,
      workflowLog: collection.workflowLog ?? collection.log,
      ...(collection.agentNameSuffixGenerator !== undefined
        ? { agentNameSuffixGenerator: collection.agentNameSuffixGenerator }
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
