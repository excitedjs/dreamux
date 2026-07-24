import { readFile, readdir } from 'node:fs/promises';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import {
  dispatcherTeamDir,
  dispatcherTeamRecordPath,
} from '../../platform/paths.js';
import type { TeamRecord, TeamStatus } from './types.js';
import { validateTeamId } from './types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';

export class TeamStore {
  constructor(private readonly coreEvents?: DispatcherCoreEventPublisher) {}

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
    let entries: import('node:fs').Dirent[];
    try {
      // One directory per team (issue #233 symmetric layout); the team record is
      // `team/<team>/record.json`. Blind-scan the collection of team dirs.
      entries = await readdir(dispatcherTeamDir(dispatcherId), {
        withFileTypes: true,
      });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const teams: TeamRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const team = await this.get(dispatcherId, entry.name);
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
    this.publishState(team);
    return team;
  }

  async update(
    team: TeamRecord,
    input: {
      status?: TeamStatus;
      closedAt?: number | null;
      closeNote?: string | null;
      /**
       * Generation-owned facts must move together when a closed Team is
       * recreated. Keeping any field from the prior generation would make
       * route projections and newly spawned members use a stale workspace.
       */
      generation?: {
        repoCwd: string;
        sourceRepo: string | null;
        leaderAgentRuntime: string;
        runtimeCwd: string;
        worktree: TeamRecord['worktree'];
      };
      worktree?: TeamRecord['worktree'];
      intent?: string;
      leaderName?: string;
    },
  ): Promise<TeamRecord> {
    const updated: TeamRecord = {
      ...team,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
      ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
      ...(input.generation !== undefined
        ? {
            repo_cwd: input.generation.repoCwd,
            source_repo: input.generation.sourceRepo,
            leader_agent_runtime: input.generation.leaderAgentRuntime,
            runtime_cwd: input.generation.runtimeCwd,
            worktree: input.generation.worktree,
          }
        : {}),
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      // Recreating a closed Team allocates a FRESH concrete leader name (#188:
      // concrete names are never reused), so the reused record adopts it.
      ...(input.leaderName !== undefined ? { leader_name: input.leaderName } : {}),
      // Recreating a closed Team must refresh the recovery subject so the reused
      // record carries the new create.intent, not a stale one (issue #182 PR-3).
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      updated_at: Date.now(),
    };
    await this.write(updated);
    if (
      updated.status !== team.status ||
      updated.leader_name !== team.leader_name
    ) {
      this.publishState(updated);
    }
    return updated;
  }

  private publishState(team: TeamRecord): void {
    this.coreEvents?.publish(team.dispatcher_id, {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: team.updated_at,
      team_name: team.team_id,
      leader_name: team.leader_name,
      status: team.status,
    });
  }

  private async write(team: TeamRecord): Promise<void> {
    const path = dispatcherTeamRecordPath(team.dispatcher_id, team.team_id);
    await writeFileAtomic(path, `${JSON.stringify(team, null, 2)}\n`);
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
