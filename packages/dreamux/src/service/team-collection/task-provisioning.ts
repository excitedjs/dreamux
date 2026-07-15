import type { PreparedTeamMateWorkspace } from '../worktree/manager.js';
import type { TeamService } from '../team-service/index.js';
import type {
  TaskTeamProvisionInput,
  TeamCreateResult,
  TeamRecord,
} from './types.js';

export function assertTaskProvisioningMatches(
  existing: TeamRecord,
  input: TaskTeamProvisionInput,
  workspace: PreparedTeamMateWorkspace,
): void {
  if (
    existing.leader_agent_runtime !== input.leaderAgentRuntime ||
    existing.repo_cwd !== workspace.sourceCwd ||
    existing.source_repo !== workspace.sourceRepo ||
    existing.runtime_cwd !== workspace.runtimeCwd ||
    JSON.stringify(existing.worktree) !== JSON.stringify(workspace.worktree)
  ) {
    throw new Error(
      `Team ${JSON.stringify(existing.team_id)} conflicts with its provisioning intent`,
    );
  }
}

export function assertTaskFinalizationMatches(
  existing: TeamRecord,
  input: TaskTeamProvisionInput,
): void {
  const worktree = input.worktree;
  if (
    input.repoCwd === undefined ||
    worktree?.mode !== 'managed' ||
    existing.repo_cwd !== input.repoCwd ||
    existing.leader_agent_runtime !== input.leaderAgentRuntime ||
    existing.worktree.mode !== 'managed' ||
    existing.worktree.slug !== (worktree.slug ?? `team-${existing.team_id}`) ||
    existing.worktree.base_ref !== (worktree.base_ref ?? 'HEAD') ||
    (worktree.branch !== undefined && existing.worktree.branch !== worktree.branch)
  ) {
    throw new Error(
      `Team ${JSON.stringify(existing.team_id)} conflicts with finalization intent`,
    );
  }
}

export async function existingTaskTeamResult(
  service: TeamService,
): Promise<TeamCreateResult> {
  return {
    team: service.view(),
    leader: service.leader.status(),
    member_count: await service.memberCount(),
    turn: null,
  };
}
