/**
 * The durable Team store.
 *
 * `team/<team>/record.json` is the single authority for a Team: a valid,
 * readable record is the only proof that Team exists and the only thing that
 * occupies its concrete name. One {@link TransactionalStore} per Team id holds
 * that file — the committed value in memory, the serialized queue every read
 * or write goes through — so a lookup after the first one serves the held
 * value and a write is the store's own atomic read-decide-replace, not a
 * second reservation mechanism.
 *
 * The store is bound to the `team/` collection root its owner resolved, and
 * appends only the concrete Team name to it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { TransactionalStore } from '@excitedjs/dreamux-utils';

import type { AgentEntityWorktreeIdentity } from '../agent/identity.js';

import { isNotFound } from '../../platform/fs-errors.js';
import { collectionEntityDir } from '../../platform/paths.js';
import { parseAgentRuntimeSkillSources } from '../../agent-runtime/skill-sources.js';
import { TeamNotFoundError } from './errors.js';
import {
  isTeamCreatePayloadHash,
  isTeamCreateRequestId,
} from './create-request.js';
import type { TeamStatus } from '@excitedjs/dreamux-types';
import { validateTeamId, type TeamRecord } from './types.js';

export class TeamStore {
  /** One `TransactionalStore` per Team id, built lazily and held for the life
   * of this collection — a Team's record is read once and then served from
   * memory until this Team's own write path replaces it. */
  private readonly stores = new Map<
    string,
    TransactionalStore<TeamRecord | null>
  >();

  constructor(
    private readonly opts: {
      /** `<dispatcher>/team` — one child directory per Team. */
      root: string;
      dispatcherId: string;
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
   * This Team's own `TransactionalStore`, for an owner (`TeamService`) that
   * holds a synchronous reference to it across many calls instead of making a
   * fresh async round trip through {@link get}/{@link update} each time.
   * Distinct from those two: this hands back the store itself, unloaded on
   * first mint, rather than awaiting a value.
   */
  handle(teamId: string): TransactionalStore<TeamRecord | null> {
    return this.storeFor(teamId);
  }

  private storeFor(teamId: string): TransactionalStore<TeamRecord | null> {
    const id = validateTeamId(teamId);
    let store = this.stores.get(id);
    if (store === undefined) {
      store = new TransactionalStore<TeamRecord | null>({
        path: this.recordPath(id),
        load: () => this.loadTeam(id),
      });
      this.stores.set(id, store);
    }
    return store;
  }

  /**
   * This Team's record, read from disk on first ask and served from memory
   * afterward. Missing, malformed, and unreadable are the same successful
   * `null`: only a valid record proves a Team exists, so anything else is
   * nonexistent for lookup, routing, and name allocation and can never
   * receive a turn or reserve a name. A read error other than "file missing"
   * still resolves to `null` rather than propagating — matching {@link create}'s
   * own "replace invalid residue" path, which depends on a malformed record
   * reading back as no Team rather than as a failure.
   */
  private async loadTeam(teamId: string): Promise<TeamRecord | null> {
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

  /**
   * The Team at this concrete name, or `null` when there is none.
   *
   * The name check itself still throws — an invalid team id is a caller
   * defect, not a missing Team.
   */
  async get(teamId: string): Promise<TeamRecord | null> {
    return this.storeFor(teamId).load();
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
   * Three outcomes, and only three. This Team's store loads whatever is
   * there — nothing, if this is the first ask — and `change` below decides
   * from the loaded value, inside this Team's own serialized queue, so the
   * read-decide-write is atomic without a second reservation mechanism.
   * Nothing valid occupies the slot: publication succeeded, and the record
   * now owns the name. A VALID record is already there: the name belongs to
   * a live Team, so this returns `null` and the caller allocates another
   * candidate. Anything else there — malformed, unreadable, half-written —
   * is not a Team and holds no claim on the name, so the new record
   * atomically replaces it. A real filesystem failure is none of those and
   * surfaces.
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
    const result = await this.storeFor(team.team_id).update((current) =>
      current !== null ? current : team,
    );
    // `update`'s own no-op path returns the exact loaded reference when
    // `change` did not take the `: team` branch, so this is `true` if and
    // only if the slot was empty and this publication took it — no separate
    // "was this a create" flag needed.
    return result === team ? team : null;
  }

  /**
   * Merge `input` onto this Team's committed record and publish the result.
   *
   * The merge runs inside this Team's own `change`, against the store's true
   * committed value, never a caller-held snapshot: writing an older snapshot
   * back would resurrect a Team from stale memory and silently reclaim a name
   * that is free again.
   */
  async update(
    teamId: string,
    input: {
      status?: TeamStatus;
      closedAt?: number | null;
      closeNote?: string | null;
      worktree?: TeamRecord['worktree'];
      cleanupForce?: boolean;
    },
  ): Promise<TeamRecord> {
    let updated!: TeamRecord;
    await this.storeFor(teamId).update((current) => {
      if (current === null) {
        throw new TeamNotFoundError(
          `Team ${JSON.stringify(teamId)} no longer has a readable record`,
        );
      }
      updated = {
        ...current,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
        ...(input.closeNote !== undefined
          ? { close_note: input.closeNote }
          : {}),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
        ...(input.cleanupForce !== undefined
          ? { worktree_cleanup_force: input.cleanupForce }
          : {}),
        updated_at: Date.now(),
      };
      return updated;
    });
    return updated;
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
 * Every field is read by its own name rather than passed through from the
 * parsed JSON: an unrecognized key in the source tolerates (does not throw),
 * but is never carried forward into the constructed record or written back on
 * the next update. Timestamps, intent, and close notes describe a Team rather
 * than establish one, so they are read as-is with no added type check beyond
 * what already existed — a required fact that is missing or malformed still
 * means there is no Team: {@link TeamStore.get} answers `null`, so nothing
 * routes to it, it receives no turn, and it reserves no name.
 */
function readTeam(
  dispatcherId: string,
  teamId: string,
  raw: string,
): TeamRecord {
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
    version: 1,
    dispatcher_id: dispatcherId,
    team_id: teamId,
    name: value['name'] as string,
    repo_cwd: value['repo_cwd'] as string,
    source_repo: value['source_repo'] as string | null,
    leader_name: value['leader_name'] as string,
    leader_agent_runtime: value['leader_agent_runtime'] as string,
    runtime_cwd: value['runtime_cwd'] as string,
    status: value['status'] as TeamStatus,
    intent: (value['intent'] as string | undefined) ?? null,
    created_at: value['created_at'] as number,
    updated_at: value['updated_at'] as number,
    closed_at: (value['closed_at'] as number | undefined) ?? null,
    close_note: (value['close_note'] as string | undefined) ?? null,
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
  return {
    mode: record['mode'],
    slug: record['slug'] as string | null,
    path: record['path'],
    branch: record['branch'] as string | null,
    base_ref: record['base_ref'] as string | null,
    cleanup: record['cleanup'],
    cleanup_state: record[
      'cleanup_state'
    ] as AgentEntityWorktreeIdentity['cleanup_state'],
    cleanup_error: record['cleanup_error'] as string | null,
  };
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
  return (
    value === 'not-managed' ||
    value === 'managed-active' ||
    value === 'cleanup-pending' ||
    value === 'kept' ||
    value === 'deleted' ||
    value === 'retained-dirty' ||
    value === 'retained-unmerged' ||
    value === 'retained-unique-commits' ||
    value === 'retained-error'
  );
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
  if (
    !isTeamCreateRequestId(requestId) ||
    !isTeamCreatePayloadHash(payloadHash)
  ) {
    throw new Error('invalid Team creation request identity');
  }
  return {
    create_request_id: requestId as string,
    create_payload_hash: payloadHash as string,
  };
}
