import { WorktreeManager } from '../teammate/worktree-manager.js';
import type { TeamMateAgentService, TeamMateSharedWorkspace } from '../teammate/service.js';
import { dispatcherPrincipal, teamLeaderPrincipal } from '../teammate/types.js';
import { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import type { FeishuCreateGroupInput, FeishuCreateGroupResult } from '../../channel/feishu/bot.js';
import { TeamStore } from './store.js';
import type {
  TeamBindChannelInput,
  TeamCreateGroupInput,
  TeamCreateGroupResult,
  TeamCreateInput,
  TeamCreateResult,
  TeamDissolveInput,
  TeamLedgerResult,
  TeamRecord,
  TeamSummary,
  TeamTransferChannelBackInput,
} from './types.js';
import { validateTeamId } from './types.js';

export interface TeamServiceOptions {
  teammates: TeamMateAgentService;
  createFeishuGroup?: (
    input: FeishuCreateGroupInput & { dispatcherId: string },
  ) => Promise<FeishuCreateGroupResult>;
}

export class TeamService {
  private readonly store = new TeamStore();
  private readonly worktrees = new WorktreeManager();
  private readonly bindings = new ChannelBindingStore();

  constructor(private readonly opts: TeamServiceOptions) {}

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    const teamId = validateTeamId(input.name);
    const existing = await this.store.get(input.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const workspace = await this.worktrees.prepare({
      dispatcherId: input.dispatcherId,
      teammateName: `team-${teamId}`,
      cwd: input.repoCwd,
      request: input.worktree ?? {
        mode: 'managed',
        slug: `team-${teamId}`,
        cleanup: 'keep',
      },
    });
    const leaderName = `${teamId}-leader`;
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
        intent: input.intent ?? null,
        closed_at: null,
        close_note: null,
      }));
    team = await this.store.update(team, {
      status: 'starting',
      closedAt: null,
      closeNote: null,
      worktree: workspace.worktree,
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
      intent: input.intent ?? null,
    });
    team = await this.store.update(team, { status: 'running' });
    await this.store.appendLedger(team, {
      type: 'create',
      summary: `created team ${teamId} with leader ${leaderName}`,
    });
    return {
      team,
      leader: leader.teammate,
      member_count: await this.memberCount(team),
      turn: leader.turn,
    };
  }

  async list(dispatcherId: string): Promise<TeamSummary[]> {
    const teams = await this.store.list(dispatcherId);
    const out: TeamSummary[] = [];
    for (const team of teams) out.push(await this.summary(team));
    return out;
  }

  async status(dispatcherId: string, teamId: string): Promise<TeamSummary> {
    const team = await this.mustTeam(dispatcherId, teamId);
    return this.summary(team);
  }

  async ledger(dispatcherId: string, teamId: string): Promise<TeamLedgerResult> {
    const team = await this.store.get(dispatcherId, validateTeamId(teamId));
    return {
      team,
      events: await this.store.ledger(dispatcherId, teamId),
    };
  }

  async dissolve(input: TeamDissolveInput): Promise<TeamSummary> {
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
    for (const member of members) {
      await this.opts.teammates.closeScoped({
        principal: teamLeaderPrincipal({
          dispatcherId: input.dispatcherId,
          teamId: team.team_id,
          leaderName: team.leader_name,
        }),
        name: member.name,
        note: input.note ?? 'team dissolved',
      });
    }
    await this.opts.teammates.close({
      dispatcherId: input.dispatcherId,
      name: team.leader_name,
      note: input.note ?? 'team dissolved',
    });
    const closed = await this.store.update(team, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note ?? null,
      worktree: await this.worktrees.cleanup({
        source_cwd: team.repo_cwd,
        source_repo: team.source_repo,
        worktree: team.worktree,
      }),
    });
    await this.store.appendLedger(closed, {
      type: 'dissolve',
      summary: input.note ?? 'team dissolved',
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

  async createGroup(input: TeamCreateGroupInput): Promise<TeamCreateGroupResult> {
    if (input.sourceChatType !== 'p2p') {
      throw new Error('create_team_group must be requested from a P2P control channel');
    }
    if (this.opts.createFeishuGroup === undefined) {
      throw new Error('Feishu group creation is not available for this dispatcher');
    }
    const created = await this.create(input);
    let group: FeishuCreateGroupResult;
    let binding: ChannelBinding | null = null;
    try {
      group = await this.opts.createFeishuGroup({
        dispatcherId: input.dispatcherId,
        name: input.groupName ?? input.name,
        userOpenIds: uniqueOpenIds([
          input.requesterOpenId,
          ...(input.inviteOpenIds ?? []),
        ]),
      });
      binding = await this.bindChannel({
        dispatcherId: input.dispatcherId,
        teamId: created.team.team_id,
        provider: 'builtin:feishu',
        chatId: group.chatId,
        chatType: 'group',
      });
      await this.store.appendLedger(created.team, {
        type: 'create_group',
        summary: `created Feishu group ${group.chatId} for team ${created.team.team_id}`,
      });
    } catch (err) {
      await this.dissolve({
        dispatcherId: input.dispatcherId,
        teamId: created.team.team_id,
        note: 'Feishu group setup failed',
      });
      throw err;
    }
    return {
      ...created,
      binding: {
        provider: binding.provider,
        chat_id: binding.chat_id,
        chat_type: binding.chat_type,
        team_id: binding.team_id,
        leader_name: binding.leader_name,
      },
      invited_open_ids: uniqueOpenIds([
        input.requesterOpenId,
        ...(input.inviteOpenIds ?? []),
      ]),
    };
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
    };
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

function uniqueOpenIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ''))];
}
