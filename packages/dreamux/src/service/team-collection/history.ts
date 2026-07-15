import { Buffer } from 'node:buffer';

import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentEntityIdentityStatus } from '../agent-entity/types.js';
import { previewTeamText } from './format.js';
import type { TeamStore } from './store.js';
import type {
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamListRow,
  TeamRecord,
} from './types.js';
import { validateTeamId } from './types.js';

export class TeamCollectionReadModel {
  constructor(
    private readonly dispatcherId: string,
    private readonly store: TeamStore,
    private readonly identities: AgentIdentityStore,
  ) {}

  async list(): Promise<TeamListRow[]> {
    const teams = await this.store.list(this.dispatcherId);
    return Promise.all(teams.map((team) => this.listRow(team)));
  }

  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    const teams = await this.store.list(this.dispatcherId);
    const rows = (await Promise.all(teams.map((team) => this.historyRow(team))))
      .filter((row) => matchesTeamHistoryQuery(row, input));
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

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
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
  ): Promise<AgentEntityIdentityStatus | null> {
    const leader = await this.identities
      .get(this.dispatcherId, team.leader_name, team.team_id)
      .catch(() => null);
    return leader?.status ?? null;
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    return (await this.identities.list(this.dispatcherId, team.team_id)).length;
  }
}

export function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (input.name !== undefined && row.team_name !== validateTeamId(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit =
      row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
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

export function clampTeamHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

export function encodeTeamCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeTeamCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
  } catch {
    // Fall through to the stable public validation error below.
  }
  throw new Error('invalid history cursor');
}
