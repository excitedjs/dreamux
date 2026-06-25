import type {
  AgentRuntimeMcpServer,
  ChannelTarget,
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
import type { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
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
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import {
  requireLifecycleText,
  type TeamMateIdentity,
  type TeamMateLaunchPolicy,
  type TeamMateRuntimeStatus,
  type TeamMateTurnResult,
} from '../teammate-collection/types.js';
import type { TeammateService } from '../teammate-service/index.js';
import type { TeamStore } from '../team-collection/store.js';
import type {
  TeamChannelBindingSummary,
  TeamDissolveInput,
  TeamRecord,
  TeamSummary,
  TeamView,
} from '../team-collection/types.js';
import type { WorktreeManager } from '../worktree/manager.js';

/**
 * The narrow dispatcher seam a {@link TeamService} needs for channel-bound
 * operations, kept as an interface so the Team layer never imports the whole
 * `DispatcherService` (breaks the construction cycle). `DispatcherService`
 * implements it.
 */
export interface TeamChannelContext {
  resolveChannelId(requested?: string): string;
  channelProviderRef(channelId: string): string;
  resolveChannelTarget(meta: unknown, channelId?: string): Promise<ChannelTarget>;
}

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
  bindings: ChannelBindingStore;
  evict: () => void;
  log: DreamuxLogger;
}

export interface TeamServiceCreateInput {
  teamId: string;
  name: string;
  prompt?: string;
  leaderAgentRuntime: string;
  intent: string;
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
 * domain ops (`status` / `dissolve` / `bindChannel` / `deliverToLeader` /
 * `sharedWorkspace`) and forwards admin `team_leader` target calls to its own
 * collection (no team id — scope is baked in); the leader is never a member row.
 * Channel-bound ops run through an injected {@link TeamChannelContext}.
 */
export class TeamService {
  private record: TeamRecord | null = null;
  private leader_: TeammateService | null = null;
  readonly id: string;
  /** The team's OWN members collection (`teamScope: team_id`, issue #233). Held
   * as the concrete class internally because the lifecycle/factory methods the
   * team drives (`allocateLeaderName` / `createTeamLeader` / `leader` /
   * `stopAll` / `applyWorktreeCleanup` / workspace-injecting `spawn`) live off
   * `TeammateOps`. The PUBLIC surface stays the narrow admin op set via the
   * `teammates` getter — never re-expose those internal verbs to callers. */
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
      launchPolicyForTeamMate: (input) =>
        this.teamMateLaunchPolicy(input.identity),
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
    const leaderName = await service.teammateCollection.allocateLeaderName();
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
    const { leader, result } = await service.teammateCollection.createTeamLeader({
      name: leaderName,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: input.workspace.sourceCwd,
      sourceRepo: input.workspace.sourceRepo,
      runtimeCwd: input.workspace.runtimeCwd,
      worktree: input.workspace.worktree,
      intent: input.intent,
    });
    service.leader_ = leader;
    team = await deps.store.update(team, { status: 'running' });
    service.record = team;
    await service.scheduler.start();
    return { service, leaderResult: result };
  }

  static async rebuild(
    deps: TeamServiceDeps,
    record: TeamRecord,
  ): Promise<TeamService> {
    const service = new TeamService(deps, record.team_id);
    service.record = record;
    service.leader_ = await service.teammateCollection.leader(record.leader_name);
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
      binding: await this.activeGroupBinding(),
    };
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    this.scheduler.stop();
    const record = this.mustRecord();
    for (const binding of await this.deps.bindings.list(this.dispatcherId)) {
      if (binding.active && binding.team_name === this.id) {
        await this.deps.bindings.transferBack({
          dispatcherId: this.dispatcherId,
          channelId: binding.channel_id,
          targetKey: binding.target_key,
        });
      }
    }
    const members = await this.members();
    for (const member of members) {
      await this.teammateCollection.close({
        name: member.name,
        note: input.note,
      });
    }
    await this.leader.close({ note: input.note });
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
    await this.leader.stop();
  }

  async bindChannel(
    context: TeamChannelContext,
    input: { channelId?: string; meta: Record<string, unknown> },
  ): Promise<ChannelBinding> {
    const record = this.mustRecord();
    if (record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    const channelId = context.resolveChannelId(input.channelId);
    const target = await context.resolveChannelTarget(input.meta, channelId);
    return this.deps.bindings.bind({
      dispatcherId: this.dispatcherId,
      channelId,
      provider: context.channelProviderRef(channelId),
      target,
      teamName: this.id,
      leaderName: record.leader_name,
    });
  }

  async resolveLeaderChannel(input: {
    leaderName: string;
    targetKey: string;
  }): Promise<string | null> {
    const bindings = await this.deps.bindings.list(this.dispatcherId);
    const match = bindings.find(
      (binding) =>
        binding.active &&
        binding.target_key === input.targetKey &&
        binding.team_name === this.id &&
        binding.leader_name === input.leaderName,
    );
    if (match === undefined) return null;
    if (this.mustRecord().status === 'closed') return null;
    return match.channel_id;
  }

  async deliverToLeader(
    turn: InboundTurnInput,
  ): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult> {
    if (this.mustRecord().status === 'closed') return { status: 'stopped' };
    return this.leader.channelInput(turn);
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

  private async activeGroupBinding(): Promise<TeamChannelBindingSummary | null> {
    return activeGroupBindingFor(
      await this.deps.bindings.list(this.dispatcherId),
      this.id,
    );
  }

  /** The team_leader role policy, owned here because team_leader is a team
   * concept: a leader's MCP servers (its team's teammate MCP + cron MCP + its
   * channel-egress descriptors) plus the native features its runtime disables
   * (cron — it drives Dreamux's cron MCP instead). A team_member gets neither.
   * The dispatcher only injects the primitives (admin socket, channel
   * descriptors); it does not decide what a team_leader gets. */
  private teamMateLaunchPolicy(identity: TeamMateIdentity): TeamMateLaunchPolicy {
    if (identity.role !== 'team_leader') {
      return { mcpServers: [], disableFeatures: [] };
    }
    const teamId = identity.team_id ?? '';
    return {
      mcpServers: [
        teammateMcpServerDescriptor({
          dispatcherId: this.deps.dispatcherId,
          callerKind: 'team_leader',
          teamId,
          adminSocketPath: this.deps.adminSocketPath,
        }),
        cronMcpServerDescriptor({
          dispatcherId: this.deps.dispatcherId,
          teamId: identity.team_id ?? undefined,
          adminSocketPath: this.deps.adminSocketPath,
        }),
        ...this.deps.leaderChannelDescriptors({
          teamId,
          leaderName: identity.name,
        }),
      ],
      disableFeatures: [DISABLE_FEATURE_CRON],
    };
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

/** Shared team view helpers (issue #233): used by both {@link TeamService} and
 * the {@link TeamCollection} list/history/create paths. */
export function activeGroupBindingFor(
  bindings: readonly ChannelBinding[],
  teamId: string,
): TeamChannelBindingSummary | null {
  const active = bindings.find(
    (binding) => binding.active && binding.team_name === teamId,
  );
  if (active === undefined) return null;
  const chatId = active.meta['chat_id'];
  return {
    provider: active.provider,
    chat_id: typeof chatId === 'string' ? chatId : active.target_key,
  };
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
