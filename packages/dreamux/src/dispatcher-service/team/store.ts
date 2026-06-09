import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dispatcherTeamLedgerPath,
  dispatcherTeamRecordPath,
  dispatcherTeamRecordsDir,
} from '../../platform/paths.js';
import type { TeamLedgerEvent, TeamRecord, TeamStatus } from './types.js';
import { validateTeamId } from './types.js';

export class TeamStore {
  async get(dispatcherId: string, teamId: string): Promise<TeamRecord | null> {
    validateTeamId(teamId);
    try {
      return readTeam(
        dispatcherId,
        teamId,
        await readFile(dispatcherTeamRecordPath(dispatcherId, teamId), 'utf8'),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dispatcherId: string): Promise<TeamRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(dispatcherTeamRecordsDir(dispatcherId));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const teams: TeamRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const team = await this.get(dispatcherId, entry.slice(0, -'.json'.length));
      if (team !== null) teams.push(team);
    }
    return teams;
  }

  async create(input: Omit<TeamRecord, 'version' | 'created_at' | 'updated_at'>): Promise<TeamRecord> {
    const now = Date.now();
    const team: TeamRecord = {
      version: 1,
      ...input,
      created_at: now,
      updated_at: now,
    };
    await this.write(team);
    return team;
  }

  async update(
    team: TeamRecord,
    input: {
      status?: TeamStatus;
      closedAt?: number | null;
      closeNote?: string | null;
      worktree?: TeamRecord['worktree'];
    },
  ): Promise<TeamRecord> {
    const updated: TeamRecord = {
      ...team,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
      ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      updated_at: Date.now(),
    };
    await this.write(updated);
    return updated;
  }

  async appendLedger(
    team: TeamRecord,
    input: Pick<TeamLedgerEvent, 'type' | 'summary'>,
  ): Promise<void> {
    const event: TeamLedgerEvent = {
      version: 1,
      event_id: Date.now(),
      timestamp: Date.now(),
      dispatcher_id: team.dispatcher_id,
      team_id: team.team_id,
      type: input.type,
      summary: input.summary,
    };
    const path = dispatcherTeamLedgerPath(team.dispatcher_id, team.team_id);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  async ledger(dispatcherId: string, teamId: string): Promise<TeamLedgerEvent[]> {
    validateTeamId(teamId);
    let raw: string;
    try {
      raw = await readFile(dispatcherTeamLedgerPath(dispatcherId, teamId), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => readLedgerEvent(dispatcherId, teamId, JSON.parse(line) as unknown))
      .sort((a, b) => a.timestamp - b.timestamp || a.event_id - b.event_id);
  }

  private async write(team: TeamRecord): Promise<void> {
    const path = dispatcherTeamRecordPath(team.dispatcher_id, team.team_id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(team, null, 2)}\n`, { mode: 0o600 });
  }
}

function readTeam(dispatcherId: string, teamId: string, raw: string): TeamRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    value['version'] !== 1 ||
    value['dispatcher_id'] !== dispatcherId ||
    value['team_id'] !== teamId ||
    typeof value['name'] !== 'string' ||
    typeof value['leader_name'] !== 'string'
  ) {
    throw new Error(`invalid Team record ${JSON.stringify(teamId)}`);
  }
  return value as unknown as TeamRecord;
}

function readLedgerEvent(
  dispatcherId: string,
  teamId: string,
  value: unknown,
): TeamLedgerEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid Team ledger event');
  }
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    record['dispatcher_id'] !== dispatcherId ||
    record['team_id'] !== teamId ||
    typeof record['timestamp'] !== 'number' ||
    typeof record['event_id'] !== 'number' ||
    typeof record['summary'] !== 'string'
  ) {
    throw new Error(`invalid Team ledger event for ${JSON.stringify(teamId)}`);
  }
  return record as unknown as TeamLedgerEvent;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
