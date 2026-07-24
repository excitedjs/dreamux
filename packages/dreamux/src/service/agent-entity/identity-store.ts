import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentRuntimeSkillSource,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { parseAgentRuntimeSkillSources } from '../../agent-runtime/skill-sources.js';
import {
  writeFileAtomic,
  writeFileExclusiveAtomic,
} from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import {
  dispatcherAgentIdentityPath,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  dispatcherTeamScopeDir,
  dispatcherTeamTeamMateDir,
} from '../../platform/paths.js';
import { assertNoRemovedRecordFields, LegacyStateError } from '../legacy-state.js';
import type { DispatcherCoreEventPublisher } from '../dispatcher-core-events/index.js';
import {
  allocateConcreteName,
  type ConcreteNameKind,
  type SuffixGenerator,
} from '../name-allocator.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import {
  DISPATCHER_AGENT_NAME,
  validateAgentEntityName,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityRole,
  type AgentEntityWorktreeIdentity,
} from './types.js';

export interface AgentIdentityCreateInput {
  dispatcherId: string;
  name: string;
  role?: AgentEntityRole;
  teamId?: string | null;
  agentRuntime: string;
  sessionId?: string | null;
  sourceCwd: string;
  sourceRepo: string | null;
  cwd: string;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
  intent?: string | null;
  identityPrompt?: string | null;
  skillSources?: readonly AgentRuntimeSkillSource[];
  status?: AgentEntityIdentityStatus;
}

export interface AgentIdentityUpdateInput {
  agentRuntime?: string;
  sessionId?: string | null;
  sourceCwd?: string;
  sourceRepo?: string | null;
  cwd?: string;
  runtimeCwd?: string;
  worktree?: AgentEntityWorktreeIdentity;
  intent?: string | null;
  identityPrompt?: string | null;
  status?: AgentEntityIdentityStatus;
  lastError?: string | null;
  closedAt?: number | null;
  closeNote?: string | null;
  turnCount?: number;
  lastSeenAt?: number;
  lastPromptPreview?: string | null;
  lastAssistantPreview?: string | null;
}

export interface OccupiedTeamLeaderNames {
  listOccupiedLeaderNames(dispatcherId: string): Promise<ReadonlySet<string>>;
}

export interface ReservedAgentNameInput {
  dispatcherId: string;
  kind: Exclude<ConcreteNameKind, 'team'>;
  base: string;
  teamSlug?: string;
  generateSuffix?: SuffixGenerator;
}

const EMPTY_TEAM_LEADER_NAMES: OccupiedTeamLeaderNames = {
  listOccupiedLeaderNames: async () => new Set<string>(),
};

export class AgentIdentityStore {
  private readonly nameReservations = new KeyedAsyncQueue();
  private readonly reservedNames = new Map<string, Set<string>>();

  constructor(
    private readonly log: DreamuxLogger,
    private readonly coreEvents?: DispatcherCoreEventPublisher,
    private readonly occupiedTeamLeaderNames: OccupiedTeamLeaderNames =
      EMPTY_TEAM_LEADER_NAMES,
  ) {}

  /**
   * Read one identity by name within a scope (issue #233 symmetric layout).
   * Within a team scope the entity is either a member at
   * `team/<team>/teammate/<name>/` or the leader at `team/<team>/` — a two-probe
   * (member dir, then team root) resolves it, safe because names are
   * dispatcher-global. Without a team it is a dispatcher-owned teammate at
   * `teammate/<name>/`.
   */
  async get(
    dispatcherId: string,
    name: string,
    teamId?: string,
  ): Promise<AgentEntityIdentity | null> {
    validateAgentEntityName(name);
    const candidates =
      teamId === undefined
        ? [dispatcherAgentIdentityPath({ dispatcherId, name, teamId: null, role: 'teammate' })]
        : [
            dispatcherAgentIdentityPath({ dispatcherId, name, teamId, role: 'team_member' }),
            dispatcherAgentIdentityPath({ dispatcherId, name, teamId, role: 'team_leader' }),
          ];
    for (const path of candidates) {
      const identity = await this.readAt(dispatcherId, name, path);
      // The leader probe shares its dir with the team; only accept it when the
      // stored name actually matches (a member-named lookup must miss the root).
      if (identity !== null && identity.name === name) return identity;
    }
    return null;
  }

  /**
   * The roster of one scope (issue #233 / #233 Phase 4): a dispatcher's own
   * teammates (`teamId` omitted) or one team's MEMBERS (`teamId` given). The team
   * leader lives at the team root, not under `teammate/`, so a team-scope list
   * scans only `team/<team>/teammate/<name>/` and never enumerates the leader —
   * the leader is a contained `TeammateService` held by the `TeamService`, read by
   * its known name via {@link leaderIdentity}, not surfaced as a member. A blind
   * `readdir` of the scope's entity directories; physical scoping replaces the
   * former role/team_id roster filter.
   */
  async list(dispatcherId: string, teamId?: string): Promise<AgentEntityIdentity[]> {
    const dir =
      teamId === undefined
        ? dispatcherTeamMateDir(dispatcherId)
        : dispatcherTeamTeamMateDir(dispatcherId, teamId);
    return this.listCollection(dispatcherId, dir);
  }

  /** Read a team leader's identity from the team root, or null if absent. */
  async leaderIdentity(
    dispatcherId: string,
    teamId: string,
  ): Promise<AgentEntityIdentity | null> {
    return this.readAt(
      dispatcherId,
      null,
      join(dispatcherTeamScopeDir(dispatcherId, teamId), 'identity.json'),
    );
  }

  /** Read the root dispatcher identity, which lives outside teammate collections. */
  async dispatcherIdentity(
    dispatcherId: string,
  ): Promise<AgentEntityIdentity | null> {
    return this.readAt(
      dispatcherId,
      null,
      dispatcherAgentIdentityPath({
        dispatcherId,
        name: DISPATCHER_AGENT_NAME,
        teamId: null,
        role: 'dispatcher',
      }),
    );
  }

  /**
   * Every teammate/leader name across the whole dispatcher (issue #233): the
   * dispatcher's own teammates, plus each team's leader and members. Names-only,
   * so the dispatcher-global `allocateName` dedup stays collision-free for the
   * per-turn router key without `TeammateCollection` reaching into the team store.
   * The leader is read explicitly from the team root because `list` is now
   * members-only.
   */
  async listAllNames(dispatcherId: string): Promise<Set<string>> {
    const names = new Set<string>();
    for (const identity of await this.listCollection(
      dispatcherId,
      dispatcherTeamMateDir(dispatcherId),
    )) {
      names.add(identity.name);
    }
    for (const teamId of await this.listTeamIds(dispatcherId)) {
      const leader = await this.leaderIdentity(dispatcherId, teamId);
      if (leader !== null) names.add(leader.name);
      for (const identity of await this.list(dispatcherId, teamId)) {
        names.add(identity.name);
      }
    }
    return names;
  }

  /**
   * Reserve one generated agent name across every collection in a dispatcher.
   *
   * The queue protects only candidate selection and reservation-set mutation.
   * Slow workspace preparation and identity persistence run outside it while
   * the selected name stays reserved. The final queued release happens after
   * the callback settles, so a successful identity write becomes visible to
   * the next allocator before the transient reservation disappears.
   */
  async withReservedName<T>(
    input: ReservedAgentNameInput,
    task: (name: string) => Promise<T>,
  ): Promise<T> {
    const name = await this.nameReservations.run(input.dispatcherId, async () => {
      const occupied = await this.listAllNames(input.dispatcherId);
      for (const leaderName of await this.occupiedTeamLeaderNames
        .listOccupiedLeaderNames(input.dispatcherId)) {
        occupied.add(leaderName);
      }
      for (const reserved of this.reservedNames.get(input.dispatcherId) ?? []) {
        occupied.add(reserved);
      }
      const candidate = allocateConcreteName({
        kind: input.kind,
        base: input.base,
        ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
        exists: (value) => occupied.has(value),
        ...(input.generateSuffix !== undefined
          ? { generateSuffix: input.generateSuffix }
          : {}),
      });
      const reservations =
        this.reservedNames.get(input.dispatcherId) ?? new Set<string>();
      reservations.add(candidate);
      this.reservedNames.set(input.dispatcherId, reservations);
      return candidate;
    });
    try {
      return await task(name);
    } finally {
      await this.nameReservations.run(input.dispatcherId, async () => {
        const reservations = this.reservedNames.get(input.dispatcherId);
        reservations?.delete(name);
        if (reservations?.size === 0) {
          this.reservedNames.delete(input.dispatcherId);
        }
      });
    }
  }

  private async listTeamIds(dispatcherId: string): Promise<string[]> {
    try {
      const entries = await readdir(dispatcherTeamDir(dispatcherId), {
        withFileTypes: true,
      });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /** Read every `<dir>/<entity>/identity.json` child, skipping unreadable ones. */
  private async listCollection(
    dispatcherId: string,
    dir: string,
  ): Promise<AgentEntityIdentity[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const identities: AgentEntityIdentity[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const identity = await this.readAt(
        dispatcherId,
        entry.name,
        join(dir, entry.name, 'identity.json'),
      );
      if (identity !== null) identities.push(identity);
    }
    return identities;
  }

  /**
   * Read one identity file. A missing file yields null; a legacy/old-state file
   * is rethrown (fail-loud); any other parse/IO error is logged and skipped so a
   * single bad entity never sinks a whole collection list. `name` is the lookup
   * name for validation/logging; when scanning a collection it is the dir name.
   */
  private async readAt(
    dispatcherId: string,
    name: string | null,
    path: string,
  ): Promise<AgentEntityIdentity | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      return readIdentity(dispatcherId, name, raw);
    } catch (err) {
      if (err instanceof LegacyStateError) throw err;
      this.log.warn(
        {
          dispatcher_id: dispatcherId,
          name,
          path,
          error: err instanceof Error ? err.message : String(err),
        },
        'skipping unreadable agent identity',
      );
      return null;
    }
  }

  async create(input: AgentIdentityCreateInput): Promise<AgentEntityIdentity> {
    validateAgentEntityName(input.name);
    const now = Date.now();
    const identity: AgentEntityIdentity = {
      version: 1,
      dispatcher_id: input.dispatcherId,
      name: input.name,
      role: input.role ?? 'teammate',
      team_id: input.teamId ?? null,
      agent_runtime: input.agentRuntime,
      session_id: input.sessionId ?? null,
      source_cwd: input.sourceCwd,
      source_repo: input.sourceRepo,
      cwd: input.cwd,
      runtime_cwd: input.runtimeCwd,
      worktree: input.worktree,
      intent: input.intent ?? null,
      identity_prompt: input.identityPrompt ?? null,
      skill_sources: [...(input.skillSources ?? [])],
      created_at: now,
      updated_at: now,
      status: input.status ?? 'starting',
      last_error: null,
      closed_at: null,
      close_note: null,
      turn_count: 0,
      last_seen_at: now,
      last_prompt_preview: null,
      last_assistant_preview: null,
    };
    const path = dispatcherAgentIdentityPath({
      dispatcherId: identity.dispatcher_id,
      name: identity.name,
      teamId: identity.team_id,
      role: identity.role,
    });
    const created = await writeFileExclusiveAtomic(
      path,
      `${JSON.stringify(identity, null, 2)}\n`,
    );
    if (!created) {
      throw new Error(
        `Agent identity ${JSON.stringify(identity.name)} already exists`,
      );
    }
    this.publishState(identity);
    return identity;
  }

  async update(
    identity: AgentEntityIdentity,
    input: AgentIdentityUpdateInput,
  ): Promise<AgentEntityIdentity> {
    const updated: AgentEntityIdentity = {
      ...identity,
      ...(input.agentRuntime !== undefined ? { agent_runtime: input.agentRuntime } : {}),
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      ...(input.sourceCwd !== undefined ? { source_cwd: input.sourceCwd } : {}),
      ...(input.sourceRepo !== undefined ? { source_repo: input.sourceRepo } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.runtimeCwd !== undefined ? { runtime_cwd: input.runtimeCwd } : {}),
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
      ...(input.identityPrompt !== undefined
        ? { identity_prompt: input.identityPrompt }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
      ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
      ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
      ...(input.turnCount !== undefined ? { turn_count: input.turnCount } : {}),
      ...(input.lastSeenAt !== undefined ? { last_seen_at: input.lastSeenAt } : {}),
      ...(input.lastPromptPreview !== undefined
        ? { last_prompt_preview: input.lastPromptPreview }
        : {}),
      ...(input.lastAssistantPreview !== undefined
        ? { last_assistant_preview: input.lastAssistantPreview }
        : {}),
      updated_at: Date.now(),
    };
    await this.write(updated);
    if (updated.status !== identity.status) this.publishState(updated);
    return updated;
  }

  async upsert(identity: AgentEntityIdentity): Promise<AgentEntityIdentity> {
    await this.write(identity);
    this.publishState(identity);
    return identity;
  }

  private publishState(identity: AgentEntityIdentity): void {
    if (
      identity.team_id === null ||
      (identity.role !== 'team_leader' && identity.role !== 'team_member')
    ) {
      return;
    }
    this.coreEvents?.publish(identity.dispatcher_id, {
      schema_version: 1,
      kind: 'agent.state',
      occurred_at: identity.updated_at,
      team_name: identity.team_id,
      agent_name: identity.name,
      role: identity.role,
      status: identity.status,
    });
  }

  /** Derive the entity directory from the identity's own role + team (issue #233). */
  private async write(identity: AgentEntityIdentity): Promise<void> {
    const path = dispatcherAgentIdentityPath({
      dispatcherId: identity.dispatcher_id,
      name: identity.name,
      teamId: identity.team_id,
      role: identity.role,
    });
    await writeFileAtomic(path, `${JSON.stringify(identity, null, 2)}\n`);
  }
}

/**
 * Parse and validate one identity file. `expectedName` is the name the caller
 * looked up (or the scanned dir name); pass `null` when reading the team-root
 * leader, whose name is not encoded in the path — the parsed `name` is then
 * trusted as authoritative.
 */
function readIdentity(
  dispatcherId: string,
  expectedName: string | null,
  raw: string,
): AgentEntityIdentity {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const storedName = typeof value['name'] === 'string' ? value['name'] : expectedName;
  if (
    typeof value['agent_runtime'] !== 'string' &&
    typeof value['provider_ref'] === 'string'
  ) {
    throw new LegacyStateError(
      `agent identity ${JSON.stringify(storedName)} uses the legacy provider_ref ` +
        'format (pre-#148). Agent identities now reference an agents[].id via ' +
        'agent_runtime. Close and respawn this agent, or delete its identity ' +
        'file to rebuild it.',
    );
  }
  assertNoRemovedRecordFields(
    `agent record ${JSON.stringify(storedName)}`,
    value,
    ['checkpoint', 'checkpoint_kind', 'session_ref', 'display_name', 'close_status'],
    'close and respawn this teammate, or delete its identity directory to rebuild it.',
  );
  if (
    value['version'] !== 1 ||
    value['dispatcher_id'] !== dispatcherId ||
    typeof value['name'] !== 'string' ||
    (expectedName !== null && value['name'] !== expectedName) ||
    typeof value['agent_runtime'] !== 'string' ||
    typeof value['cwd'] !== 'string'
  ) {
    throw new Error(`invalid agent identity ${JSON.stringify(storedName)}`);
  }
  const name = value['name'] as string;
  const record = value as Record<string, unknown>;
  const sourceCwd =
    typeof record['source_cwd'] === 'string'
      ? record['source_cwd']
      : (record['cwd'] as string);
  const sourceRepo =
    typeof record['source_repo'] === 'string' ? record['source_repo'] : null;
  const runtimeCwd =
    typeof record['runtime_cwd'] === 'string'
      ? record['runtime_cwd']
      : (record['cwd'] as string);
  const worktree = readWorktreeIdentity(record['worktree'], runtimeCwd);
  const createdAt = typeof record['created_at'] === 'number' ? record['created_at'] : 0;
  const updatedAt = typeof record['updated_at'] === 'number' ? record['updated_at'] : createdAt;
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    name,
    role: readRole(record['role']),
    team_id: typeof record['team_id'] === 'string' ? record['team_id'] : null,
    agent_runtime: record['agent_runtime'] as string,
    session_id:
      typeof record['session_id'] === 'string' ? record['session_id'] : null,
    source_cwd: sourceCwd,
    source_repo: sourceRepo,
    cwd: record['cwd'] as string,
    runtime_cwd: runtimeCwd,
    worktree,
    intent: typeof record['intent'] === 'string' ? record['intent'] : null,
    identity_prompt:
      typeof record['identity_prompt'] === 'string'
        ? record['identity_prompt']
        : null,
    skill_sources: parseAgentRuntimeSkillSources(
      record['skill_sources'] ?? [],
      `agent identity ${JSON.stringify(storedName)} skill_sources`,
    ),
    created_at: createdAt,
    updated_at: updatedAt,
    status: readStatus(record['status']),
    last_error: typeof record['last_error'] === 'string' ? record['last_error'] : null,
    closed_at: typeof record['closed_at'] === 'number' ? record['closed_at'] : null,
    close_note: typeof record['close_note'] === 'string' ? record['close_note'] : null,
    turn_count: typeof record['turn_count'] === 'number' ? record['turn_count'] : 0,
    last_seen_at:
      typeof record['last_seen_at'] === 'number' ? record['last_seen_at'] : updatedAt,
    last_prompt_preview:
      typeof record['last_prompt_preview'] === 'string'
        ? record['last_prompt_preview']
        : null,
    last_assistant_preview:
      typeof record['last_assistant_preview'] === 'string'
        ? record['last_assistant_preview']
        : null,
  };
}

const IDENTITY_STATUSES = new Set<AgentEntityIdentityStatus>([
  'starting',
  'running',
  'degraded',
  'closed',
  'stopped',
]);

function readStatus(value: unknown): AgentEntityIdentityStatus {
  return typeof value === 'string' && IDENTITY_STATUSES.has(value as AgentEntityIdentityStatus)
    ? (value as AgentEntityIdentityStatus)
    : 'stopped';
}

function readRole(value: unknown): AgentEntityRole {
  if (value === 'dispatcher') return value;
  if (value === 'team_leader' || value === 'team_member') return value;
  return 'teammate';
}

function readWorktreeIdentity(
  value: unknown,
  runtimeCwd: string,
): AgentEntityWorktreeIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      mode: 'reuse-cwd',
      slug: null,
      path: runtimeCwd,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    };
  }
  const record = value as Record<string, unknown>;
  const mode = record['mode'] === 'managed' ? 'managed' : 'reuse-cwd';
  return {
    mode,
    slug: typeof record['slug'] === 'string' ? record['slug'] : null,
    path: typeof record['path'] === 'string' ? record['path'] : runtimeCwd,
    branch: typeof record['branch'] === 'string' ? record['branch'] : null,
    base_ref:
      typeof record['base_ref'] === 'string' ? record['base_ref'] : null,
    cleanup:
      record['cleanup'] === 'delete-on-close' ? 'delete-on-close' : 'keep',
    cleanup_state:
      typeof record['cleanup_state'] === 'string'
        ? (record['cleanup_state'] as AgentEntityWorktreeIdentity['cleanup_state'])
        : mode === 'managed'
          ? 'managed-active'
          : 'not-managed',
    cleanup_error:
      typeof record['cleanup_error'] === 'string'
        ? record['cleanup_error']
        : null,
  };
}
