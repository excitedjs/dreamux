import { readFile, readdir } from 'node:fs/promises';

import {
  writeFileAtomic,
  writeFileExclusiveAtomic,
} from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import {
  dispatcherTeamDir,
  dispatcherTeamNameClaimPath,
  dispatcherTeamRecordPath,
} from '../../platform/paths.js';
import type { TeamDissolveRecord, TeamRecord, TeamStatus } from './types.js';
import { validateTeamId } from './types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import { KeyedAsyncQueue } from '../serial-queue.js';

export class TeamStore {
  private readonly writes = new KeyedAsyncQueue();

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

  /**
   * Atomically claim one concrete Team name. Existing claims are idempotent
   * only for the same opaque token; a legacy Team record without a claim still
   * reserves its name forever.
   */
  async claimName(
    dispatcherId: string,
    teamId: string,
    claimToken: string,
  ): Promise<boolean> {
    validateTeamId(teamId);
    requireClaimToken(claimToken);
    if (await this.get(dispatcherId, teamId) !== null) return false;
    const path = dispatcherTeamNameClaimPath(dispatcherId, teamId);
    const claim: TeamNameClaimRecord = {
      version: 1,
      dispatcher_id: dispatcherId,
      team_name: teamId,
      claim_token: claimToken,
      created_at: Date.now(),
    };
    const published = await writeFileExclusiveAtomic(
      path,
      `${JSON.stringify(claim, null, 2)}\n`,
    );
    if (!published) {
      const existing = await this.readNameClaim(dispatcherId, teamId);
      return existing.claim_token === claimToken;
    }
    // A legacy writer could have materialized the Team between the preflight
    // check and the claim file creation. Preserve the claim but report taken.
    return await this.get(dispatcherId, teamId) === null;
  }

  async requireNameClaim(
    dispatcherId: string,
    teamId: string,
    claimToken: string,
  ): Promise<void> {
    requireClaimToken(claimToken);
    const claim = await this.readNameClaim(dispatcherId, teamId);
    if (claim.claim_token !== claimToken) {
      throw new Error(
        `Team name ${JSON.stringify(teamId)} is claimed by another owner`,
      );
    }
  }

  async create(
    input: Omit<
      TeamRecord,
      'version' | 'created_at' | 'updated_at' | 'dissolve'
    > & { dissolve?: TeamDissolveRecord | null },
    claimToken: string,
  ): Promise<TeamRecord> {
    await this.requireNameClaim(
      input.dispatcher_id,
      input.team_id,
      claimToken,
    );
    if (await this.get(input.dispatcher_id, input.team_id) !== null) {
      throw new Error(
        `Team ${JSON.stringify(input.team_id)} already exists; concrete Team names are never reused`,
      );
    }
    const now = Date.now();
    const team: TeamRecord = {
      version: 1,
      ...input,
      dissolve: input.dissolve ?? null,
      created_at: now,
      updated_at: now,
    };
    await this.write(team);
    this.publishState(team);
    return team;
  }

  private async readNameClaim(
    dispatcherId: string,
    teamId: string,
  ): Promise<TeamNameClaimRecord> {
    const path = dispatcherTeamNameClaimPath(dispatcherId, teamId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(
          `Team name ${JSON.stringify(teamId)} has no persistent claim`,
        );
      }
      throw err;
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value['version'] !== 1 ||
      value['dispatcher_id'] !== dispatcherId ||
      value['team_name'] !== teamId ||
      typeof value['claim_token'] !== 'string' ||
      typeof value['created_at'] !== 'number'
    ) {
      throw new Error(`invalid Team name claim ${JSON.stringify(teamId)}`);
    }
    return value as unknown as TeamNameClaimRecord;
  }

  async update(
    team: TeamRecord,
    input: {
      status?: TeamStatus;
      closedAt?: number | null;
      closeNote?: string | null;
      worktree?: TeamRecord['worktree'];
      intent?: string;
      leaderName?: string;
      dissolve?: TeamDissolveRecord | null;
      dissolvePatch?: Partial<Pick<
        TeamDissolveRecord,
        'phase' | 'last_error' | 'cleanup_attempts' | 'next_retry_at'
      >>;
      appendTargetHandoffId?: string;
      expectedDissolveOperationId?: string | null;
    },
  ): Promise<TeamRecord> {
    const key = `${team.dispatcher_id}\0${team.team_id}`;
    return this.writes.run(key, async () => {
      // Merge against the authoritative current row rather than the caller's
      // snapshot so TeamService resource writes cannot erase a concurrently
      // persisted TeamCollection dissolve lifecycle.
      const current =
        (await this.get(team.dispatcher_id, team.team_id)) ?? team;
      if (
        input.expectedDissolveOperationId !== undefined &&
        (current.dissolve?.operation_id ?? null) !==
          input.expectedDissolveOperationId
      ) {
        throw new Error(
          `Team ${JSON.stringify(team.team_id)} dissolve operation changed`,
        );
      }
      if (
        input.dissolve !== undefined &&
        (input.dissolvePatch !== undefined ||
          input.appendTargetHandoffId !== undefined)
      ) {
        throw new Error('Team dissolve replacement cannot be combined with a patch');
      }
      let nextDissolve = current.dissolve;
      if (input.dissolve !== undefined) {
        nextDissolve = input.dissolve;
        if (
          nextDissolve !== null &&
          current.dissolve?.operation_id === nextDissolve.operation_id
        ) {
          nextDissolve = {
            ...nextDissolve,
            target_handoff_ids: [...new Set([
              ...current.dissolve.target_handoff_ids,
              ...nextDissolve.target_handoff_ids,
            ])],
          };
        }
      } else if (
        input.dissolvePatch !== undefined ||
        input.appendTargetHandoffId !== undefined
      ) {
        if (current.dissolve === null) {
          throw new Error('Team has no dissolve operation to update');
        }
        if (
          input.appendTargetHandoffId !== undefined &&
          input.appendTargetHandoffId.trim() === ''
        ) {
          throw new Error('Team target dissolve handoff id must be non-empty');
        }
        nextDissolve = {
          ...current.dissolve,
          ...(input.dissolvePatch ?? {}),
          ...(input.appendTargetHandoffId === undefined ||
            current.dissolve.target_handoff_ids.includes(
              input.appendTargetHandoffId,
            )
            ? {}
            : {
                target_handoff_ids: [
                  ...current.dissolve.target_handoff_ids,
                  input.appendTargetHandoffId,
                ],
              }),
        };
      }
      const updated: TeamRecord = {
        ...current,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
        ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
        ...(input.leaderName !== undefined
          ? { leader_name: input.leaderName }
          : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.dissolve !== undefined ||
          input.dissolvePatch !== undefined ||
          input.appendTargetHandoffId !== undefined
          ? { dissolve: nextDissolve }
          : {}),
        updated_at: Date.now(),
      };
      await this.write(updated);
      if (
        updated.status !== current.status ||
        updated.leader_name !== current.leader_name
      ) {
        this.publishState(updated);
      }
      return updated;
    });
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

interface TeamNameClaimRecord {
  version: 1;
  dispatcher_id: string;
  team_name: string;
  claim_token: string;
  created_at: number;
}

function requireClaimToken(value: string): void {
  if (value.trim() === '') {
    throw new Error('Team name claim token must be non-empty');
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
  return {
    ...(value as unknown as TeamRecord),
    dissolve: readDissolve(value['dissolve']),
  };
}

function readDissolve(value: unknown): TeamDissolveRecord | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Team dissolve record');
  }
  const record = value as Record<string, unknown>;
  const requesterKind = record['requester_kind'];
  const targetHandoffIds = record['target_handoff_ids'] ?? [];
  const leaderGenerationIsValid = requesterKind === 'team_leader'
    ? typeof record['leader_name'] === 'string' &&
      record['leader_name'].trim() !== ''
    : record['leader_name'] === null;
  const terminalRetryIsValid =
    (record['phase'] !== 'complete' && record['phase'] !== 'failed') ||
    record['next_retry_at'] === null;
  const terminalErrorIsValid =
    (record['phase'] !== 'complete' || record['last_error'] === null) &&
    (record['phase'] !== 'failed' || record['last_error'] !== null);
  if (
    typeof record['operation_id'] !== 'string' ||
    record['operation_id'].trim() === '' ||
    (requesterKind !== 'dispatcher' &&
      requesterKind !== 'team_leader' &&
      requesterKind !== 'collaboration_target') ||
    !leaderGenerationIsValid ||
    (!Array.isArray(targetHandoffIds) ||
      targetHandoffIds.some(
        (handoffId) =>
          typeof handoffId !== 'string' || handoffId.trim() === '',
      ) ||
      new Set(targetHandoffIds).size !== targetHandoffIds.length) ||
    typeof record['note'] !== 'string' ||
    record['note'].trim() === '' ||
    typeof record['accepted_at'] !== 'number' ||
    !isDissolvePhase(record['phase']) ||
    !isDissolveError(record['last_error']) ||
    !terminalRetryIsValid ||
    !terminalErrorIsValid ||
    !Number.isInteger(record['cleanup_attempts']) ||
    (record['cleanup_attempts'] as number) < 0 ||
    (record['next_retry_at'] !== null &&
      typeof record['next_retry_at'] !== 'number')
  ) {
    throw new Error('invalid Team dissolve record');
  }
  return {
    ...(record as unknown as TeamDissolveRecord),
    target_handoff_ids: targetHandoffIds as string[],
  };
}

function isDissolveError(value: unknown): boolean {
  return value === null ||
    value === 'worktree-dirty' ||
    value === 'worktree-unmerged' ||
    value === 'worktree-unique-commits' ||
    value === 'worktree-assessment-failed' ||
    value === 'resource-close-failed' ||
    value === 'worktree-cleanup-failed';
}

function isDissolvePhase(value: unknown): boolean {
  return value === 'waiting_for_team_idle' ||
    value === 'closing_resources' ||
    value === 'worktree_cleanup_pending' ||
    value === 'complete' ||
    value === 'failed';
}
