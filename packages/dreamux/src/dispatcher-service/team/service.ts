import { Buffer } from 'node:buffer';

import { WorktreeManager } from '../teammate/worktree-manager.js';
import type { TeamMateAgentService, TeamMateSharedWorkspace } from '../teammate/service.js';
import {
  requireLifecycleText,
  teamServicePrincipal,
} from '../teammate/types.js';
import { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import { TeamStore } from './store.js';
import type {
  TeamBindChannelInput,
  TeamChannelBindingSummary,
  TeamCreateInput,
  TeamCreateResult,
  TeamDissolveInput,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamListRow,
  TeamRecord,
  TeamSummary,
  TeamTransferChannelBackInput,
  TeamView,
} from './types.js';
import { validateTeamId } from './types.js';
import type {
  TeamMateIdentityStatus,
  TeamMateRuntimeStatus,
} from '../teammate/types.js';

export interface TeamServiceOptions {
  teammates: TeamMateAgentService;
}

export class TeamService {
  private readonly store = new TeamStore();
  private readonly worktrees = new WorktreeManager();
  private readonly bindings = new ChannelBindingStore();

  constructor(private readonly opts: TeamServiceOptions) {}

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    // Required recovery subject — enforced for in-process callers too
    // (issue #182 PR-3).
    requireLifecycleText(input.intent, 'Team create intent');
    const teamId = validateTeamId(input.name);
    const existing = await this.store.get(input.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const dispatcherWorkspace = await this.opts.teammates.dispatcherWorkspace(
      input.dispatcherId,
    );
    // #199: no `repo` (no explicit cwd, no worktree request) → a plain
    // `<dispatcher cwd>/.workspace/work/<team_name>/` directory shared by the
    // TeamLeader and every member, NOT a git worktree, so the dispatcher cwd
    // need not be a git repo. An explicit `repo` keeps the prior semantics:
    // reuse-cwd runs in the given cwd; managed (also the in-process default when
    // a repoCwd is supplied) creates a git worktree under the dispatcher
    // workspace.
    const workspace =
      input.worktree === undefined && input.repoCwd === undefined
        ? await this.worktrees.prepareDefaultWorkspace({
            dispatcherWorkspace,
            slug: teamId,
          })
        : await this.worktrees.prepare({
            dispatcherId: input.dispatcherId,
            teammateName: `team-${teamId}`,
            cwd: input.repoCwd ?? dispatcherWorkspace,
            dispatcherWorkspace,
            request: input.worktree ?? {
              mode: 'managed',
              slug: `team-${teamId}`,
              cleanup: 'keep',
            },
          });
    // The TeamLeader address is a concrete, never-reused name (issue #188), not
    // a reconstructed `${teamId}-leader`. ALWAYS allocate a fresh one — including
    // when recreating a closed Team: `createTeamLeader` mints a new session and
    // clears the checkpoint (it does not truly resume the old leader), so reusing
    // the old closed `tl-` name would map one concrete name to multiple sessions
    // and break the name↔session invariant. The old closed leader identity stays
    // untouched. Routing/status/dissolve read the stored leader_name, never
    // recompute it. `${teamId}-leader` survives only as the display label.
    const leaderName = await this.opts.teammates.allocateLeaderName(
      input.dispatcherId,
      teamId,
    );
    let team =
      existing ??
      (await this.store.create({
        dispatcher_id: input.dispatcherId,
        team_id: teamId,
        name: input.name,
        repo_cwd: workspace.sourceCwd,
        source_repo: workspace.sourceRepo,
        leader_name: leaderName,
        leader_agent_runtime: input.leaderAgentRuntime,
        runtime_cwd: workspace.runtimeCwd,
        worktree: workspace.worktree,
        status: 'starting',
        intent: input.intent,
        closed_at: null,
        close_note: null,
      }));
    team = await this.store.update(team, {
      status: 'starting',
      closedAt: null,
      closeNote: null,
      worktree: workspace.worktree,
      // Always write the required intent, so a reused closed Team record adopts
      // the new create.intent instead of keeping its old value (issue #182 PR-3).
      intent: input.intent,
      // Adopt the freshly allocated concrete leader name (#188) so a recreated
      // closed Team routes/statuses/dissolves on the new leader, not the old one.
      leaderName,
    });
    const prompt = input.prompt ?? teamLeaderPrompt(team);
    const leader = await this.opts.teammates.createTeamLeader({
      dispatcherId: input.dispatcherId,
      teamId,
      name: leaderName,
      prompt,
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
    });
    team = await this.store.update(team, { status: 'running' });
    // Optionally bind an existing Feishu group at create time (issue #182 PR-8,
    // the settled replacement for the retired create_group flow). Bind is the
    // last step; if it fails the Team is already persisted, so roll back by
    // dissolving the just-created Team rather than leaving a half-created one a
    // retry would then collide with as "already exists" (mirrors the rollback
    // the old create_group flow did on Feishu setup failure).
    let binding: TeamChannelBindingSummary | null = null;
    if (input.bindGroup !== undefined) {
      try {
        const bound = await this.bindChannel({
          dispatcherId: input.dispatcherId,
          teamId,
          provider: 'builtin:feishu',
          chatId: input.bindGroup.chatId,
          chatType: 'group',
        });
        binding = { provider: bound.provider, chat_id: bound.chat_id };
      } catch (err) {
        await this.dissolve({
          dispatcherId: input.dispatcherId,
          teamId,
          note: 'Team group binding failed at create time',
        });
        throw err;
      }
    }
    return {
      team: teamView(team),
      leader: leader.teammate,
      member_count: await this.memberCount(team),
      binding,
      turn: leader.turn,
    };
  }

  async list(dispatcherId: string): Promise<TeamListRow[]> {
    const teams = await this.store.list(dispatcherId);
    const out: TeamListRow[] = [];
    for (const team of teams) out.push(await this.listRow(team));
    return out;
  }

  async status(dispatcherId: string, teamId: string): Promise<TeamSummary> {
    const team = await this.mustTeam(dispatcherId, teamId);
    return this.summary(team);
  }

  /**
   * Filterable Team recovery search (issue #182 PR-7) — the Team-side mirror of
   * the TeamMate `history` surface. Reads the compact recovery rows straight
   * from the `team/records/<team_name>.json` JSON records (closed included),
   * sorted most-recent first, with a cursor. There is no team event/audit
   * archive to fold (issue #199 Slice 3 removed it).
   */
  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    const teams = await this.store.list(input.dispatcherId);
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

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    // Required dissolve reason — enforced for in-process callers too (issue
    // #182 PR-3); it also feeds the member/leader closes.
    requireLifecycleText(input.note, 'Team dissolve note');
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    for (const binding of await this.bindings.list(input.dispatcherId)) {
      if (binding.active && binding.team_name === team.team_id) {
        await this.bindings.transferBack({
          dispatcherId: input.dispatcherId,
          provider: binding.provider,
          chatId: binding.chat_id,
          chatType: binding.chat_type,
        });
      }
    }
    const principal = this.teamPrincipal(team);
    const members = await this.members(team);
    // dissolve note is required (issue #182 PR-3), so the member/leader close
    // calls carry the operator's real reason — no synthetic 'team dissolved'
    // fallback. Internal/system dissolves pass an explicit system-authored note.
    for (const member of members) {
      await this.opts.teammates.closeScoped({
        principal,
        name: member.name,
        note: input.note,
      });
    }
    await this.opts.teammates.closeScoped({
      principal,
      name: team.leader_name,
      note: input.note,
    });
    const closed = await this.store.update(team, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      worktree: await this.worktrees.cleanup({
        source_cwd: team.repo_cwd,
        source_repo: team.source_repo,
        worktree: team.worktree,
      }),
    });
    return this.summary(closed);
  }

  async bindChannel(input: TeamBindChannelInput): Promise<ChannelBinding> {
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    if (team.status === 'closed') {
      throw new Error(`Team ${JSON.stringify(input.teamId)} is closed`);
    }
    const binding = await this.bindings.bind({
      dispatcherId: input.dispatcherId,
      provider: input.provider,
      chatId: input.chatId,
      chatType: input.chatType,
      teamName: team.team_id,
      leaderName: team.leader_name,
    });
    return binding;
  }

  async transferChannelBack(
    input: TeamTransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.bindings.transferBack(input);
  }

  async resolveChannel(input: {
    dispatcherId: string;
    provider: 'builtin:feishu';
    chatId: string;
    chatType: 'group' | 'p2p';
  }): Promise<ChannelBinding | null> {
    const binding = await this.bindings.resolve(input);
    if (binding === null) return null;
    const team = await this.store.get(input.dispatcherId, binding.team_name);
    if (team === null || team.status === 'closed') return null;
    return binding;
  }

  async teamLeaderCanUseChannel(input: {
    dispatcherId: string;
    teamId: string;
    leaderName: string;
    provider: 'builtin:feishu';
    chatId: string;
  }): Promise<boolean> {
    const binding = await this.bindings.resolve({
      dispatcherId: input.dispatcherId,
      provider: input.provider,
      chatId: input.chatId,
      chatType: 'group',
    });
    return (
      binding !== null &&
      binding.team_name === input.teamId &&
      binding.leader_name === input.leaderName
    );
  }

  async deliverToLeader(input: {
    dispatcherId: string;
    teamId: string;
    turn: import('../../agent-runtime/turn.js').InboundTurnInput;
  }): Promise<import('../../agent-runtime/types.js').AgentRuntimeTurnResult> {
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    if (team.status === 'closed') return { status: 'stopped' };
    return this.opts.teammates.channelInputScoped(
      this.teamPrincipal(team),
      team.leader_name,
      input.turn,
    );
  }

  async sharedWorkspace(
    dispatcherId: string,
    teamId: string,
  ): Promise<TeamMateSharedWorkspace> {
    const team = await this.mustTeam(dispatcherId, teamId);
    return {
      sourceCwd: team.repo_cwd,
      sourceRepo: team.source_repo,
      runtimeCwd: team.runtime_cwd,
      worktree: team.worktree,
    };
  }

  private async summary(team: TeamRecord): Promise<TeamSummary> {
    // #199 Slice 4: the leader is read with the internal Team-service authority —
    // a TeamLeader is not visible on the dispatcher `teammate.*` surface.
    const leader = await this.opts.teammates
      .statusScoped(this.teamPrincipal(team), team.leader_name)
      .catch(() => null);
    return {
      team: teamView(team),
      leader,
      member_count: await this.memberCount(team),
      binding: await this.activeGroupBinding(team),
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
      bound_group: await this.activeGroupBinding(team),
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
      bound_group: await this.activeGroupBinding(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      close_note: team.close_note,
      close_note_preview:
        team.close_note !== null ? previewTeamText(team.close_note) : null,
    };
  }

  /** The leader's current identity state (cheap read), or null if unreadable. */
  private async leaderState(
    team: TeamRecord,
  ): Promise<TeamMateIdentityStatus | null> {
    const leader = await this.opts.teammates
      .statusScoped(this.teamPrincipal(team), team.leader_name)
      .catch(() => null);
    return leader?.status ?? null;
  }

  /** The internal Team-service authority over this Team (issue #199 Slice 4). */
  private teamPrincipal(team: TeamRecord) {
    return teamServicePrincipal({
      dispatcherId: team.dispatcher_id,
      teamId: team.team_id,
      leaderName: team.leader_name,
    });
  }

  /** The active bound Feishu group for a Team, or null when none is bound. */
  private async activeGroupBinding(
    team: TeamRecord,
  ): Promise<TeamChannelBindingSummary | null> {
    const bindings = await this.bindings.list(team.dispatcher_id);
    const active = bindings.find(
      (binding) => binding.active && binding.team_name === team.team_id,
    );
    return active === undefined
      ? null
      : { provider: active.provider, chat_id: active.chat_id };
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    return (await this.members(team)).length;
  }

  /**
   * The Team's members only (issue #199 Slice 4): the internal Team-service
   * authority can see both the leader and the members, so the leader (known by
   * its concrete name) is filtered out of member listings.
   */
  private async members(team: TeamRecord): Promise<TeamMateRuntimeStatus[]> {
    return (await this.opts.teammates.listScoped(this.teamPrincipal(team))).filter(
      (member) => member.name !== team.leader_name,
    );
  }

  private async mustTeam(dispatcherId: string, teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(dispatcherId, validateTeamId(teamId));
    if (team === null) throw new Error(`Team ${JSON.stringify(teamId)} does not exist`);
    return team;
  }
}

/**
 * Project the persisted {@link TeamRecord} into the public {@link TeamView}
 * (issue #199 Slice 2): concrete `team_name`, no duplicate `name`/`team_id`, no
 * machine-local `repo_cwd`/`runtime_cwd`/`worktree`.
 */
function teamView(team: TeamRecord): TeamView {
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

function teamLeaderPrompt(team: TeamRecord): string {
  return [
    'You are the TeamLeader for this Dreamux team.',
    `Team: ${team.name}`,
    `Repository cwd: ${team.repo_cwd}`,
    team.intent !== null ? `Intent: ${team.intent}` : '',
  ].filter((line) => line !== '').join('\n');
}

function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (input.name !== undefined && row.team_name !== validateTeamId(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit = row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
    if (!hit) return false;
  }
  if (input.grep !== undefined && !teamRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.updated_at < input.since) return false;
  if (input.until !== undefined && row.updated_at > input.until) return false;
  return true;
}

function teamRowMatchesText(row: TeamHistoryRow, grep: string): boolean {
  const needle = grep.toLowerCase();
  if (needle === '') return true;
  return [
    row.team_name,
    row.intent,
    row.source_repo,
    row.leader_name,
    row.close_note,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function clampTeamHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

function encodeTeamCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeTeamCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
    // fall through to the loud error below
  }
  throw new Error('invalid history cursor');
}

function previewTeamText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}
