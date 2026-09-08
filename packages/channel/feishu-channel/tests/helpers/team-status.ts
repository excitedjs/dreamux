import type { TeamStatus, TeamSummary } from '@excitedjs/dreamux-types';

/** Canonical Team summary with a readable leader whose runtime is still lazy. */
export function teamSummary(
  teamName: string,
  status: TeamStatus = 'running',
): TeamSummary {
  return {
    team_name: teamName,
    status,
    intent: 'test Team',
    created_at: 1,
    updated_at: 1,
    closed_at: status === 'closed' ? 1 : null,
    close_note: status === 'closed' ? 'done' : null,
    leader_name: `${teamName}-leader`,
    leader_agent_runtime: 'trae-gpt',
    runtime_cwd: `/workspace/${teamName}`,
    leader_state: status === 'closed' ? 'closed' : 'running',
    leader_session_id: null,
    leader_runtime_status: null,
    leader_intent: 'lead test Team',
    leader_last_error: null,
    leader_closed_at: status === 'closed' ? 1 : null,
    leader_close_note: status === 'closed' ? 'done' : null,
    member_count: 0,
    source_repo: null,
    worktree_mode: 'reuse-cwd',
    worktree_cleanup_mode: 'keep',
    worktree_cleanup: 'not-managed',
  };
}
