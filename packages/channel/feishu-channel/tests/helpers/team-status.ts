import type { TeamCreateResult } from '@excitedjs/dreamux-types';

/** Canonical stored Team status with a leader whose runtime is still lazy. */
export function teamStatus(teamName: string, status: 'running' | 'closed' = 'running') {
  return {
    team: {
      team_name: teamName,
      status,
      leader_name: `${teamName}-leader`,
      leader_agent_runtime: 'trae-gpt',
    },
    leader: {
      agent_runtime: 'trae-gpt',
      repo: { path: `/workspace/${teamName}` },
      runtime_status: null,
    },
  };
}

/** Canonical `team.create` receipt with the facts needed by its first route card. */
export function teamCreateResult(
  teamName: string,
  status: TeamCreateResult['status'] = 'created',
): TeamCreateResult {
  return {
    status,
    team_name: teamName,
    leader_name: `${teamName}-leader`,
    leader_agent_runtime: 'trae-gpt',
    runtime_cwd: `/workspace/${teamName}`,
  };
}
