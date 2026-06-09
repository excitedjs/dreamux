import { WorktreeManager } from '../teammate/worktree-manager.js';
import type { TeamMateAgentService, TeamMateSharedWorkspace } from '../teammate/service.js';
import { teamLeaderPrincipal } from '../teammate/types.js';
import { TeamStore } from './store.js';
import type {
  TeamCreateInput,
  TeamCreateResult,
  TeamDissolveInput,
  TeamLedgerResult,
  TeamRecord,
  TeamSummary,
} from './types.js';
import { validateTeamId } from './types.js';

export interface TeamServiceOptions {
  teammates: TeamMateAgentService;
}

export class TeamService {
  private readonly store = new TeamStore();
  private readonly worktrees = new WorktreeManager();

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
