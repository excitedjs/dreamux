import { Buffer } from 'node:buffer';

import { WorktreeManager } from '../teammate/worktree-manager.js';
import type { TeamMateAgentService, TeamMateSharedWorkspace } from '../teammate/service.js';
import { requireLifecycleText } from '../teammate/types.js';
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

export interface TeamManagerOptions {
  teammates: TeamMateAgentService;
}

export class TeamManager {
  private readonly store = new TeamStore();
  private readonly worktrees = new WorktreeManager();
  private readonly bindings = new ChannelBindingStore();

  constructor(private readonly opts: TeamManagerOptions) {}

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const teamId = validateTeamId(input.name);
    const existing = await this.store.get(input.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const dispatcherWorkspace = await this.opts.teammates.dispatcherWorkspace(
      input.dispatcherId,
    );
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
      intent: input.intent,
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
    return {
      team: teamView(team),
      leader: leader.teammate,
      member_count: await this.memberCount(team),
      binding: null,
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
    requireLifecycleText(input.note, 'Team dissolve note');
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    for (const binding of await this.bindings.list(input.dispatcherId)) {
      if (binding.active && binding.team_name === team.team_id) {
        await this.bindings.transferBack({
          dispatcherId: input.dispatcherId,
          channelId: binding.channel_id,
          targetKey: binding.target_key,
        });
      }
    }
    const members = await this.members(team);
    for (const member of members) {
      await this.opts.teammates.close({
        dispatcherId: team.dispatcher_id,
        teamId: team.team_id,
        name: member.name,
        note: input.note,
      });
    }
    await this.opts.teammates.close({
      dispatcherId: team.dispatcher_id,
      teamId: team.team_id,
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
    return this.bindings.bind({
      dispatcherId: input.dispatcherId,
      channelId: input.channelId,
      provider: input.provider,
      target: input.target,
      teamName: team.team_id,
      leaderName: team.leader_name,
    });
  }

  async transferChannelBack(
    input: TeamTransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.bindings.transferBack(input);
  }

  async resolveChannel(input: {
    dispatcherId: string;
    channelId: string;
    targetKey: string;
  }): Promise<ChannelBinding | null> {
    const binding = await this.bindings.resolve(input);
    if (binding === null) return null;
    const team = await this.store.get(input.dispatcherId, binding.team_name);
    if (team === null || team.status === 'closed') return null;
    return binding;
  }

    async resolveLeaderChannel(input: {
    dispatcherId: string;
    teamId: string;
    leaderName: string;
    targetKey: string;
  }): Promise<string | null> {
    const bindings = await this.bindings.list(input.dispatcherId);
    const match = bindings.find(
      (binding) =>
        binding.active &&
        binding.target_key === input.targetKey &&
        binding.team_name === input.teamId &&
        binding.leader_name === input.leaderName,
    );
    if (match === undefined) return null;
    const team = await this.store.get(input.dispatcherId, match.team_name);
    if (team === null || team.status === 'closed') return null;
    return match.channel_id;
  }

  async deliverToLeader(input: {
    dispatcherId: string;
    teamId: string;
    turn: import('@excitedjs/dreamux-types').InboundTurnInput;
  }): Promise<import('@excitedjs/dreamux-types').AgentRuntimeTurnResult> {
    const team = await this.mustTeam(input.dispatcherId, input.teamId);
    if (team.status === 'closed') return { status: 'stopped' };
    return this.opts.teammates.channelInput(
      team.dispatcher_id,
      team.team_id,
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
    const leader = await this.opts.teammates
      .status(team.dispatcher_id, team.leader_name, team.team_id)
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

    private async leaderState(
    team: TeamRecord,
  ): Promise<TeamMateIdentityStatus | null> {
    const leader = await this.opts.teammates
      .status(team.dispatcher_id, team.leader_name, team.team_id)
      .catch(() => null);
    return leader?.status ?? null;
  }

    private async activeGroupBinding(
    team: TeamRecord,
  ): Promise<TeamChannelBindingSummary | null> {
    const bindings = await this.bindings.list(team.dispatcher_id);
    const active = bindings.find(
      (binding) => binding.active && binding.team_name === team.team_id,
    );
    if (active === undefined) return null;
    const chatId = active.meta['chat_id'];
    return {
      provider: active.provider,
      chat_id: typeof chatId === 'string' ? chatId : active.target_key,
    };
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    return (await this.members(team)).length;
  }

    private async members(team: TeamRecord): Promise<TeamMateRuntimeStatus[]> {
    return (
      await this.opts.teammates.list(team.dispatcher_id, team.team_id)
    ).filter((member) => member.name !== team.leader_name);
  }

  private async mustTeam(dispatcherId: string, teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(dispatcherId, validateTeamId(teamId));
    if (team === null) throw new Error(`Team ${JSON.stringify(teamId)} does not exist`);
    return team;
  }
}

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
  }
  throw new Error('invalid history cursor');
}

function previewTeamText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}
