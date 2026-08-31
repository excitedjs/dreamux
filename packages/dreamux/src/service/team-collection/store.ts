/**
 * The durable Team store.
 *
 * `team/<team>/record.json` is the single authority for a Team: a valid,
 * readable record is the only proof that Team exists and the only thing that
 * occupies its concrete name. {@link TeamStore.create} publishes it
 * exclusively, and that publication — not any earlier reservation — is the
 * atomic acceptance point under the single-server/single-writer model.
 *
 * The store is bound to the `team/` collection root its owner resolved, and
 * appends only the concrete Team name to it.
 */
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import type { TeamStateTeammateSummary } from '@excitedjs/dreamux-types';

import type { AgentEntityWorktreeIdentity } from '../agent-entity/types.js';

import {
  writeFileAtomic,
  writeFileExclusiveAtomic,
} from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { collectionEntityDir } from '../../platform/paths.js';
import { parseAgentRuntimeSkillSources } from '../../agent-runtime/skill-sources.js';
import { TeamNotFoundError } from './errors.js';
import {
  isTeamCreatePayloadHash,
  isTeamCreateRequestId,
} from './create-request.js';
import type { TeamRecord, TeamStatus } from './types.js';
import { validateTeamId } from './types.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import { KeyedAsyncQueue } from '../serial-queue.js';

export class TeamStore {
  private readonly writes = new KeyedAsyncQueue();

  constructor(
    private readonly opts: {
      /** `<dispatcher>/team` — one child directory per Team. */
      root: string;
      dispatcherId: string;
      coreEvents?: DispatcherCoreEventPublisher;
      /**
       * This Team's complete contained-Agent summary, asked for at publication
       * time. The store owns no roster: a Team's Agents belong to their own
       * owners, and this asks whichever of them is authoritative right now.
       * The record goes with the question because it is the authority for
       * which Agents this Team contains, starting with its leader's name.
       *
       * `null` means the roster could not be established, and no aggregate is
       * published — an empty array is the answer "this Team has no Agents".
       *
       * It is awaited after the durable write rather than called from inside
       * one, and it must never materialize a Team: this runs inside the
       * per-Team write queue that materialization itself writes through.
       */
      roster?: (
        team: TeamRecord,
      ) => Promise<readonly TeamStateTeammateSummary[] | null>;
    },
  ) {}

  /** This Team's own root directory: the collection root plus its name. */
  teamRoot(teamId: string): string {
    return collectionEntityDir(this.opts.root, validateTeamId(teamId));
  }

  private recordPath(teamId: string): string {
    return join(this.teamRoot(teamId), 'record.json');
  }

  /**
   * The Team at this concrete name, or `null` when there is none.
   *
   * Missing, malformed, and unreadable are the same answer on purpose: only a
   * valid record proves a Team exists, so anything else is nonexistent for
   * lookup, routing, and name allocation and can never receive a turn or
   * reserve a name. The name check itself still throws — an invalid team id is
   * a caller defect, not a missing Team.
   */
  async get(teamId: string): Promise<TeamRecord | null> {
    validateTeamId(teamId);
    let raw: string;
    try {
      raw = await readFile(this.recordPath(teamId), 'utf8');
    } catch {
      return null;
    }
    try {
      return readTeam(this.opts.dispatcherId, teamId, raw);
    } catch {
      return null;
    }
  }

  async list(): Promise<TeamRecord[]> {
    let entries: import('node:fs').Dirent[];
    try {
      // One directory per team (issue #233 symmetric layout); the team record is
      // `team/<team>/record.json`. Blind-scan the collection of team dirs.
      entries = await readdir(this.opts.root, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const teams: TeamRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const team = await this.get(entry.name);
      if (team !== null) teams.push(team);
    }
    return teams;
  }

  /**
   * Publish one Team record, or report that the candidate name is taken.
   *
   * The exclusive create is the whole acceptance protocol: before it the
   * request is unaccepted, no Team exists, and the candidate name is free, so a
   * caller that loses the race — or crashes earlier — may simply choose another
   * name.
   *
   * Three outcomes, and only three. Publication succeeded: the record now owns
   * the name. A VALID record is already there: the name belongs to a live Team,
   * so this returns `null` and the caller allocates another candidate — losing
   * a publish race after an earlier probe is the same ordinary answer as losing
   * the probe. Anything else there — malformed, unreadable, half-written — is
   * not a Team and holds no claim on the name, so the new record atomically
   * replaces it under the single-writer model. A real filesystem failure is
   * none of those and surfaces.
   */
  async create(
    input: Omit<
      TeamRecord,
      'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'
    >,
  ): Promise<TeamRecord | null> {
    validateTeamId(input.team_id);
    const now = Date.now();
    const team: TeamRecord = {
      version: 1,
      ...input,
      worktree_cleanup_force: false,
      created_at: now,
      updated_at: now,
    };
    const path = this.recordPath(team.team_id);
    const published = await writeFileExclusiveAtomic(
      path,
      `${JSON.stringify(team, null, 2)}\n`,
    );
    if (!published) {
      if ((await this.get(team.team_id)) !== null) return null;
      await writeFileAtomic(path, `${JSON.stringify(team, null, 2)}\n`);
    }
    await this.publishRecordState(team);
    return team;
  }

  async update(
    team: TeamRecord,
    input: {
      status?: TeamStatus;
      closedAt?: number | null;
      closeNote?: string | null;
      worktree?: TeamRecord['worktree'];
      intent?: string;
      cleanupForce?: boolean;
    },
  ): Promise<TeamRecord> {
    const key = `${team.dispatcher_id}\0${team.team_id}`;
    return this.writes.run(key, async () => {
      // Merge against the authoritative current row rather than the caller's
      // snapshot. If nothing valid is there any more, the Team no longer
      // exists: writing the caller's older snapshot back would resurrect a Team
      // from a stale in-memory copy and silently reclaim a name that is free.
      const current = await this.get(team.team_id);
      if (current === null) {
        throw new TeamNotFoundError(
          `Team ${JSON.stringify(team.team_id)} no longer has a readable record`,
        );
      }
      const updated: TeamRecord = {
        ...current,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
        ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
        ...(input.cleanupForce !== undefined
          ? { worktree_cleanup_force: input.cleanupForce }
          : {}),
        updated_at: Date.now(),
      };
      await this.write(updated);
      if (updated.status !== current.status) {
        await this.publishRecordState(updated);
      }
      return updated;
    });
  }

  /**
   * Publish the aggregate for a durable record transition.
   *
   * Every lifecycle change passes through this store, so this is where the
   * record half of the aggregate is stated, timed by the durable write that
   * produced it. The roster half is resolved from its authoritative owner
   * first — after the write and inside the same serialized operation, so
   * publications keep the order their transitions had.
   */
  private async publishRecordState(team: TeamRecord): Promise<void> {
    const coreEvents = this.opts.coreEvents;
    // Nobody is listening, so there is no fact to establish and no reason to
    // read a roster for one. The same short-circuit the turn projection uses.
    if (coreEvents === undefined || coreEvents.hasSources?.() === false) return;
    const teammates = (await this.opts.roster?.(team)) ?? null;
    if (teammates === null) return;
    this.publish(team, team.updated_at, teammates);
  }

  /**
   * Republish the aggregate for a roster fact whose owner already holds it.
   *
   * Synchronous and IO-free by construction: the Team that owns the Agents
   * states them. The timestamp is the identity transition that caused this
   * republication, never the older record write the Team still sits on.
   */
  publishRosterState(
    team: TeamRecord,
    occurredAt: number,
    teammates: readonly TeamStateTeammateSummary[],
  ): void {
    this.publish(team, occurredAt, teammates);
  }

  private publish(
    team: TeamRecord,
    occurredAt: number,
    teammates: readonly TeamStateTeammateSummary[],
  ): void {
    this.opts.coreEvents?.publish(team.dispatcher_id, {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: occurredAt,
      team_name: team.team_id,
      leader_name: team.leader_name,
      status: team.status,
      teammates,
    });
  }

  private async write(team: TeamRecord): Promise<void> {
    await writeFileAtomic(
      this.recordPath(team.team_id),
      `${JSON.stringify(team, null, 2)}\n`,
    );
  }
}

/**
 * Read one record, or refuse to call it a Team.
 *
 * What is checked is exactly what the record is the authority for: that this
 * Team exists at this concrete name, and that a TeamLeader whose Identity is
 * gone can be rebuilt from it. Identity is the directory the record was found
 * in, so `dispatcher_id`/`team_id` must agree with where it lives; the rest is
 * the leader-reconstruction snapshot — the runtime to start, the directories to
 * start it in, the worktree it belongs to, and the identity inputs it was
 * created with.
 *
 * Nothing else is inspected. Timestamps, intent, and close notes describe a
 * Team rather than establish one, and a Team is not made nonexistent by an odd
 * label. A required fact that is missing or malformed means there is no Team:
 * {@link TeamStore.get} answers `null`, so nothing routes to it, it receives no
 * turn, and it reserves no name.
 */
function readTeam(dispatcherId: string, teamId: string, raw: string): TeamRecord {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    value['version'] !== 1 ||
    value['dispatcher_id'] !== dispatcherId ||
    value['team_id'] !== teamId ||
    !isFilledString(value['name']) ||
    !isFilledString(value['leader_name']) ||
    !isTeamStatus(value['status']) ||
    !isFilledString(value['leader_agent_runtime']) ||
    !isFilledString(value['repo_cwd']) ||
    !isFilledString(value['runtime_cwd']) ||
    !isNullableFilledString(value['source_repo'])
  ) {
    throw new Error(`invalid Team record ${JSON.stringify(teamId)}`);
  }
  return {
    ...(value as unknown as TeamRecord),
    ...readCreateRequest(value),
    ...readLeaderCreationInputs(value, teamId),
    worktree: readWorktree(value['worktree'], teamId),
    worktree_cleanup_force: value['worktree_cleanup_force'] === true,
  };
}

/**
 * The worktree this Team's leader belongs to.
 *
 * It is part of the reconstruction snapshot, not decoration: a leader rebuilt
 * against the wrong directory, mode, or cleanup disposition would run somewhere
 * this Team never agreed to and could delete work it does not own.
 */
function readWorktree(
  value: unknown,
  teamId: string,
): AgentEntityWorktreeIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid Team record ${JSON.stringify(teamId)} worktree`);
  }
  const record = value as Record<string, unknown>;
  if (
    (record['mode'] !== 'reuse-cwd' && record['mode'] !== 'managed') ||
    !isFilledString(record['path']) ||
    !isNullableFilledString(record['slug']) ||
    !isNullableFilledString(record['branch']) ||
    !isNullableFilledString(record['base_ref']) ||
    (record['cleanup'] !== 'keep' && record['cleanup'] !== 'delete-on-close') ||
    !isWorktreeCleanupState(record['cleanup_state']) ||
    !isNullableFilledString(record['cleanup_error'])
  ) {
    throw new Error(`invalid Team record ${JSON.stringify(teamId)} worktree`);
  }
  return record as unknown as AgentEntityWorktreeIdentity;
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isNullableFilledString(value: unknown): boolean {
  return value === null || isFilledString(value);
}

function isTeamStatus(value: unknown): boolean {
  return value === 'starting' || value === 'running' || value === 'closed';
}

function isWorktreeCleanupState(value: unknown): boolean {
  return value === 'not-managed' ||
    value === 'managed-active' ||
    value === 'cleanup-pending' ||
    value === 'kept' ||
    value === 'deleted' ||
    value === 'retained-dirty' ||
    value === 'retained-unmerged' ||
    value === 'retained-unique-commits' ||
    value === 'retained-error';
}

/**
 * The stable TeamLeader creation inputs carried by this record.
 *
 * Both are additive, so a record written before they moved into it simply
 * carries neither: that reads back as no identity prompt and no admin-supplied
 * skill sources, which is what such a Team's leader was created with. A present
 * value must still be well formed — a half-written creation input would let a
 * recreated leader differ from the one this Team accepted.
 */
function readLeaderCreationInputs(
  value: Record<string, unknown>,
  teamId: string,
): Pick<TeamRecord, 'leader_identity_prompt' | 'leader_skill_sources'> {
  const prompt = value['leader_identity_prompt'] ?? null;
  if (prompt !== null && typeof prompt !== 'string') {
    throw new Error(
      `invalid Team record ${JSON.stringify(teamId)} leader identity prompt`,
    );
  }
  return {
    leader_identity_prompt: prompt,
    leader_skill_sources: parseAgentRuntimeSkillSources(
      value['leader_skill_sources'] ?? [],
      `Team record ${JSON.stringify(teamId)} leader_skill_sources`,
    ),
  };
}

/**
 * The accepted `team.create` identity carried by this record.
 *
 * Both fields are optional: a Team created through an internal path carries no
 * request identity at all, and neither does a record written before the
 * identity moved into it. Present means both present and well formed — a
 * half-written identity would let a replay resolve against a payload nobody
 * accepted.
 */
function readCreateRequest(value: Record<string, unknown>): {
  create_request_id: string | null;
  create_payload_hash: string | null;
} {
  const requestId = value['create_request_id'] ?? null;
  const payloadHash = value['create_payload_hash'] ?? null;
  if (requestId === null && payloadHash === null) {
    return { create_request_id: null, create_payload_hash: null };
  }
  if (!isTeamCreateRequestId(requestId) || !isTeamCreatePayloadHash(payloadHash)) {
    throw new Error('invalid Team creation request identity');
  }
  return {
    create_request_id: requestId as string,
    create_payload_hash: payloadHash as string,
  };
}
