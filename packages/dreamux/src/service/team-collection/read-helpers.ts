import { matchesGrepText } from '../../platform/history-page.js';
import type { TeamHistoryQuery, TeamHistoryRow } from './types.js';
import { validateTeamId } from './types.js';

export function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (
    input.name !== undefined &&
    row.team_name !== validateTeamId(input.name)
  ) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit =
      row.source_repo !== null &&
      row.source_repo.toLowerCase().includes(needle);
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
  return matchesGrepText(
    [
      row.team_name,
      row.intent,
      row.source_repo,
      row.leader_name,
      row.close_note,
    ],
    grep,
  );
}
