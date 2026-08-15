import type {
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import { dispatcherTeamCronJobsPath } from '../../platform/paths.js';
import type {
  CompletionEnvelope,
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import { completionKey } from '../completion-router/index.js';
import {
  collectShutdownFailure,
  throwShutdownFailures,
} from '../shutdown-errors.js';
import { SchedulerService } from '../scheduler/service.js';
import type { SchedulerCommands } from '../scheduler/types.js';
import { CronJobStore } from '../scheduler/store.js';
import {
  TeammateCollection,
} from '../teammate-collection/index.js';
import type { SpawnOwnedTeamMateOptions } from '../teammate-collection/owned-teammates.js';
import type {
  SpawnTeamMateRequest,
  TeamMateSharedWorkspace,
  TeammateOps,
} from '../teammate-collection/types.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  type AgentEntityIdentity,
  type AgentEntityRuntimeStatus,
  type AgentEntityTurnResult,
} from '../agent-entity/types.js';
import type { SuffixGenerator } from '../name-allocator.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamDissolveRecord,
  TeamLeaderSendResult,
  TeamRecord,
  TeamRouteProjection,
  TeamSummary,
  TeamLeaderLease,
  TeamView,
} from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { createTeamLeaderAgentForTeam } from './leader-agent.js';
import { teamView } from './team-view.js';
import type {
  TeamAvailability,
  TeamLiveWriter,
  TeamSchedulerLifecycle,
  TeamServiceCreateInput,
} from './types.js';
import { WorkflowService, type WorkflowOps } from '../workflow-service/index.js';

export interface TeamServiceDeps {
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  router: CompletionRouter;
  initiatorFor: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
  availability: TeamAvailability;
  withTeamLeaderLease: <T>(
    lease: TeamLeaderLease,
    task: (service: TeamService) => Promise<T>,
  ) => Promise<T>;
  adminSocketPath: string;
  leaderChannelDescriptors: (input: {
    teamId: string;
    leaderName: string;
  }) => readonly AgentRuntimeMcpServer[];
  trackMaterialized: (service: TeamService) => void;
  store: TeamStore;
  agentNameSuffixGenerator?: SuffixGenerator;
  evict: (service: TeamService) => void;
  log: DreamuxLogger;
  workflowLog: DreamuxLogger;
}

export interface TeamServiceCreateOutput {
  service: TeamService;
  schedulerLifecycle: TeamSchedulerLifecycle;
  leaderResult: {
    teammate: AgentEntityRuntimeStatus;
    turn: AgentEntityTurnResult | null;
  };
}

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It exposes per-team runtime
 * and resource operations while TeamCollection owns the durable dissolve state
 * machine. Admin `team_leader` target calls are forwarded to this Team's own
 * collection (no team id — scope is baked in); the leader is never a member row.
 */
export class TeamService {
  private record: TeamRecord | null = null;
  private leader_: TeammateService | null = null;
  private leaderSubmissionSeq = 0;
  private readonly leaderSettleCaptures = new Set<Promise<void>>();
  readonly id: string;
  /** The team's OWN members collection (`teamScope: team_id`, issue #233). Held
   * as the concrete class internally because the lifecycle methods the team
   * drives (`stopAll` / `applyWorktreeCleanup` / workspace-injecting `spawn`)
   * live off `TeammateOps`. The PUBLIC surface stays the narrow admin op set via
  * the `teammates` getter — never re-expose those internal verbs to callers. */
  private readonly teammateCollection: TeammateCollection;
  private readonly scheduler_: SchedulerService;
  private readonly schedulerCommands: SchedulerCommands;
  private readonly workflowService: WorkflowService;

  private constructor(private readonly deps: TeamServiceDeps, teamId: string) {
    this.id = teamId;
    this.teammateCollection = new TeammateCollection({
      dispatcherId: deps.dispatcherId,
      teamScope: teamId,
      config: deps.config,
      agentRuntimeProviders: deps.agentRuntimeProviders,
      worktrees: deps.worktrees,
      identities: deps.identities,
      turnsStore: deps.turnsStore,
      router: deps.router,
      initiatorFor: deps.initiatorFor,
      isShuttingDown: deps.isShuttingDown,
      ...(deps.agentNameSuffixGenerator !== undefined
        ? { suffixGenerator: deps.agentNameSuffixGenerator }
        : {}),
      log: deps.log,
    });
    this.workflowService = new WorkflowService({
      dispatcherId: deps.dispatcherId,
      teamId,
      callerKind: 'team_leader',
      ownedTeammates: {
        spawnOwned: (input, options) =>
          deps.withTeamLeaderLease(this.workflowLease(), (service) =>
            service.spawnOwnedTeamMate(input, options),
        ),
        // Cleanup is owned by this TeamService and must remain available after
        // the outer route-closing fence rejects new generation leases.
        releaseAllOwned: (owner) =>
          this.teammateCollection.releaseAllOwned(owner),
      },
      router: deps.router,
      completionInitiator: () =>
        deps.availability.completionInitiator(this.mustLeader()),
      log: deps.workflowLog,
    });
    this.scheduler_ = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      store: new CronJobStore({
        cronJobsPath: dispatcherTeamCronJobsPath(deps.dispatcherId, teamId),
        dispatcherId: deps.dispatcherId,
      }),
      absentRuntimeStrategy: 'submit',
      // SchedulerService owns the potentially long runtime-idle defer. Keep
      // only Dispatcher admission around it; Team admission guards each short
      // public mutation and the final prompt submission separately below.
      admit: (task) => deps.admitOperation(task),
      getRuntime: () => this.leader_?.getRuntime() ?? null,
      submitScheduled: (input) =>
        deps.availability.admit(() => this.mustLeader().scheduledInput(input)),
      log: deps.log,
    });
    this.schedulerCommands = {
      list: () => this.scheduler_.commands.list(),
      create: (input) =>
        deps.availability.admit(() => this.scheduler_.commands.create(input)),
      update: (input) =>
        deps.availability.admit(() => this.scheduler_.commands.update(input)),
      delete: (id) =>
        deps.availability.admit(() => this.scheduler_.commands.delete(id)),
    };
  }

  static async createNew(
    deps: TeamServiceDeps,
    input: TeamServiceCreateInput,
  ): Promise<TeamServiceCreateOutput> {
    const service = new TeamService(deps, input.teamId);
    const identityPrompt = optionalLifecycleText(
      input.identity,
      'TeamLeader identity',
    );
    const leaderName = await deps.identities.allocateName({
      dispatcherId: deps.dispatcherId,
      kind: 'team_leader',
      base: input.teamId,
      teamSlug: input.teamId,
      ...(deps.agentNameSuffixGenerator !== undefined
        ? { generateSuffix: deps.agentNameSuffixGenerator }
        : {}),
    });
    let team = await deps.store.create({
      dispatcher_id: deps.dispatcherId,
      team_id: input.teamId,
      name: input.name,
      repo_cwd: input.workspace.sourceCwd,
      source_repo: input.workspace.sourceRepo,
      leader_name: leaderName,
      leader_agent_runtime: input.leaderAgentRuntime,
      runtime_cwd: input.workspace.runtimeCwd,
      worktree: input.workspace.worktree,
      status: 'starting',
      intent: input.intent,
      closed_at: null,
      close_note: null,
    }, input.nameClaimToken);
    const identity = await deps.identities.create({
      dispatcherId: deps.dispatcherId,
      name: leaderName,
      role: 'team_leader',
      teamId: input.teamId,
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: input.workspace.sourceCwd,
      sourceRepo: input.workspace.sourceRepo,
      cwd: input.workspace.runtimeCwd,
      runtimeCwd: input.workspace.runtimeCwd,
      worktree: input.workspace.worktree,
      intent: input.intent,
      identityPrompt,
      ...(input.skillSources !== undefined
        ? { skillSources: input.skillSources }
        : {}),
      status: 'starting',
    });
    const leader = service.buildLeader(identity);
    // Publish ownership before starting: if any later create step and its first
    // cleanup attempt both fail, the collection's shutdown sweep can retry this
    // same runtime even though the service never reaches the live cache.
    service.leader_ = leader;
    deps.trackMaterialized(service);
    try {
      await leader.ensureStarted();
      let turn: AgentEntityTurnResult | null = null;
      if (input.prompt !== undefined) {
        turn = await leader.submitInitialPrompt(input.prompt, {
          turnOrigin: 'dispatcher',
        });
        await service.registerLeaderCompletion(leader, turn.turn_id ?? null);
      }
      team = await deps.store.update(team, { status: 'running' });
      service.record = team;
      await service.workflowService.start();
      await service.scheduler_.start();
      return {
        service,
        schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
        leaderResult: { teammate: leader.status(), turn },
      };
    } catch (error) {
      service.scheduler_.stop();
      try {
        await leader.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          `Team ${JSON.stringify(input.teamId)} creation and leader cleanup failed`,
        );
      }
      throw error;
    }
  }

  static async rebuild(
    deps: TeamServiceDeps,
    record: TeamRecord,
  ): Promise<{
    service: TeamService;
    schedulerLifecycle: TeamSchedulerLifecycle;
  }> {
    const service = new TeamService(deps, record.team_id);
    service.record = record;
    const identity = await deps.identities.get(
      deps.dispatcherId,
      record.leader_name,
      record.team_id,
    );
    if (identity === null || identity.role !== 'team_leader') {
      throw new Error(
        `TeamLeader ${JSON.stringify(record.leader_name)} does not exist`,
      );
    }
    service.leader_ = service.buildLeader(identity);
    deps.trackMaterialized(service);
    return {
      service,
      schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
    };
  }

  get leader(): TeammateService {
    return this.mustLeader();
  }

  get scheduler(): SchedulerCommands {
    return this.schedulerCommands;
  }

  get workflows(): WorkflowOps {
    return this.workflowService;
  }

  /** This team's members as concrete internal ops. `TeamLeaderHandle` wraps this
   * surface before it reaches admin/MCP callers, so raw `spawn` never bypasses
   * `spawnTeamMate`'s shared-workspace injection there. */
  get teammates(): TeammateOps {
    return this.teammateCollection;
  }

  get dispatcherId(): string {
    return this.mustRecord().dispatcher_id;
  }

  get leaderName(): string {
    return this.mustRecord().leader_name;
  }

  routeProjection(): TeamRouteProjection {
    const record = this.mustRecord();
    return {
      team_name: record.team_id,
      leader_name: record.leader_name,
      leader_agent_runtime: record.leader_agent_runtime,
      runtime_cwd: record.runtime_cwd,
    };
  }

  view(): TeamView {
    return teamView(this.mustRecord());
  }

  async status(): Promise<TeamSummary> {
    return {
      team: this.view(),
      leader: this.leader.status(),
      member_count: await this.memberCount(),
    };
  }

  /**
   * Materialize the TeamLeader before another service publishes this Team as a
   * routable owner. A persisted `starting` Team with a valid leader identity is
   * the recoverable tail of Team creation; only mark it running after the leader
   * can actually start.
   */
  async ensureRouteReady(): Promise<void> {
    const record = this.mustRecord();
    if (record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    await this.leader.ensureStarted();
    await this.workflowService.start();
    if (record.status === 'starting') {
      this.record = await this.deps.store.update(record, { status: 'running' });
    }
  }

  /** Every process-live runtime that may write this Team's shared workspace. */
  liveWriters(): TeamLiveWriter[] {
    const writers = this.teammateCollection.liveRuntimes().map(
      ({ name, runtime }) => ({
        name, waitIdle: runtime.waitIdle?.bind(runtime),
      }),
    );
    const leaderRuntime = this.leader_?.getRuntime() ?? null;
    if (leaderRuntime !== null) {
      writers.unshift({
        name: this.leaderName, waitIdle: leaderRuntime.waitIdle?.bind(leaderRuntime),
      });
    }
    return writers;
  }

  /** Reattach every non-closed durable writer before restart recovery waits. */
  async recoverLiveWritersForDissolve(): Promise<TeamLiveWriter[]> {
    if (this.leader.status().status !== 'closed') {
      await this.leader.ensureStarted();
    }
    await this.teammateCollection.recoverLiveRuntimesForOwnerClose();
    return this.liveWriters();
  }

  /** Synchronize a TeamCollection-owned durable lifecycle write into this entity. */
  replaceRecord(record: TeamRecord): void {
    if (record.team_id !== this.id) {
      throw new Error(`Team record ${JSON.stringify(record.team_id)} does not match ${JSON.stringify(this.id)}`);
    }
    this.record = record;
  }

  /**
   * Close routes' runtime/resource half after the Team-wide idle barrier. The
   * owning TeamCollection has already fenced admission and supplies the exact
   * durable dissolve phase and shared cleanup state to commit atomically with
   * logical closure.
   */
  async closeLogically(input: {
    note: string;
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    this.workflowService.closeAdmission();
    await this.workflowService.stopAll();
    await this.teammateCollection.releaseAllOwned();
    this.scheduler_.stop();
    const record = this.mustRecord();
    const members = await this.members();
    for (const member of members) {
      await this.teammateCollection.close({ name: member.name, note: input.note });
    }
    await this.stopLeader({ note: input.note });
    await this.scheduler_.deleteStoreFile();
    const closingDissolve =
      input.dissolve.phase === 'complete' || input.dissolve.phase === 'failed'
      ? { ...input.dissolve, phase: 'closing_resources' as const }
      : input.dissolve;
    this.record = await this.deps.store.update(record, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      worktree: input.worktree,
      dissolve: closingDissolve,
      expectedDissolveOperationId: input.dissolve.operation_id,
    });
    await this.synchronizeWorktreeCleanup(input.worktree);
    if (closingDissolve !== input.dissolve) {
      this.record = await this.deps.store.update(this.mustRecord(), {
        dissolve: input.dissolve,
        expectedDissolveOperationId: input.dissolve.operation_id,
      });
    }
    return this.status();
  }

  /** Idempotently synchronize the Team-owned workspace fact to all borrowers. */
  async synchronizeWorktreeCleanup(
    worktree: TeamRecord['worktree'],
  ): Promise<void> {
    const members = await this.members();
    await this.leader.applyWorktreeCleanup(worktree);
    for (const member of members) {
      await this.teammateCollection.applyWorktreeCleanup(member.name, worktree);
    }
  }

  /** Propagate the one Team-owned physical-cleanup result to every borrower. */
  async completeWorktreeCleanup(input: {
    dissolve: TeamDissolveRecord;
    worktree: TeamRecord['worktree'];
  }): Promise<TeamSummary> {
    await this.synchronizeWorktreeCleanup(input.worktree);
    this.record = await this.deps.store.update(this.mustRecord(), {
      worktree: input.worktree,
      dissolve: input.dissolve,
      expectedDissolveOperationId: input.dissolve.operation_id,
    });
    const summary = await this.status();
    this.deps.evict(this);
    return summary;
  }

  /** Stop every live runtime owned by this Team, without one failure preventing
   * the remaining members or leader from receiving their stop attempt. */
  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    await collectShutdownFailure(failures, () =>
      this.workflowService.stopAllForShutdown());
    await collectShutdownFailure(failures, () => this.teammateCollection.stopAll());
    await collectShutdownFailure(failures, () => this.stopLeader());
    throwShutdownFailures(
      failures,
      `multiple runtimes in Team ${JSON.stringify(this.id)} failed to stop`,
    );
  }

  async deliverToLeader(turn: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    if (this.mustRecord().status === 'closed') return { status: 'stopped' };
    return this.leader.channelInput(turn);
  }

  async sendToLeader(input: {
    prompt: string;
    intent?: string;
    initiator: CompletionInitiator;
  }): Promise<TeamLeaderSendResult> {
    const record = this.mustRecord();
    if (record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    const leader = this.mustLeader();
    const sent = await leader.send({
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      turnOrigin: 'dispatcher',
    });
    if (sent.turn.turn_id !== undefined) {
      this.registerLeaderCompletionFor(leader, sent.turn.turn_id, input.initiator);
    }
    return {
      team: this.view(),
      leader: sent.teammate,
      turn: sent.turn,
    };
  }

  sharedWorkspace(): TeamMateSharedWorkspace {
    const record = this.mustRecord();
    return {
      sourceCwd: record.repo_cwd,
      sourceRepo: record.source_repo,
      runtimeCwd: record.runtime_cwd,
      worktree: record.worktree,
    };
  }

  async spawnTeamMate(input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>) {
    // The owned collection is team-scoped (spawns a `team_member`); still pass
    // the shared workspace (issue #233). This stays a real method — injecting
    // the shared workspace is the team's job — unlike the pure teammate forwards
    // that now go through `.teammates`.
    return this.teammateCollection.spawn({
      ...input,
      sharedWorkspace: this.sharedWorkspace(),
    });
  }

  async spawnOwnedTeamMate(
    input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>,
    options: SpawnOwnedTeamMateOptions,
  ) {
    return this.teammateCollection.spawnOwned(
      {
        ...input,
        sharedWorkspace: this.sharedWorkspace(),
      },
      options,
    );
  }

  closeWorkflowAdmission(): void {
    this.workflowService.closeAdmission();
  }

  stopWorkflowsForClosing(): Promise<void> {
    return this.workflowService.stopAll();
  }

  startWorkflowAdmission(): Promise<void> {
    return this.workflowService.start();
  }

  recoverWorkflows(): Promise<void> {
    return this.workflowService.recover();
  }

  async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async members(): Promise<AgentEntityRuntimeStatus[]> {
    return this.teammateCollection.list(); // members-only; leader is `this.leader`
  }

  private buildLeader(identity: AgentEntityIdentity): TeammateService {
    return createTeamLeaderAgentForTeam({
      dispatcherId: this.deps.dispatcherId,
      teamId: this.id,
      identity,
      adminSocketPath: this.deps.adminSocketPath,
      leaderChannelDescriptors: this.deps.leaderChannelDescriptors,
      config: this.deps.config,
      agentRuntimeProviders: this.deps.agentRuntimeProviders,
      identities: this.deps.identities,
      turnsStore: this.deps.turnsStore,
      worktrees: this.deps.worktrees,
      log: this.deps.log,
      nextSubmissionSeq: () => ++this.leaderSubmissionSeq,
      trackSettleCapture: (capture) => this.trackLeaderSettleCapture(capture),
      routeSettledCompletion: (producerName, turnId, completion) =>
        this.routeLeaderSettledCompletion(producerName, turnId, completion),
    });
  }

  private trackLeaderSettleCapture(capture: Promise<void>): void {
    this.leaderSettleCaptures.add(capture);
    void capture.finally(() => {
      this.leaderSettleCaptures.delete(capture);
    });
  }

  private async drainLeaderSettleCaptures(): Promise<void> {
    while (this.leaderSettleCaptures.size > 0) {
      await Promise.allSettled([...this.leaderSettleCaptures]);
    }
  }

  private async stopLeader(input: { note?: string } = {}): Promise<void> {
    try {
      if (input.note !== undefined) await this.leader.close({ note: input.note });
      else await this.leader.stop();
    } finally {
      await this.drainLeaderSettleCaptures();
    }
  }

  private async registerLeaderCompletion(
    leader: TeammateService,
    turnId: string | null,
  ): Promise<void> {
    if (turnId === null) return;
    const initiator = await this.deps.initiatorFor(leader.current());
    if (initiator === null) return;
    this.registerLeaderCompletionFor(leader, turnId, initiator);
  }

  private registerLeaderCompletionFor(
    leader: TeammateService,
    turnId: string,
    initiator: CompletionInitiator,
  ): void {
    this.deps.router.register(completionKey(leader.name, turnId), initiator);
  }

  private async routeLeaderSettledCompletion(
    producerName: string,
    turnId: string,
    completion: CompletionEnvelope,
  ): Promise<void> {
    await this.deps.router.settle(completionKey(producerName, turnId), completion);
  }

  private mustRecord(): TeamRecord {
    if (this.record === null) {
      throw new Error(`Team ${JSON.stringify(this.id)} is not booted`);
    }
    return this.record;
  }

  private mustLeader(): TeammateService {
    if (this.leader_ === null) {
      throw new Error(`Team ${JSON.stringify(this.id)} leader is not booted`);
    }
    return this.leader_;
  }

  private workflowLease(): TeamLeaderLease {
    return { teamId: this.id, leaderName: this.leaderName };
  }

  private static schedulerLifecycleFor(
    service: TeamService,
  ): TeamSchedulerLifecycle {
    return {
      start: () => service.scheduler_.start(),
      stop: () => service.scheduler_.stop(),
    };
  }
}
