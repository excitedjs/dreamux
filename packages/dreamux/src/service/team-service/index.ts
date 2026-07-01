import type {
  CompletionEnvelope,
  AgentRuntimeMcpServer,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import { dispatcherTeamCronJobsPath } from '../../platform/paths.js';
import type {
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import { completionKey } from '../completion-router/index.js';
import { cronMcpServerDescriptor } from '../scheduler/mcp-config.js';
import { SchedulerService } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import {
  TeammateCollection,
  type SpawnTeamMateRequest,
  type TeamMateSharedWorkspace,
  type TeammateOps,
} from '../teammate-collection/index.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import {
  optionalLifecycleText,
  requireLifecycleText,
  type TeamMateIdentity,
  type TeamMateRuntimeStatus,
  type TeamMateTurnResult,
} from '../teammate-collection/types.js';
import { allocateConcreteName } from '../teammate-collection/name-allocator.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamDissolveInput,
  TeamLeaderSendResult,
  TeamRecord,
  TeamSummary,
  TeamView,
} from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { createTeamLeaderAgent } from './leader-agent.js';

export interface TeamServiceDeps {
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  router: CompletionRouter;
  initiatorFor: (
    producer: TeamMateIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  adminSocketPath: string;
  leaderChannelDescriptors: (input: {
    teamId: string;
    leaderName: string;
  }) => readonly AgentRuntimeMcpServer[];
  store: TeamStore;
  evict: () => void;
  log: DreamuxLogger;
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  prompt?: string;
  leaderAgentRuntime: string;
  intent: string;
  identity?: string;
  workspace: TeamMateSharedWorkspace;
  existing: TeamRecord | null;
}

export interface TeamServiceCreateOutput {
  service: TeamService;
  leaderResult: {
    teammate: TeamMateRuntimeStatus;
    turn: TeamMateTurnResult | null;
  };
}

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It exposes the per-team
 * domain ops (`status` / `dissolve` / `deliverToLeader` / `sharedWorkspace`)
 * and forwards admin `team_leader` target calls to its own
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
  readonly scheduler: SchedulerService;

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
      log: deps.log,
    });
    this.scheduler = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      store: new CronJobStore({
        cronJobsPath: dispatcherTeamCronJobsPath(deps.dispatcherId, teamId),
        dispatcherId: deps.dispatcherId,
      }),
      absentRuntimeStrategy: 'submit',
      getRuntime: () => this.leader_?.getRuntime() ?? null,
      submitScheduled: (input) => this.mustLeader().scheduledInput(input),
      log: deps.log,
    });
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
    const leaderName = await service.allocateLeaderName();
    let team =
      input.existing ??
      (await deps.store.create({
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
      }));
    team = await deps.store.update(team, {
      status: 'starting',
      closedAt: null,
      closeNote: null,
      worktree: input.workspace.worktree,
      intent: input.intent,
      leaderName,
    });
    const existingLeader = await deps.identities.get(
      deps.dispatcherId,
      leaderName,
      input.teamId,
    );
    if (existingLeader !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(leaderName)} already exists`);
    }
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
      status: 'starting',
    });
    const leader = service.buildLeader(identity);
    await leader.ensureStarted();
    let turn: TeamMateTurnResult | null = null;
    if (input.prompt !== undefined) {
      turn = await leader.submitInitialPrompt(input.prompt, {
        turnOrigin: 'dispatcher',
      });
      await service.registerLeaderCompletion(leader, turn.turn_id ?? null);
    }
    service.leader_ = leader;
    team = await deps.store.update(team, { status: 'running' });
    service.record = team;
    await service.scheduler.start();
    return { service, leaderResult: { teammate: leader.status(), turn } };
  }

  static async rebuild(
    deps: TeamServiceDeps,
    record: TeamRecord,
  ): Promise<TeamService> {
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
    if (record.status !== 'closed') await service.scheduler.start();
    return service;
  }

  get leader(): TeammateService {
    return this.mustLeader();
  }

  /** This team's members, as the narrow admin-facing op surface (issue #233):
   * the verbs the admin `team_leader` target needs run directly through this
   * collection. `spawnTeamMate` stays a separate method because it injects the
   * shared workspace — the raw `spawn` is deliberately not on `TeammateOps`. */
  get teammates(): TeammateOps {
    return this.teammateCollection;
  }

  get dispatcherId(): string {
    return this.mustRecord().dispatcher_id;
  }

  get leaderName(): string {
    return this.mustRecord().leader_name;
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

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    this.scheduler.stop();
    const record = this.mustRecord();
    const members = await this.members();
    for (const member of members) {
      await this.teammateCollection.close({
        name: member.name,
        note: input.note,
      });
    }
    await this.stopLeader({ note: input.note });
    // `dissolve` is the single authoritative cleanup site for the Team's shared
    // worktree (issue #236): members and the leader borrow it and skip cleanup on
    // their own `close`, so only this call removes it.
    const cleaned = await this.deps.worktrees.cleanup({
      source_cwd: record.repo_cwd,
      source_repo: record.source_repo,
      worktree: record.worktree,
    });
    this.record = await this.deps.store.update(record, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      worktree: cleaned,
    });
    // Propagate that single result to every borrower so a leader/member
    // `cleanup_state` does not stay `managed-active` after the worktree is gone
    // (issue #237). They share the one worktree, so the same identity applies.
    await this.leader.applyWorktreeCleanup(cleaned);
    for (const member of members) {
      await this.teammateCollection.applyWorktreeCleanup(member.name, cleaned);
    }
    await this.scheduler.deleteStoreFile();
    const summary = await this.status();
    // Evict so a later `get` rebuilds from disk and reads `status: closed`.
    this.deps.evict();
    return summary;
  }

  /** Stop this team's live runtimes on server shutdown (issue #233): members in
   * the owned collection, then the leader. Persisted records stay intact. */
  async stopAll(): Promise<void> {
    await this.teammateCollection.stopAll();
    await this.stopLeader();
  }

  async deliverToLeader(
    turn: InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
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

  async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async members(): Promise<TeamMateRuntimeStatus[]> {
    return this.teammateCollection.list(); // members-only; leader is `this.leader`
  }

  private async allocateLeaderName(): Promise<string> {
    const taken = await this.deps.identities.listAllNames(this.deps.dispatcherId);
    return allocateConcreteName({
      role: 'team_leader',
      base: this.id,
      teamSlug: this.id,
      exists: (candidate) => taken.has(candidate),
    });
  }

  private leaderMcpServers(leaderName: string): readonly AgentRuntimeMcpServer[] {
    return [
      teammateMcpServerDescriptor({
        dispatcherId: this.deps.dispatcherId,
        callerKind: 'team_leader',
        teamId: this.id,
        adminSocketPath: this.deps.adminSocketPath,
      }),
      cronMcpServerDescriptor({
        dispatcherId: this.deps.dispatcherId,
        teamId: this.id,
        adminSocketPath: this.deps.adminSocketPath,
      }),
      teamMcpServerDescriptor({
        dispatcherId: this.deps.dispatcherId,
        callerKind: 'team_leader',
        teamId: this.id,
        leaderName,
        adminSocketPath: this.deps.adminSocketPath,
      }),
      ...this.deps.leaderChannelDescriptors({
        teamId: this.id,
        leaderName,
      }),
    ];
  }

  private buildLeader(identity: TeamMateIdentity): TeammateService {
    return createTeamLeaderAgent({
      dispatcherId: this.deps.dispatcherId,
      identity,
      mcpServers: this.leaderMcpServers(identity.name),
      disableFeatures: [DISABLE_FEATURE_CRON],
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

}

export function teamView(team: TeamRecord): TeamView {
  return {
    team_name: team.team_id,
    status: team.status,
    intent: team.intent,
    source_repo: team.source_repo,
    leader_name: team.leader_name,
    leader_agent_runtime: team.leader_agent_runtime,
    created_at: team.created_at,
    updated_at: team.updated_at,
    closed_at: team.closed_at,
    close_note: team.close_note,
  };
}
