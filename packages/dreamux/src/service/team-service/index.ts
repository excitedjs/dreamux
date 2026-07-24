import type {
  AgentRuntimeMcpServer,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import {
  DISABLE_FEATURE_CRON,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  bundledTeamLeaderSkillRoot,
  dispatcherTeamCronJobsPath,
} from '../../platform/paths.js';
import type {
  CompletionEnvelope,
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import { completionKey } from '../completion-router/index.js';
import { cronMcpServerDescriptor } from '../scheduler/mcp-config.js';
import { SchedulerService, type SchedulerCommands } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import {
  TeammateCollection,
  type SpawnTeamMateRequest,
  type TeamMateSharedWorkspace,
  type TeammateOps,
} from '../teammate-collection/index.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import { teammateMcpServerDescriptor } from '../teammate-collection/mcp-config.js';
import { teamMcpServerDescriptor } from '../team-collection/mcp-config.js';
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
  TeamDissolveInput,
  TeamLeaderSendResult,
  TeamRecord,
  TeamRouteProjection,
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
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  router: CompletionRouter;
  initiatorFor: (
    producer: AgentEntityIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  admitOperation: <T>(task: () => Promise<T>) => Promise<T>;
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
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  nameClaimToken: string;
  prompt?: string;
  leaderAgentRuntime: string;
  intent: string;
  identity?: string;
  skillSources?: readonly AgentRuntimeSkillSource[];
  workspace: TeamMateSharedWorkspace;
}

export interface TeamServiceCreateOutput {
  service: TeamService;
  schedulerLifecycle: TeamSchedulerLifecycle;
  leaderResult: {
    teammate: AgentEntityRuntimeStatus;
    turn: AgentEntityTurnResult | null;
  };
}

export interface TeamSchedulerLifecycle {
  start(): Promise<void>;
  stop(): void;
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
  private readonly scheduler_: SchedulerService;

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
    this.scheduler_ = new SchedulerService({
      ownerId: `${deps.dispatcherId}/team/${teamId}`,
      store: new CronJobStore({
        cronJobsPath: dispatcherTeamCronJobsPath(deps.dispatcherId, teamId),
        dispatcherId: deps.dispatcherId,
      }),
      absentRuntimeStrategy: 'submit',
      admit: (task) => deps.admitOperation(task),
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
    let { team, identity } = await deps.identities.withReservedName(
      {
        dispatcherId: deps.dispatcherId,
        kind: 'team_leader',
        base: input.teamId,
        teamSlug: input.teamId,
        ...(deps.agentNameSuffixGenerator !== undefined
          ? { generateSuffix: deps.agentNameSuffixGenerator }
          : {}),
      },
      async (leaderName) => {
        const createdTeam = await deps.store.create({
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
        const createdIdentity = await deps.identities.create({
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
        return { team: createdTeam, identity: createdIdentity };
      },
    );
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
    if (record.status !== 'closed') await service.scheduler_.start();
    return {
      service,
      schedulerLifecycle: TeamService.schedulerLifecycleFor(service),
    };
  }

  get leader(): TeammateService {
    return this.mustLeader();
  }

  get scheduler(): SchedulerCommands {
    return this.scheduler_.commands;
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
    if (record.status === 'starting') {
      this.record = await this.deps.store.update(record, { status: 'running' });
    }
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    this.scheduler_.stop();
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
    await this.scheduler_.deleteStoreFile();
    const summary = await this.status();
    // Evict so a later `get` rebuilds from disk and reads `status: closed`.
    this.deps.evict(this);
    return summary;
  }

  /** Stop every live runtime owned by this Team, without one failure preventing
   * the remaining members or leader from receiving their stop attempt. */
  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.teammateCollection.stopAll();
    } catch (err) {
      failures.push(err);
    }
    try {
      await this.stopLeader();
    } catch (err) {
      failures.push(err);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `multiple runtimes in Team ${JSON.stringify(this.id)} failed to stop`,
      );
    }
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

  async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async members(): Promise<AgentEntityRuntimeStatus[]> {
    return this.teammateCollection.list(); // members-only; leader is `this.leader`
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

  private buildLeader(identity: AgentEntityIdentity): TeammateService {
    return createTeamLeaderAgent({
      dispatcherId: this.deps.dispatcherId,
      identity,
      mcpServers: this.leaderMcpServers(identity.name),
      skillSources: [
        {
          name: 'team-leader',
          path: bundledTeamLeaderSkillRoot(),
          source: 'dreamux-core',
        },
        ...identity.skill_sources,
      ],
      disableFeatures: [DISABLE_FEATURE_CRON],
      systemPrompt: teamLeaderSystemPrompt(this.id, identity.identity_prompt),
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

  private static schedulerLifecycleFor(
    service: TeamService,
  ): TeamSchedulerLifecycle {
    return {
      start: () => service.scheduler_.start(),
      stop: () => service.scheduler_.stop(),
    };
  }
}

function teamLeaderSystemPrompt(
  teamId: string,
  identityPrompt: string | null,
): AgentRuntimeSystemPrompt {
  const append = [
    `You are the TeamLeader of Dreamux Team ${JSON.stringify(teamId)}.`,
    'Load `team-workflow` before using this Team\'s TeamMate tools, provider-exposed channel tools, cron tools, or team transfer tool.',
    'When a prompt-submitting TeamMate tool returns success, the task was submitted successfully; Dreamux core will push the completion back automatically, so do not poll `last` or other read tools, and end the turn naturally if there is no other work.',
  ];
  if (identityPrompt !== null) append.push(identityPrompt);
  return { append };
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
