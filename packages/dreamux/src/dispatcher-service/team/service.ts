import { Buffer } from 'node:buffer';

import { WorktreeManager } from '../teammate/worktree-manager.js';
import type { TeamMateAgentService, TeamMateSharedWorkspace } from '../teammate/service.js';
import {
  dispatcherPrincipal,
  requireLifecycleText,
  teamLeaderPrincipal,
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
  TeamLedgerResult,
  TeamListRow,
  TeamRecord,
  TeamSummary,
  TeamTransferChannelBackInput,
} from './types.js';
import { validateTeamId } from './types.js';
import type { TeamMateIdentityStatus } from '../teammate/types.js';

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
    const workspace = await this.worktrees.prepare({
      dispatcherId: input.dispatcherId,
      teammateName: `team-${teamId}`,
      cwd: input.repoCwd,
      dispatcherWorkspace: await this.opts.teammates.dispatcherWorkspace(
        input.dispatcherId,
      ),
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
    const leaderDisplayName = `${teamId}-leader`;
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
      displayName: leaderDisplayName,
      prompt,
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
    });
    team = await this.store.update(team, { status: 'running' });
    await this.store.appendLedger(team, {
      type: 'create',
      summary: `created team ${teamId} with leader ${leaderName}`,
    });
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
      team,
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
   * the TeamMate `history` surface. Finds Teams (closed included) by
   * name/status/repo/intent/time, sorted most-recent first, with a cursor. The
   * raw per-team lifecycle event timeline stays internal (`ledger`), not here.
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
        a.name.localeCompare(b.name),
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

  async ledger(dispatcherId: string, teamId: string): Promise<TeamLedgerResult> {
    const team = await this.store.get(dispatcherId, validateTeamId(teamId));
    return {
      team,
      events: await this.store.ledger(dispatcherId, teamId),
    };
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
    // Required dissolve reason — enforced for in-process callers too (issue
    // #182 PR-3); it also feeds the member/leader closes and the ledger.
    requireLifecycleText(input.note, 'Team dissolve note');
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    for (const binding of await this.bindings.list(input.dispatcherId)) {
      if (binding.active && binding.team_id === team.team_id) {
        await this.bindings.transferBack({
          dispatcherId: input.dispatcherId,
          provider: binding.provider,
          chatId: binding.chat_id,
          chatType: binding.chat_type,
        });
      }
    }
    const members = await this.opts.teammates.listScoped(
      teamLeaderPrincipal({
        dispatcherId: input.dispatcherId,
        teamId: team.team_id,
        leaderName: team.leader_name,
      }),
    );
    // dissolve note is required (issue #182 PR-3), so the member/leader close
    // calls and the ledger carry the operator's real reason — no synthetic
    // 'team dissolved' fallback. Internal/system dissolves pass an explicit
    // system-authored note instead.
    for (const member of members) {
      await this.opts.teammates.closeScoped({
        principal: teamLeaderPrincipal({
          dispatcherId: input.dispatcherId,
          teamId: team.team_id,
          leaderName: team.leader_name,
        }),
        name: member.name,
        note: input.note,
      });
    }
    await this.opts.teammates.close({
      dispatcherId: input.dispatcherId,
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
    await this.store.appendLedger(closed, {
      type: 'dissolve',
      summary: input.note,
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
      teamId: team.team_id,
      leaderName: team.leader_name,
    });
    await this.store.appendLedger(team, {
      type: 'bind_channel',
      summary: `bound ${input.provider} ${input.chatType} ${input.chatId}`,
    });
    return binding;
  }

  async transferChannelBack(
    input: TeamTransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    const binding = await this.bindings.transferBack(input);
    if (binding !== null) {
      const team = await this.store.get(input.dispatcherId, binding.team_id);
      if (team !== null) {
        await this.store.appendLedger(team, {
          type: 'transfer_channel_back',
          summary: `transferred ${input.provider} ${input.chatType} ${input.chatId} back to dispatcher`,
        });
      }
    }
    return binding;
  }

  async resolveChannel(input: {
    dispatcherId: string;
    provider: 'builtin:feishu';
    chatId: string;
    chatType: 'group' | 'p2p';
  }): Promise<ChannelBinding | null> {
    const binding = await this.bindings.resolve(input);
    if (binding === null) return null;
    const team = await this.store.get(input.dispatcherId, binding.team_id);
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
      binding.team_id === input.teamId &&
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
      dispatcherPrincipal(input.dispatcherId),
      team.leader_name,
      input.turn,
    );
  }

  async recordLeaderTurn(input: {
    dispatcherId: string;
    leaderName: string;
    summary: string;
  }): Promise<void> {
    const teams = await this.store.list(input.dispatcherId);
    const team = teams.find((item) => item.leader_name === input.leaderName);
    if (team === undefined || team.status === 'closed') return;
    await this.store.appendLedger(team, {
      type: 'leader_turn',
      summary: input.summary,
    });
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
    let leader = null;
    try {
      leader = await this.opts.teammates.status(team.dispatcher_id, team.leader_name);
    } catch {
      leader = null;
    }
    return {
      team,
      leader,
      member_count: await this.memberCount(team),
      binding: await this.activeGroupBinding(team),
    };
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      name: team.team_id,
      team_id: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      repo_cwd: team.repo_cwd,
      worktree_mode: team.worktree.mode,
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
      name: team.team_id,
      team_id: team.team_id,
      status: team.status,
      close_status: team.closed_at === null ? 'open' : 'closed',
      intent: team.intent,
      source_repo: team.source_repo,
      repo_cwd: team.repo_cwd,
      runtime_cwd: team.runtime_cwd,
      worktree: team.worktree,
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
    try {
      return (await this.opts.teammates.status(team.dispatcher_id, team.leader_name))
        .status;
    } catch {
      return null;
    }
  }

  /** The active bound Feishu group for a Team, or null when none is bound. */
  private async activeGroupBinding(
    team: TeamRecord,
  ): Promise<TeamChannelBindingSummary | null> {
    const bindings = await this.bindings.list(team.dispatcher_id);
    const active = bindings.find(
      (binding) => binding.active && binding.team_id === team.team_id,
    );
    return active === undefined
      ? null
      : { provider: active.provider, chat_id: active.chat_id };
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    return (await this.opts.teammates.listScoped(
      teamLeaderPrincipal({
        dispatcherId: team.dispatcher_id,
        teamId: team.team_id,
        leaderName: team.leader_name,
      }),
    )).length;
  }

  private async mustTeam(dispatcherId: string, teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(dispatcherId, validateTeamId(teamId));
    if (team === null) throw new Error(`Team ${JSON.stringify(teamId)} does not exist`);
    return team;
  }
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
  if (input.name !== undefined && row.name !== validateTeamId(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.closeStatus !== undefined && row.close_status !== input.closeStatus) {
    return false;
  }
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit = [row.source_repo, row.repo_cwd].some(
      (value) => value !== null && value.toLowerCase().includes(needle),
    );
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
    row.name,
    row.intent,
    row.source_repo,
    row.repo_cwd,
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
