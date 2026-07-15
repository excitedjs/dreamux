export function previewTeamText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

export function teamErrorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
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
import type { TeamRecord, TeamView } from './types.js';
