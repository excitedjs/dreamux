import type {
  ChannelTarget,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type {
  TeammateCollection,
  TeammateOps,
} from '../teammate-collection/index.js';
import {
  type SpawnTeamMateRequest,
  type TeamMateSharedWorkspace,
} from '../teammate-collection/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import { requireLifecycleText } from '../teammate-collection/types.js';
import type { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import { TeamStore } from '../team-collection/store.js';
import type {
  TeamChannelBindingSummary,
  TeamDissolveInput,
  TeamRecord,
  TeamSummary,
  TeamView,
} from '../team-collection/types.js';
import type { TeamMateRuntimeStatus } from '../teammate-collection/types.js';
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

export interface TeamServiceOptions {
  record: TeamRecord;
  /** The team's leader, a contained {@link TeammateService} (issue #233 Phase 4). */
  leader: TeammateService;
  store: TeamStore;
  bindings: ChannelBindingStore;
  worktrees: WorktreeManager;
  /** The team's OWN members collection (`teamScope: team_id`, issue #233). */
  teammates: TeammateCollection;
  /** Evict from the live cache on dissolve (issue #233). */
  evict: () => void;
}

/**
 * A single team entity (issue #233): holds its own {@link TeamRecord}, *has a*
 * leader {@link TeammateService} (Phase 4, at the team root), and OWNS its
 * members' team-scoped {@link TeammateCollection}. It exposes the per-team domain
 * ops (`status` / `dissolve` / `bindChannel` / `deliverToLeader` /
 * `sharedWorkspace`) and forwards admin `team_leader` target calls to its own
 * collection (no team id — scope is baked in); the leader is never a member row.
 * Channel-bound ops run through an injected {@link TeamChannelContext}.
 */
export class TeamService {
  private record: TeamRecord;
  readonly id: string;
  readonly leader: TeammateService;

  constructor(private readonly opts: TeamServiceOptions) {
    this.record = opts.record;
    this.id = opts.record.team_id;
    this.leader = opts.leader;
  }

  get dispatcherId(): string {
    return this.record.dispatcher_id;
  }

  get leaderName(): string {
    return this.record.leader_name;
  }

  async status(): Promise<TeamSummary> {
    return {
      team: teamView(this.record),
      leader: this.leader.status(),
      member_count: await this.memberCount(),
      binding: await this.activeGroupBinding(),
    };
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    requireLifecycleText(input.note, 'Team dissolve note');
    for (const binding of await this.opts.bindings.list(this.dispatcherId)) {
      if (binding.active && binding.team_name === this.id) {
        await this.opts.bindings.transferBack({
          dispatcherId: this.dispatcherId,
          channelId: binding.channel_id,
          targetKey: binding.target_key,
        });
      }
    }
    const members = await this.members();
    for (const member of members) {
      await this.opts.teammates.close({
        name: member.name,
        note: input.note,
      });
    }
    await this.leader.close({ note: input.note });
    // `dissolve` is the single authoritative cleanup site for the Team's shared
    // worktree (issue #236): members and the leader borrow it and skip cleanup on
    // their own `close`, so only this call removes it.
    const cleaned = await this.opts.worktrees.cleanup({
      source_cwd: this.record.repo_cwd,
      source_repo: this.record.source_repo,
      worktree: this.record.worktree,
    });
    this.record = await this.opts.store.update(this.record, {
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
      await this.opts.teammates.applyWorktreeCleanup(member.name, cleaned);
    }
    const summary = await this.status();
    // Evict so a later `get` rebuilds from disk and reads `status: closed`.
    this.opts.evict();
    return summary;
  }

  /** Stop this team's live runtimes on server shutdown (issue #233): members in
   * the owned collection, then the leader. Persisted records stay intact. */
  async stopAll(): Promise<void> {
    await this.opts.teammates.stopAll();
    await this.leader.stop();
  }

  async bindChannel(
    context: TeamChannelContext,
    input: { channelId?: string; meta: Record<string, unknown> },
  ): Promise<ChannelBinding> {
    if (this.record.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(this.id)} is closed`);
    }
    const channelId = context.resolveChannelId(input.channelId);
    const target = await context.resolveChannelTarget(input.meta, channelId);
    return this.opts.bindings.bind({
      dispatcherId: this.dispatcherId,
      channelId,
      provider: context.channelProviderRef(channelId),
      target,
      teamName: this.id,
      leaderName: this.record.leader_name,
    });
  }

  async resolveLeaderChannel(input: {
    leaderName: string;
    targetKey: string;
  }): Promise<string | null> {
    const bindings = await this.opts.bindings.list(this.dispatcherId);
    const match = bindings.find(
      (binding) =>
        binding.active &&
        binding.target_key === input.targetKey &&
        binding.team_name === this.id &&
        binding.leader_name === input.leaderName,
    );
    if (match === undefined) return null;
    if (this.record.status === 'closed') return null;
    return match.channel_id;
  }

  async deliverToLeader(
    turn: InboundTurnInput,
  ): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult> {
    if (this.record.status === 'closed') return { status: 'stopped' };
    return this.leader.channelInput(turn);
  }

  sharedWorkspace(): TeamMateSharedWorkspace {
    return {
      sourceCwd: this.record.repo_cwd,
      sourceRepo: this.record.source_repo,
      runtimeCwd: this.record.runtime_cwd,
      worktree: this.record.worktree,
    };
  }

  async spawnTeamMate(input: Omit<SpawnTeamMateRequest, 'sharedWorkspace'>) {
    // The owned collection is team-scoped (spawns a `team_member`); still pass
    // the shared workspace (issue #233). This stays a real method — injecting
    // the shared workspace is the team's job — unlike the pure teammate forwards
    // that now go through `.teammates`.
    return this.opts.teammates.spawn({
      ...input,
      sharedWorkspace: this.sharedWorkspace(),
    });
  }

  /** This team's members, as the narrow admin-facing op surface (issue #233).
   * `spawnTeamMate` stays separate because it injects the shared workspace; the
   * remaining teammate verbs the admin `team_leader` target needs run directly
   * through this collection. */
  get teammates(): TeammateOps {
    return this.opts.teammates;
  }

  async memberCount(): Promise<number> {
    return (await this.members()).length;
  }

  private async members(): Promise<TeamMateRuntimeStatus[]> {
    return this.opts.teammates.list(); // members-only; leader is `this.leader`
  }

  private async activeGroupBinding(): Promise<TeamChannelBindingSummary | null> {
    return activeGroupBindingFor(
      await this.opts.bindings.list(this.dispatcherId),
      this.id,
    );
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
