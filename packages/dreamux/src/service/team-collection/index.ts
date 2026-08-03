import { randomUUID } from 'node:crypto';

import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { WorktreeManager } from '../worktree/manager.js';
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
  AcceptedTeamDissolve,
  AcceptedTeamLogicalClose,
  TeamDissolveCleanupPendingResult,
  TeamDissolveRequest,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamLeaderLease,
  TeamLeaderSendResult,
  TeamListRow,
  TeamNameClaim,
  TeamRecord,
  TeamRouteProjection,
  TeamLogicalCloseExecutor,
  TeamSummary,
} from './types.js';
import { validateTeamId } from './types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import {
  claimConcreteName,
  type SuffixGenerator,
} from '../name-allocator.js';
import {
  TeamService,
} from '../team-service/index.js';
import {
  TeamDissolveFailedError,
  TeamUnavailableError,
} from './errors.js';
import { isActiveDissolve } from './dissolve-lifecycle.js';
import { TeamDissolveController } from './dissolve-controller.js';
import { TeamCollectionReadModel } from './read-model.js';
import { TeamRuntimeRegistry } from './runtime-registry.js';

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
  trackAcceptedOperation?: <T>(task: () => Promise<T>) => Promise<T>;
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
  workflowLog?: DreamuxLogger;
  coreEvents?: DispatcherCoreEventPublisher;
  nameSuffixGenerator?: SuffixGenerator;
  agentNameSuffixGenerator?: SuffixGenerator;
}

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. Owns the team store + worktree manager; exposes
 * `create` / `list` / `history` and open-Team route-owner facts. `get(teamId)` is a get-or-rebuild factory (like `Dispatchers.get`
 * / `TeammateCollection.entityFor`): cached live {@link TeamService} if any, else
 * rebuilt from the persisted {@link TeamRecord} and cached. Each `TeamService`
 * OWNS its per-team {@link TeammateCollection} (`teamScope: team_id`) built from
 * the shared deps forwarded here. Closed services may remain cached for read
 * projections; durable status plus the shared fence prevents reuse, and
 * physical-cleanup completion may evict the cache entry.
 */
export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store: TeamStore;
  private readonly worktrees: WorktreeManager;
  /**
   * Serializes route publication with the start of Team closure. The closing
   * marker is deliberately separate from persisted Team status: it is a
   * process-lifetime write fence, while `closed` remains the durable fact.
   */
  private readonly routeLifecycle = new KeyedAsyncQueue();
  private readonly routeClosing = new Set<string>();
  private readonly dissolves: TeamDissolveController;
  private readonly reads: TeamCollectionReadModel;
  private readonly runtimes: TeamRuntimeRegistry;

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.store = new TeamStore(opts.coreEvents);
    this.reads = new TeamCollectionReadModel({
      dispatcherId: this.dispatcherId,
      store: this.store,
      identities: opts.identities,
    });
    this.runtimes = new TeamRuntimeRegistry({
      dispatcherId: this.dispatcherId,
      collection: opts,
      store: this.store,
      worktrees: this.worktrees,
      routeLifecycle: this.routeLifecycle,
      mustTeam: (teamId) => this.mustTeam(teamId),
      admitAvailable: (teamId, task) =>
        this.withTeamAvailable(teamId, () => task()),
      completionInitiator: (teamId, delegate) =>
        this.completionInitiatorThroughAvailability(
          teamId,
          (_service, completion) => delegate.completionInput(completion),
        ),
      withTeamLeaderLease: (lease, task) =>
        this.withTeamLeaderLease(lease, task),
    });
    this.dissolves = new TeamDissolveController({
      dispatcherId: this.dispatcherId,
      store: this.store,
      worktrees: this.worktrees,
      routeLifecycle: this.routeLifecycle,
      log: opts.log,
      isShuttingDown: opts.isShuttingDown,
      ...(opts.trackAcceptedOperation !== undefined
        ? { trackAcceptedOperation: opts.trackAcceptedOperation }
        : {}),
      mustTeam: (teamId) => this.mustTeam(teamId),
      getService: (teamId) => this.get(teamId),
      activateClosing: (record, service) =>
        this.activateTeamClosingFence(record, service),
      endClosing: (teamId, reopen) => this.endTeamClosing(teamId, reopen),
      replaceCachedRecord: (teamId, record) =>
        this.runtimes.replaceCachedRecord(teamId, record),
      assertNewCloseAvailable: (teamId) => {
        if (this.routeClosing.has(teamId)) {
          throw new TeamUnavailableError(
            `Team ${JSON.stringify(teamId)} is closing`,
          );
        }
      },
    });
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
      return this.runtimes.create(input, teamId, claimToken);
    });
  }

  async list(): Promise<TeamListRow[]> {
    return this.reads.list();
  }

  async history(
    input: TeamHistoryQuery,
  ): Promise<TeamHistoryResult> {
    return this.reads.history(input);
  }

  /** Get-or-rebuild the team's service; a cold-cache miss is deduped (#233). */
  async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    return this.runtimes.get(id);
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
    return this.withTeamAvailable(id, (service) =>
      this.ensureRoutableProjection(service),
    );
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
    return this.withTeamAvailable(id, async (service) =>
      task(await this.ensureRoutableProjection(service)),
    );
  }

  async teamLeaderLease(teamId: string): Promise<TeamLeaderLease> {
    const id = validateTeamId(teamId);
    return this.withTeamAvailable(id, async (service) => {
      return { teamId: id, leaderName: service.leaderName };
    });
  }

  /** Read-safe generation lease used to construct a handle while closing. */
  async teamLeaderReadLease(teamId: string): Promise<TeamLeaderLease> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustTeam(id);
      return { teamId: id, leaderName: record.leader_name };
    });
  }

  async withTeamLeaderLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.withTeamAvailable(id, async (service) => {
      if (service.leaderName !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      return task(service);
    });
  }

  /** Generation-only read lease; durable closing keeps Team read paths alive. */
  async withTeamLeaderReadLease<T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(lease.teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustTeam(id);
      if (record.leader_name !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      return task(await this.get(id));
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
    return this.withTeamAvailable(id, async (service) => {
      if (service.leaderName !== lease.leaderName) {
        throw new TeamUnavailableError(
          `Team ${JSON.stringify(id)} generation is no longer current`,
        );
      }
      await service.ensureRouteReady();
      if (service.leaderName !== lease.leaderName) {
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
    const owner = await this.beginTeamClosing(id);
    try {
      await this.runtimes.stopCachedWorkflowsForClosing(id);
      return await task(owner);
    } finally {
      await this.endTeamClosing(id, true);
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
    return this.withTeamAvailable(id, (service) =>
      service.sendToLeader(input),
    );
  }

  async deliverToLeader(
    teamId: string,
    turn: InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
    const id = validateTeamId(teamId);
    return this.withTeamAvailable(id, (service) =>
      service.deliverToLeader(turn),
    );
  }

  /** Resolve a generation-bound completion target without exposing the leader. */
  async completionInitiatorForLeader(
    teamId: string,
  ): Promise<CompletionInitiator | null> {
    const id = validateTeamId(teamId);
    const record = await this.store.get(this.dispatcherId, id);
    if (record === null) return null;
    const leaderName = record.leader_name;
    return this.completionInitiatorThroughAvailability(
      id,
      async (service, completion) => {
        if (service.leaderName !== leaderName) {
          return {
            status: 'unsupported',
            reason: 'TeamLeader generation is no longer current',
          };
        }
        return service.leader.completionInput(completion);
      },
    );
  }

  /**
   * Persist and fence one Team dissolve before returning an accepted handle.
   * The route lifecycle queue atomically orders writer capture, both safety
   * preconditions, durable acceptance, and the shared availability fence.
   */
  async acceptDissolve(
    request: TeamDissolveRequest,
  ): Promise<AcceptedTeamDissolve> {
    return this.dissolves.accept(request);
  }

  /** Start or join the one runner for a durably accepted operation. */
  startAcceptedDissolve(
    handle: AcceptedTeamDissolve,
    logicalClose: TeamLogicalCloseExecutor,
  ): void {
    this.dissolves.start(handle, logicalClose);
  }

  /** Resume durable gates and lifecycle work before any normal Team work. */
  async recoverDissolves(
    logicalClose: TeamLogicalCloseExecutor,
  ): Promise<void> {
    await this.dissolves.recover(logicalClose);
  }

  /**
   * Interrupt only cancellable idle waits and owner retry timers. Physical
   * cleanup and resource-close attempts stay tracked through shutdown drain.
   */
  interruptDissolvesForShutdown(): void {
    this.dissolves.interruptForShutdown();
  }

  /** Project Dispatcher timing without cancelling the durable operation. */
  async dispatcherDissolveResult(
    handle: AcceptedTeamDissolve,
    budgetMs?: number,
  ): Promise<
    TeamSummary |
    AcceptedTeamDissolve['receipt'] |
    TeamDissolveCleanupPendingResult
  > {
    return budgetMs === undefined
      ? this.dissolves.dispatcherResult(handle)
      : this.dissolves.dispatcherResult(handle, budgetMs);
  }

  /** TeamService resource half, called only by the dispatcher route owner. */
  async closeAcceptedResources(
    input: AcceptedTeamLogicalClose,
  ): Promise<TeamSummary> {
    const current = await this.mustTeam(input.teamId);
    if (current.dissolve?.operation_id !== input.operationId) {
      throw new TeamDissolveFailedError(
        `Team ${JSON.stringify(input.teamId)} dissolve operation changed`,
      );
    }
    const service = await this.get(input.teamId);
    if (current.status === 'closed') return service.status();
    return service.closeLogically({
      note: input.note,
      dissolve: input.dissolve,
      worktree: input.worktree,
    });
  }

  /**
   * Raise the one process-local Team closing fence. Callers hold the Team's
   * route-lifecycle queue and have already decided whether this is a new
   * ordinary close or an idempotent durable dissolve recovery/join.
   */
  private activateTeamClosingFence(
    record: TeamRecord,
    service: TeamService,
  ): ChannelRouteOwner {
    this.routeClosing.add(record.team_id);
    this.runtimes.closeAdmissionAndStopScheduler(record.team_id, service);
    return {
      kind: 'team',
      teamName: record.team_id,
      leaderName: record.leader_name,
    };
  }

  private completionInitiatorThroughAvailability(
    teamId: string,
    deliver: (
      service: TeamService,
      completion: Parameters<CompletionInitiator['completionInput']>[0],
    ) => ReturnType<CompletionInitiator['completionInput']>,
  ): CompletionInitiator {
    return {
      completionInput: async (completion) => {
        try {
          return await this.withTeamAvailable(teamId, (service) =>
            deliver(service, completion),
          );
        } catch (error) {
          if (error instanceof TeamUnavailableError) {
            return {
              status: 'unsupported',
              reason: 'Team is closing or unavailable',
            };
          }
          throw error;
        }
      },
    };
  }

  async isOpenTeam(teamId: string): Promise<boolean> {
    const team = await this.store.get(this.dispatcherId, validateTeamId(teamId));
    return team !== null && team.status !== 'closed';
  }

  /**
   * Authoritative lock-free handoff check for a target route lock holder. The
   * target lifecycle must not reacquire the Team route lock while it owns a
   * target lock, but it must also never decide from a stale runner snapshot.
   */
  async hasAcceptedTargetDissolveHandoff(input: {
    teamId: string;
    operationId: string;
    handoffId: string;
  }): Promise<boolean> {
    const team = await this.store.get(
      this.dispatcherId,
      validateTeamId(input.teamId),
    );
    return team?.dissolve?.operation_id === input.operationId &&
      isActiveDissolve(team.dissolve) &&
      team.dissolve.target_handoff_ids.includes(input.handoffId);
  }

  async hasTeam(teamId: string): Promise<boolean> {
    return (
      await this.store.get(this.dispatcherId, validateTeamId(teamId))
    ) !== null;
  }

  private async withTeamAvailable<T>(
    teamId: string,
    task: (service: TeamService) => Promise<T>,
  ): Promise<T> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustOpenTeam(id);
      if (this.routeClosing.has(id) || isActiveDissolve(record.dissolve)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      const service = await this.get(id);
      return task(service);
    });
  }

  private async ensureRoutableProjection(
    service: TeamService,
  ): Promise<TeamRouteProjection> {
    await service.ensureRouteReady();
    return service.routeProjection();
  }

  private async beginTeamClosing(teamId: string): Promise<ChannelRouteOwner> {
    const id = validateTeamId(teamId);
    return this.routeLifecycle.run(id, async () => {
      const record = await this.mustOpenTeam(id);
      if (this.routeClosing.has(id) || isActiveDissolve(record.dissolve)) {
        throw new TeamUnavailableError(`Team ${JSON.stringify(id)} is closing`);
      }
      const service = await this.get(id);
      return this.activateTeamClosingFence(record, service);
    });
  }

  private async endTeamClosing(
    teamId: string,
    reopen: boolean,
  ): Promise<void> {
    const id = validateTeamId(teamId);
    await this.routeLifecycle.run(id, async () => {
      const current = await this.store.get(this.dispatcherId, id);
      if (current !== null && isActiveDissolve(current.dissolve)) return;
      if (reopen && current !== null && current.status !== 'closed') {
        await this.runtimes.reopen(id);
      }
      this.routeClosing.delete(id);
    });
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
    return this.runtimes.scheduler(validateTeamId(teamId));
  }

  async startSchedulers(): Promise<void> {
    await this.runtimes.startSchedulers();
  }

  async startWorkflows(): Promise<void> {
    await this.runtimes.startWorkflows();
  }

  async recoverWorkflows(): Promise<void> {
    await this.runtimes.recoverWorkflows();
  }

  closeWorkflowAdmissions(): void {
    this.runtimes.closeWorkflowAdmissions();
  }

  stopSchedulers(): void {
    this.runtimes.stopSchedulers();
  }

  async stopAll(): Promise<void> {
    await this.runtimes.stopAll();
  }
}
