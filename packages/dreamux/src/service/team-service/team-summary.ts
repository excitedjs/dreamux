import type { TeamSummary } from '@excitedjs/dreamux-types';
import type { AgentEntityRuntimeStatus } from '../agent-entity/types.js';
import type { TeamRecord } from '../team-collection/types.js';

/** Stable and workspace facts belong to the Team record; leader facts may be absent. */
export function teamSummary(
  team: TeamRecord,
  leader: AgentEntityRuntimeStatus | null,
  memberCount: number,
): TeamSummary {
  return {
    team_name: team.team_id,
    status: team.status,
    intent: team.intent,
    source_repo: team.source_repo,
    leader_name: team.leader_name,
    leader_agent_runtime: team.leader_agent_runtime,
    runtime_cwd: team.runtime_cwd,
    leader_state: leader?.status ?? null,
    leader_session_id: leader?.session_id ?? null,
    leader_runtime_status: leader?.runtime_status ?? null,
    leader_intent: leader?.intent ?? null,
    leader_last_error: leader?.last_error ?? null,
    leader_closed_at: leader?.closed_at ?? null,
    leader_close_note: leader?.close_note ?? null,
    member_count: memberCount,
    created_at: team.created_at,
    updated_at: team.updated_at,
    closed_at: team.closed_at,
    close_note: team.close_note,
    worktree_cleanup: team.worktree.cleanup_state,
    worktree_mode: team.worktree.mode,
    worktree_cleanup_mode: team.worktree.cleanup,
  };
}
