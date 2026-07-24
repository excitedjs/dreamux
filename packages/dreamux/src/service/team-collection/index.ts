import { randomUUID } from 'node:crypto';

import type {
  AgentRuntimeMcpServer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import { defaultWorkspaceEnabled } from '../../config/config.js';
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
import { KeyedAsyncQueue } from '../serial-queue.js';
import { TeamStore } from './store.js';
import type {
  TeamCreateInput,
  TeamCreateAtNameInput,
  TeamCreateResult,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamLeaderLease,
  TeamLeaderSendResult,
  TeamListRow,
  TeamNameClaim,
  TeamRecord,
  TeamRouteProjection,
} from './types.js';
import { validateTeamId } from './types.js';
import {
  clampTeamHistoryLimit,
  decodeTeamCursor,
  encodeTeamCursor,
  matchesTeamHistoryQuery,
  previewTeamText,
} from './read-helpers.js';
import type { AgentEntityIdentityStatus } from '../agent-entity/types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import {
  claimConcreteName,
  type SuffixGenerator,
} from '../name-allocator.js';
import {
  TeamService,
  type TeamSchedulerLifecycle,
  type TeamServiceDeps,
} from '../team-service/index.js';

/** Share one in-flight promise per key; a concurrent same-key call joins it. */
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
  log: DreamuxLogger;
  coreEvents?: DispatcherCoreEventPublisher;
  /** Test seam for deterministic persistent-claim collision coverage. */
  nameSuffixGenerator?: SuffixGenerator;
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
  private readonly store: TeamStore;
  private readonly worktrees: WorktreeManager;
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
    this.store = new TeamStore(opts.coreEvents);
  }

  async claimName(
    namePrefix: string,
    claimToken: string = randomUUID(),
  ): Promise<TeamNameClaim> {
    requireLifecycleText(namePrefix, 'Team name prefix');
    const name = await claimConcreteName({
      kind: 'team',
      base: namePrefix,
      claim: (candidate) =>
        this.store.claimName(this.dispatcherId, candidate, claimToken),
      ...(this.opts.nameSuffixGenerator !== undefined
        ? { generateSuffix: this.opts.nameSuffixGenerator }
        : {}),
    });
    return { name, token: claimToken };
  }

  async createFromPrefix(input: TeamCreateInput): Promise<TeamCreateResult> {
    const { namePrefix, ...options } = input;
    const claim = await this.claimName(namePrefix);
    return this.create({
      ...options,
      name: claim.name,
      nameClaimToken: claim.token,
    });
  }

  /**
   * Create one Team at a concrete name already allocated by the caller. The
   * name is still checked against all persisted Teams and is never reusable.
   */
  async create(input: TeamCreateAtNameInput): Promise<TeamCreateResult> {
    const teamId = validateTeamId(input.name);
    if (this.routeClosing.has(teamId)) {
      throw new TeamUnavailableError(
        `Team ${JSON.stringify(teamId)} is closing`,
      );
    }
    const claimToken = input.nameClaimToken ?? randomUUID();
    if (!(await this.store.claimName(this.dispatcherId, teamId, claimToken))) {
      throw new Error(
        `Team ${JSON.stringify(teamId)} already exists or its concrete name is claimed by another owner; ` +
          'concrete Team names are never reused',
      );
    }
    return this.routeLifecycle.run(teamId, async () => {
      if (this.routeClosing.has(teamId)) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(teamId)} is closing`,
        );
      }
      return this.doCreate(input, teamId, claimToken);
    });
  }

  private async doCreate(
    input: TeamCreateAtNameInput,
    teamId: string,
    nameClaimToken: string,
  ): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const existing = await this.store.get(this.dispatcherId, teamId);
    if (existing !== null) {
      throw new Error(
        `Team ${JSON.stringify(teamId)} already exists; concrete Team names are never reused`,
      );
    }
    const workspaceRoot = await dispatcherWorkspace(
      this.opts.config,
      this.dispatcherId,
    );
    const workspace =
      input.worktree === undefined && input.repoCwd === undefined
        ? await this.worktrees.prepareDefaultWorkspace({
            dispatcherWorkspace: workspaceRoot,
            slug: teamId,
            workspaceEnabled: defaultWorkspaceEnabled(
              this.opts.config,
              this.dispatcherId,
            ),
          })
        : await this.worktrees.prepare({
            dispatcherId: this.dispatcherId,
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
        { ...this.depsBase(), evict: (evicted) => this.evict(teamId, evicted) },
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
    const teams = await this.store.list(this.dispatcherId);
    const out: TeamListRow[] = [];
    for (const team of teams) {
      out.push(await this.listRow(team));
    }
    return out;
  }

  async history(
    input: TeamHistoryQuery,
  ): Promise<TeamHistoryResult> {
    const teams = await this.store.list(this.dispatcherId);
    const rows: TeamHistoryRow[] = [];
    for (const team of teams) {
      const row = await this.historyRow(team);
      if (matchesTeamHistoryQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        b.created_at - a.created_at ||
        a.team_name.localeCompare(b.team_name),
    );
    const start = input.cursor !== undefined ? decodeTeamCursor(input.cursor) : 0;
    const limit = clampTeamHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeTeamCursor(next) : null,
    };
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
    const projection = await this.requireRoutableTeamProjection(teamId);
    return {
      kind: 'team',
      teamName: projection.team_name,
      leaderName: projection.leader_name,
    };
  }

  async requireRoutableTeamProjection(
    teamId: string,
  ): Promise<TeamRouteProjection> {
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
    return service.routeProjection();
  }

  /**
   * Hold a process-local route lease while publishing or repairing a route.
   * A concurrent Team close cannot announce its closing fence until `task`
   * finishes; once closing is announced, later leases fail before mutation.
   */
  async withRoutableTeamProjection<T>(
    teamId: string,
    task: (projection: TeamRouteProjection) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      if (this.routeClosing.has(id)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      return task(await this.requireRoutableTeamProjection(id));
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
   * Hold the Team route lifecycle lease while proving both route readiness and
   * the descriptor-bound TeamLeader generation used for route publication.
   */
  async withRoutableTeamLeaderLease<T>(
    lease: TeamLeaderLease,
    task: (projection: TeamRouteProjection) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.routeLifecycle.run(id, async () => {
      if (this.routeClosing.has(id)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      const service = await this.currentOpenService(id);
      if (service.leaderName !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      await service.ensureRouteReady();
      if (this.routeClosing.has(id) || service.leaderName !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer routable`,
        );
      }
      return task(service.routeProjection());
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

  async hasTeam(teamId: string): Promise<boolean> {
    return (
      await this.store.get(this.dispatcherId, validateTeamId(teamId))
    ) !== null;
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
      trackMaterialized: (service) => this.materialized.add(service),
      log: this.opts.log,
    };
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
    };
  }

  private async historyRow(team: TeamRecord): Promise<TeamHistoryRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_agent_runtime: team.leader_agent_runtime,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      close_note: team.close_note,
      close_note_preview:
        team.close_note !== null ? previewTeamText(team.close_note) : null,
    };
  }

  private async leaderState(
    team: TeamRecord,
  ): Promise<AgentEntityIdentityStatus | null> {
    // Read-only probe straight from the shared identity store (issue #233 R4):
    // the leader lives at the team root, so the get is team-scoped. Equivalent to
    // the old throwaway-collection `status(name)` — that probe held no entities,
    // so its projection was already just `identity.status` with no live runtime.
    // The `.catch(() => null)` matches the old `status(...).catch(() => null)`:
    // this is a scan probe, so one unreadable team record (malformed leader_name,
    // legacy state, IO error) must degrade to a null leader_state for that row,
    // not throw and poison the whole list/history scan.
    const leader = await this.opts.identities
      .get(this.dispatcherId, team.leader_name, team.team_id)
      .catch(() => null);
    return leader?.status ?? null;
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    // Members-only roster, read straight from the shared identity store (issue
    // #233 R4): a team-scope list returns only that team's members. Equivalent to
    // the old throwaway-collection `list().length` — same store call, no entities.
    return (await this.opts.identities.list(this.dispatcherId, team.team_id))
      .length;
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
          { dispatcher_id: this.dispatcherId, team_id: team.team_id, err: errInfo(err) },
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

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
