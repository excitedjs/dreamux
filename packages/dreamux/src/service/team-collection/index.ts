import type {
  AgentRuntimeMcpServer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type {
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import { requireLifecycleText } from '../agent-entity/types.js';
import type { AgentEntityIdentity } from '../agent-entity/types.js';
import type { SchedulerCommands } from '../scheduler/service.js';
import type { ChannelRouteOwner } from '../channel-service/index.js';
import type { TaskTeamSubmissionBridge } from '../task-runtime-submission.js';
import type { TaskOperationInvocation } from '../task-runtime-submission.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import { TeamStore } from './store.js';
import type {
  TeamCreateInput,
  TeamCreateResult,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamLeaderLease,
  TeamLeaderSendResult,
  TeamListRow,
  TeamRecord,
  TaskTeamFinalizationResult,
  TaskTeamProvisionInput,
} from './types.js';
import { validateTeamId } from './types.js';
import { prepareTeamWorkspace } from './workspace.js';
import {
  assertTaskFinalizationMatches,
  assertTaskProvisioningMatches,
  existingTaskTeamResult,
} from './task-provisioning.js';
import { teamErrorInfo } from './format.js';
import { TeamCollectionReadModel } from './history.js';
import { dedupe } from './in-flight.js';
import {
  TeamService,
  type TeamSchedulerLifecycle,
  type TeamServiceDeps,
} from '../team-service/index.js';

export interface TeamCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  /**
   * The dispatcher's identity + turns store pair (issue #233 R4). Supplied by
   * `DispatcherService` (the same pair the dispatcher agent + dispatcher-scope
   * collection share) and forwarded into every per-team collection so no team
   * news its own. Read-path probes (`leaderState` / `memberCount`) read the
   * identity store directly, never a throwaway collection. The stores are
   * stateless (paths by role + team_id), so one pair safely serves all scopes.
   */
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  // Shared per-dispatcher deps `DispatcherService` always supplies; forwarded
  // unchanged into each team's own collection so it stays topology-free (#233).
  router: CompletionRouter;
  initiatorFor: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation?: <T>(task: () => Promise<T>) => Promise<T>;
  adminSocketPath: string;
  /**
   * Build a team_leader's channel-egress MCP descriptors from the dispatcher's
   * live channels. Channels are dispatcher-owned, so the team layer only asks
   * for its own leader's set — it never reaches into the channel layer itself.
   */
  leaderChannelDescriptors: (input: {
    teamId: string;
    leaderName: string;
  }) => readonly AgentRuntimeMcpServer[];
  taskSubmissionBridgeFor?: (teamId: string) => TaskTeamSubmissionBridge | null;
  log: DreamuxLogger;
}

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. Owns the team store + worktree manager; exposes
 * `create` / `list` / `history` and open-Team route-owner facts. `get(teamId)` is a get-or-rebuild factory (like `Dispatchers.get`
 * / `TeammateCollection.entityFor`): cached live {@link TeamService} if any, else
 * rebuilt from the persisted {@link TeamRecord} and cached. Each `TeamService`
 * OWNS its per-team {@link TeammateCollection} (`teamScope: team_id`) built from
 * the shared deps forwarded here; live cache ≡ process lifetime, `dissolve`
 * evicts so a later `get` reads `status: closed`.
 */
export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store = new TeamStore();
  private readonly worktrees: WorktreeManager;
  private readonly readModel: TeamCollectionReadModel;
  /** Live {@link TeamService} cache keyed by team id (issue #233 factory). */
  private readonly cache = new Map<string, TeamService>();
  /**
   * Owner-only scheduler lifecycle capabilities for cached Teams. `TeamService`
   * exposes only `SchedulerCommands`; start/stop stay inside this collection.
   */
  private readonly schedulerLifecycles = new Map<
    string,
    {
      service: TeamService;
      lifecycle: TeamSchedulerLifecycle;
    }
  >();
  /**
   * Every service constructed by this collection, including a create/rebuild
   * attempt that failed before entering the live cache. Shutdown must retain
   * ownership of those partially booted runtimes so it can retry cleanup.
   */
  private readonly materialized = new Set<TeamService>();
  /** In-flight `create` per team id (concurrent same-id creates share one). */
  private readonly creating = new Map<string, Promise<TeamCreateResult>>();
  /** In-flight cache-miss `get`, so a cold-cache race rebuilds one TeamService
   * (one leader runtime), not two (issue #233 concurrency guard). */
  private readonly rebuilding = new Map<string, Promise<TeamService>>();
  /**
   * Serializes route publication with the start of Team closure. The closing
   * marker is deliberately separate from persisted Team status: it is a
   * process-lifetime write fence, while `closed` remains the durable fact.
   */
  private readonly routeLifecycle = new KeyedAsyncQueue();
  private readonly routeClosing = new Set<string>();

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.readModel = new TeamCollectionReadModel(
      this.dispatcherId,
      this.store,
      opts.identities,
    );
  }

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    const teamId = validateTeamId(input.name);
    return dedupe(this.creating, teamId, () =>
      this.routeLifecycle.run(teamId, async () => {
        if (this.routeClosing.has(teamId)) {
          throw new TeamUnavailableError(
            `Team ${JSON.stringify(teamId)} is closing`,
          );
        }
        return this.doCreate(input, teamId);
      }),
    );
  }

  /**
   * Idempotently materialize a task-owned Team. Unlike the public create path,
   * this repairs the recoverable crash window where a `starting` Team row was
   * committed before its leader identity.
   */
  async ensureProvisioned(input: TaskTeamProvisionInput): Promise<TeamCreateResult> {
    const teamId = validateTeamId(input.name);
    return dedupe(this.creating, teamId, () =>
      this.routeLifecycle.run(teamId, async () => {
        if (this.routeClosing.has(teamId)) {
          throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} is closing`);
        }
        requireLifecycleText(input.intent, 'Team create intent');
        const existing = await this.store.get(this.dispatcherId, teamId);
        if (existing?.status === 'closed') {
          throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} is closed`);
        }
        const workspace = await prepareTeamWorkspace({
          config: this.opts.config,
          dispatcherId: this.dispatcherId,
          worktrees: this.worktrees,
          teamId,
          request: input,
        });
        if (existing !== null) {
          assertTaskProvisioningMatches(existing, input, workspace);
        }
        const identity = existing === null
          ? null
          : await this.opts.identities.leaderIdentity(this.dispatcherId, teamId);
        if (existing !== null && identity !== null) {
          const service = await this.get(teamId);
          await service.ensureRouteReady();
          return existingTaskTeamResult(service);
        }
        if (existing !== null && existing.status !== 'starting') {
          throw new Error(`Team ${JSON.stringify(teamId)} has no recoverable leader`);
        }
        const { service, schedulerLifecycle, leaderResult } =
          await TeamService.createNew(
            { ...this.depsBase(), evict: (evicted) => this.evict(teamId, evicted) },
            {
              teamId,
              name: input.name,
              leaderAgentRuntime: input.leaderAgentRuntime,
              intent: input.intent,
              ...(input.identity !== undefined ? { identity: input.identity } : {}),
              ...(input.skillSources !== undefined
                ? { skillSources: input.skillSources }
                : {}),
              workspace,
              existing,
            },
          );
        this.cache.set(teamId, service);
        this.schedulerLifecycles.set(teamId, { service, lifecycle: schedulerLifecycle });
        return {
          team: service.view(),
          leader: leaderResult.teammate,
          member_count: await service.memberCount(),
          turn: null,
        };
      }),
    );
  }

  private async doCreate(
    input: TeamCreateInput,
    teamId: string,
  ): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const existing = await this.store.get(this.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const workspace = await prepareTeamWorkspace({
      config: this.opts.config,
      dispatcherId: this.dispatcherId,
      worktrees: this.worktrees,
      teamId,
      request: input,
    });
    const { service, schedulerLifecycle, leaderResult } =
      await TeamService.createNew(
        { ...this.depsBase(), evict: (evicted) => this.evict(teamId, evicted) },
        {
          teamId,
          name: input.name,
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          leaderAgentRuntime: input.leaderAgentRuntime,
          intent: input.intent,
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
          ...(input.skillSources !== undefined
            ? { skillSources: input.skillSources }
            : {}),
          workspace,
          existing,
        },
      );
    // Cache the live service so later `get`s reuse this leader + collection and
    // record mutations route through it (issue #233).
    this.cache.set(teamId, service);
    this.schedulerLifecycles.set(teamId, {
      service,
      lifecycle: schedulerLifecycle,
    });
    return {
      team: service.view(),
      leader: leaderResult.teammate,
      member_count: await service.memberCount(),
      turn: leaderResult.turn,
    };
  }

  async list(): Promise<TeamListRow[]> {
    return this.readModel.list();
  }

  async history(
    input: TeamHistoryQuery,
  ): Promise<TeamHistoryResult> {
    return this.readModel.history(input);
  }

  /** Get-or-rebuild the team's service; a cold-cache miss is deduped (#233). */
  async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    return dedupe(this.rebuilding, id, async () =>
      this.serviceFor(await this.mustTeam(id)),
    );
  }

  async requireOpenTeamRouteOwner(teamId: string): Promise<ChannelRouteOwner> {
    const team = await this.mustOpenTeam(teamId);
    return {
      kind: 'team',
      teamName: team.team_id,
      leaderName: team.leader_name,
    };
  }

  /**
   * Return a route owner only after the persisted Team can be materialized and
   * its TeamLeader can start. Collaboration provisioning uses this stronger fact
   * so a stale `starting`/`running` row is never enough to publish an active
   * channel route.
   */
  async requireRoutableTeamOwner(teamId: string): Promise<ChannelRouteOwner> {
    const id = validateTeamId(teamId);
    if (this.routeClosing.has(id)) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
    }
    await this.mustOpenTeam(id);
    const service = await this.get(id);
    await service.ensureRouteReady();
    if (this.routeClosing.has(id)) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
    }
    return {
      kind: 'team',
      teamName: id,
      leaderName: service.leaderName,
    };
  }

  /**
   * Hold a process-local route lease while publishing or repairing a route.
   * A concurrent Team close cannot announce its closing fence until `task`
   * finishes; once closing is announced, later leases fail before mutation.
   */
  async withRoutableTeamOwner<T>(
    teamId: string,
    task: (owner: ChannelRouteOwner) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      if (this.routeClosing.has(id)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      return task(await this.requireRoutableTeamOwner(id));
    });
  }

  async teamLeaderLease(teamId: string): Promise<TeamLeaderLease> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const service = await this.currentOpenService(id);
      return { teamId: id, leaderName: service.leaderName };
    });
  }

  async withTeamLeaderLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.routeLifecycle.run(id, async () => {
      const service = await this.currentOpenService(id);
      if (service.leaderName !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      return task(service);
    });
  }

  /**
   * Announce Team closure before cross-service route cleanup, then keep the
   * fence raised until the caller has durably closed (or failed to close) the
   * Team. Route cleanup itself must not run under the queue lock because it
   * takes per-target locks in the opposite domain.
   */
  async withTeamRouteClosing<T>(
    teamId: string,
    task: (owner: ChannelRouteOwner) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(teamId);
    const owner = await this.routeLifecycle.run(id, async () => {
      if (this.routeClosing.has(id)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      const current = await this.requireOpenTeamRouteOwner(id);
      this.routeClosing.add(id);
      return current;
    });
    try {
      return await task(owner);
    } finally {
      await this.routeLifecycle.run(id, async () => {
        this.routeClosing.delete(id);
      });
    }
  }

  async sendToLeader(
    teamId: string,
    input: {
      prompt: string;
      intent?: string;
      initiator: CompletionInitiator;
      taskInvocation?: TaskOperationInvocation;
    },
  ): Promise<TeamLeaderSendResult> {
    const id = validateTeamId(teamId);
    await this.mustOpenTeam(id);
    return (await this.get(id)).sendToLeader(input);
  }

  async isOpenTeam(teamId: string): Promise<boolean> {
    const team = await this.store.get(this.dispatcherId, validateTeamId(teamId));
    return team !== null && team.status !== 'closed';
  }

  /** True while Core owns this Team as a strict task attempt execution target. */
  hasTaskAttempt(teamId: string): boolean {
    const bridgeFor = this.opts.taskSubmissionBridgeFor;
    return bridgeFor !== undefined && bridgeFor(validateTeamId(teamId)) !== null;
  }

  async abortProvisioning(
    input: TaskTeamProvisionInput,
  ): Promise<import('../agent-entity/types.js').AgentEntityWorktreeIdentity> {
    const teamId = validateTeamId(input.name);
    if (input.repoCwd === undefined || input.worktree?.mode !== 'managed') {
      throw new Error('task Team provisional cleanup requires a managed repository');
    }
    const existing = await this.store.get(this.dispatcherId, teamId);
    if (existing !== null) {
      const leader = await this.opts.identities.leaderIdentity(
        this.dispatcherId,
        teamId,
      );
      if (existing.status !== 'starting' || leader !== null) {
        throw new Error(`Team ${JSON.stringify(teamId)} is already materialized`);
      }
      if (
        existing.repo_cwd !== input.repoCwd ||
        existing.worktree.mode !== 'managed' ||
        existing.worktree.slug !== (input.worktree.slug ?? `team-${teamId}`) ||
        existing.worktree.base_ref !== (input.worktree.base_ref ?? 'HEAD')
      ) {
        throw new Error(`Team ${JSON.stringify(teamId)} conflicts with cleanup intent`);
      }
      const cleaned = await this.worktrees.cleanup({
        source_cwd: existing.repo_cwd,
        source_repo: existing.source_repo,
        worktree: existing.worktree,
      });
      await this.store.update(existing, {
        status: 'closed',
        closedAt: Date.now(),
        closeNote: 'Task provisioning was terminal before TeamLeader creation',
        worktree: cleaned,
      });
      return cleaned;
    }
    return this.worktrees.cleanupProvisional({
      dispatcherWorkspace: await dispatcherWorkspace(
        this.opts.config,
        this.dispatcherId,
      ),
      cwd: input.repoCwd,
      slug: input.worktree.slug ?? `team-${teamId}`,
      baseRef: input.worktree.base_ref ?? null,
      ...(input.worktree.branch !== undefined
        ? { branch: input.worktree.branch }
        : {}),
    });
  }

  /**
   * Idempotently converge every task-owned Team shape without requiring a live
   * TeamLeader: absent provisional worktree, orphan starting row, materialized
   * Team, and already-closed row all share this record-level operation.
   */
  async finalizeTaskProvisioning(
    input: TaskTeamProvisionInput,
  ): Promise<TaskTeamFinalizationResult> {
    const teamId = validateTeamId(input.name);
    if (input.repoCwd === undefined || input.worktree?.mode !== 'managed') {
      throw new Error('task Team finalization requires a managed repository');
    }
    return this.routeLifecycle.run(teamId, async () => {
      this.routeClosing.add(teamId);
      try {
        const existing = await this.store.get(this.dispatcherId, teamId);
        if (existing === null) {
          const cleanup = await this.worktrees.cleanupProvisional({
            dispatcherWorkspace: await dispatcherWorkspace(
              this.opts.config,
              this.dispatcherId,
            ),
            cwd: input.repoCwd!,
            slug: input.worktree!.slug ?? `team-${teamId}`,
            baseRef: input.worktree!.base_ref ?? null,
            ...(input.worktree!.branch !== undefined
              ? { branch: input.worktree!.branch }
              : {}),
          });
          return { team_status: 'absent', cleanup };
        }
        assertTaskFinalizationMatches(existing, input);
        if (existing.status !== 'closed') {
          const leader = await this.opts.identities.leaderIdentity(
            this.dispatcherId,
            teamId,
          );
          if (leader !== null) {
            await (await this.get(teamId)).dissolve({
              teamId,
              note: 'Task attempt reached an explicit terminal state',
            });
            const closed = await this.store.get(this.dispatcherId, teamId);
            if (closed === null || closed.status !== 'closed') {
              throw new Error(`Team ${JSON.stringify(teamId)} did not close`);
            }
            return { team_status: 'closed', cleanup: closed.worktree };
          }
        }
        return this.finalizeTaskRecord(existing);
      } finally {
        this.routeClosing.delete(teamId);
      }
    });
  }

  private async finalizeTaskRecord(
    record: TeamRecord,
  ): Promise<TaskTeamFinalizationResult> {
    const cleanup = record.worktree.cleanup_state === 'managed-active'
      ? await this.worktrees.cleanup({
          source_cwd: record.repo_cwd,
          source_repo: record.source_repo,
          worktree: record.worktree,
        })
      : record.worktree;
    const closed = await this.store.update(record, {
      status: 'closed',
      closedAt: record.closed_at ?? Date.now(),
      closeNote: record.close_note ??
        'Task provisioning was terminal before TeamLeader creation',
      worktree: cleanup,
    });
    const identities = [
      await this.opts.identities.leaderIdentity(this.dispatcherId, record.team_id),
      ...await this.opts.identities.list(this.dispatcherId, record.team_id),
    ].filter((identity): identity is AgentEntityIdentity => identity !== null);
    for (const identity of identities) {
      await this.opts.identities.update(identity, { worktree: cleanup });
    }
    this.cache.delete(record.team_id);
    this.schedulerLifecycles.delete(record.team_id);
    return { team_status: 'closed', cleanup: closed.worktree };
  }

  private async currentOpenService(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    if (this.routeClosing.has(id)) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
    }
    await this.mustOpenTeam(id);
    const service = await this.get(id);
    if (this.routeClosing.has(id)) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
    }
    return service;
  }

  /** Rebuild a team's live service from its record and cache it (issue #233). */
  private async serviceFor(record: TeamRecord): Promise<TeamService> {
    const { service, schedulerLifecycle } = await TeamService.rebuild(
      {
        ...this.depsBase(),
        evict: (evicted) => this.evict(record.team_id, evicted),
      },
      record,
    );
    this.cache.set(record.team_id, service);
    this.schedulerLifecycles.set(record.team_id, {
      service,
      lifecycle: schedulerLifecycle,
    });
    return service;
  }

  private evict(teamId: string, expectedService: TeamService): void {
    if (this.cache.get(teamId) !== expectedService) return;
    this.cache.delete(teamId);
    const lifecycle = this.schedulerLifecycles.get(teamId);
    if (lifecycle?.service === expectedService) {
      this.schedulerLifecycles.delete(teamId);
    }
  }

  private depsBase(): Omit<TeamServiceDeps, 'evict'> {
    return {
      dispatcherId: this.dispatcherId,
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      worktrees: this.worktrees,
      identities: this.opts.identities,
      turnsStore: this.opts.turnsStore,
      router: this.opts.router,
      initiatorFor: this.opts.initiatorFor,
      isShuttingDown: this.opts.isShuttingDown,
      admitOperation: this.opts.admitOperation ?? ((task) => task()),
      store: this.store,
      adminSocketPath: this.opts.adminSocketPath,
      leaderChannelDescriptors: this.opts.leaderChannelDescriptors,
      ...(this.opts.taskSubmissionBridgeFor !== undefined
        ? { taskSubmissionBridgeFor: this.opts.taskSubmissionBridgeFor }
        : {}),
      trackMaterialized: (service) => this.materialized.add(service),
      log: this.opts.log,
    };
  }

  private async mustTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(this.dispatcherId, validateTeamId(teamId));
    if (team === null) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} does not exist`);
    }
    return team;
  }

  private async mustOpenTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.mustTeam(teamId);
    if (team.status === 'closed') {
      throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} is closed`);
    }
    return team;
  }
  async scheduler(teamId: string): Promise<SchedulerCommands> {
    await this.mustOpenTeam(teamId);
    return (await this.get(teamId)).scheduler;
  }

  async startSchedulers(): Promise<void> {
    const teams = await this.store.list(this.dispatcherId);
    for (const team of teams) {
      if (team.status === 'closed') continue;
      try {
        const service = await this.get(team.team_id);
        const schedulerLifecycle = this.schedulerLifecycles.get(service.id);
        if (
          schedulerLifecycle === undefined ||
          schedulerLifecycle.service !== service
        ) {
          throw new Error(
            `Team ${JSON.stringify(service.id)} scheduler lifecycle is unavailable`,
          );
        }
        await schedulerLifecycle.lifecycle.start();
      } catch (err) {
        this.opts.log.error(
          {
            dispatcher_id: this.dispatcherId,
            team_id: team.team_id,
            err: teamErrorInfo(err),
          },
          'TeamLeader scheduler start failed',
        );
      }
    }
  }
  stopSchedulers(): void {
    for (const schedulerLifecycle of this.schedulerLifecycles.values()) {
      schedulerLifecycle.lifecycle.stop();
    }
  }

  /**
   * Stop every live team's runtimes on server shutdown (issue #233). The
   * materialized set also retains failed create/rebuild attempts that never
   * reached the live cache, so their partially booted runtimes remain owned.
   * This never reads the durable store or lazily starts a runtime.
   */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.materialized].map((service) => service.stopAll()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'multiple Team runtimes failed to stop');
    }
  }
}

export class TeamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamUnavailableError';
  }
}
