import { readFile, readdir } from 'node:fs/promises';

import type {
  AgentRuntimeSessionRef,
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
  agentIdentityPath,
  collectionEntityDir,
  teamMateCollectionDir,
} from '../../platform/paths.js';
import { assertNoRemovedRecordFields, LegacyStateError } from '../legacy-state.js';
import {
  allocateConcreteName,
  type ConcreteNameKind,
  type SuffixGenerator,
} from '../name-allocator.js';
import {
  TEAMMATE_NAME_PATTERN,
  validateAgentEntityName,
  type AgentEntityIdentity,
  type AgentEntityIdentityStatus,
  type AgentEntityWorktreeIdentity,
} from './types.js';

export interface AgentIdentityCreateInput {
  name: string;
  teamId?: string | null;
  agentRuntime: string;
  session?: AgentRuntimeSessionRef | null;
  sourceCwd: string;
  sourceRepo: string | null;
  cwd: string;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
  intent?: string | null;
  identityPrompt?: string | null;
  skillSources?: readonly AgentRuntimeSkillSource[];
  status?: AgentEntityIdentityStatus;
  /**
   * Replace whatever occupies the bound location instead of refusing it.
   *
   * The owner sets this only when it has already established that the residue
   * is not a usable record of the entity it is creating — a TeamLeader whose
   * identity is missing, malformed, or belongs to someone else. Recovery of a
   * known-unusable file is the intent; a collision it has not reasoned about
   * still has to surface.
   */
  replaceExisting?: boolean;
}

export interface AgentIdentityUpdateInput {
  agentRuntime?: string;
  session?: AgentRuntimeSessionRef | null;
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
}

/**
 * How one bound identity store is wired by the owner that materializes the
 * Agent.
 *
 * `dir` is the entity directory the owner already resolved — the dispatcher
 * root, a Team root, or a `teammate/<name>/` child of one of the two collection
 * roots. It is the ONLY path input; nothing in this module recomputes it, and
 * no persisted field takes part in choosing it.
 */
export interface AgentIdentityStoreBinding {
  /** The already-resolved entity directory. */
  dir: string;
  /** Owning dispatcher, cross-checked against the record on read. */
  dispatcherId: string;
  /**
   * The owner's own key for this entity when the path encodes it, so a scanned
   * directory whose record disagrees is rejected. `null` at an owner root
   * (dispatcher Agent, TeamLeader), where the record's `name` is authoritative.
   */
  expectedName: string | null;
  log: DreamuxLogger;
  /**
   * Owner-supplied hook fired after a create, an upsert, or an update that
   * changed status. Publication needs the runtime role, which only the owner
   * knows, so this store publishes nothing itself.
   */
  onPersisted?: (identity: AgentEntityIdentity) => void;
}

/**
 * Durable identity storage for exactly one agent entity.
 *
 * The store is bound to a directory at construction and reads, creates,
 * updates, and recovers through that one location. There is no dispatcher-wide
 * variant that takes a `dispatcher_id`/`team_id`/`name` tuple and rediscovers
 * where a record must live: the owner already knows, so a lookup can never
 * probe two candidate paths, and a record's contents can never redirect their
 * own storage.
 */
export class AgentIdentityStore {
  private readonly path: string;

  constructor(private readonly binding: AgentIdentityStoreBinding) {
    this.path = agentIdentityPath(binding.dir);
  }

  /** The bound entity directory, for owners that place sibling state beside it. */
  get dir(): string {
    return this.binding.dir;
  }

  /**
   * Read this entity's identity. A missing file yields null; a legacy/old-state
   * file is rethrown (fail-loud); any other parse/IO error is logged and yields
   * null, so one unreadable entity never sinks a whole collection scan.
   */
  async read(): Promise<AgentEntityIdentity | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      return readIdentity(
        this.binding.dispatcherId,
        this.binding.expectedName,
        raw,
      );
    } catch (err) {
      if (err instanceof LegacyStateError) throw err;
      this.binding.log.warn(
        {
          dispatcher_id: this.binding.dispatcherId,
          name: this.binding.expectedName,
          path: this.path,
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
      dispatcher_id: this.binding.dispatcherId,
      name: input.name,
      team_id: input.teamId ?? null,
      agent_runtime: input.agentRuntime,
      session: input.session ?? null,
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
    };
    if (input.replaceExisting === true) {
      await this.write(identity);
    } else {
      const created = await writeFileExclusiveAtomic(
        this.path,
        `${JSON.stringify(identity, null, 2)}\n`,
      );
      if (!created) {
        throw new Error(
          `Agent identity ${JSON.stringify(identity.name)} already exists`,
        );
      }
    }
    this.binding.onPersisted?.(identity);
    return identity;
  }

  async update(
    identity: AgentEntityIdentity,
    input: AgentIdentityUpdateInput,
  ): Promise<AgentEntityIdentity> {
    const updated: AgentEntityIdentity = {
      ...identity,
      ...(input.agentRuntime !== undefined ? { agent_runtime: input.agentRuntime } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
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
      updated_at: Date.now(),
    };
    await this.write(updated);
    if (updated.status !== identity.status) this.binding.onPersisted?.(updated);
    return updated;
  }

  /**
   * Write a whole identity, replacing whatever occupies the bound location.
   *
   * Recovery uses this: the owner has already decided that what is there is not
   * a usable record of its own entity, so an atomic replace is the intended
   * outcome rather than a collision to report.
   */
  async upsert(identity: AgentEntityIdentity): Promise<AgentEntityIdentity> {
    await this.write(identity);
    this.binding.onPersisted?.(identity);
    return identity;
  }

  private async write(identity: AgentEntityIdentity): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(identity, null, 2)}\n`);
  }
}

/**
 * One already-bound agent collection root — a `teammate/` directory whose
 * immediate children are one entity directory per name.
 *
 * The collection appends the entity name to its own root and nothing else. It
 * never learns whether it sits under a dispatcher or under a Team: that is
 * settled by whoever constructed it, which is exactly what keeps a leader and a
 * TeamMate from ever being confused for one another.
 */
export class AgentEntityCollectionStore {
  constructor(
    private readonly opts: {
      root: string;
      dispatcherId: string;
      log: DreamuxLogger;
      onPersisted?: (identity: AgentEntityIdentity) => void;
    },
  ) {}

  /** The bound collection root, for owners composing sibling paths. */
  get root(): string {
    return this.opts.root;
  }

  /** The bound store for one member of this collection. */
  entity(name: string): AgentIdentityStore {
    return new AgentIdentityStore({
      dir: collectionEntityDir(this.opts.root, name),
      dispatcherId: this.opts.dispatcherId,
      expectedName: name,
      log: this.opts.log,
      ...(this.opts.onPersisted !== undefined
        ? { onPersisted: this.opts.onPersisted }
        : {}),
    });
  }

  /**
   * Every occupied name in this collection. The entity DIRECTORY is the
   * occupancy fact, so a name stays taken even while its identity file is
   * unreadable — no-clobber discovery happens before any workspace side effect.
   */
  async names(): Promise<string[]> {
    return listCollectionNames(this.opts.root);
  }

  /** Every readable identity in this collection, skipping unreadable entries. */
  async list(): Promise<AgentEntityIdentity[]> {
    const identities: AgentEntityIdentity[] = [];
    for (const name of await this.names()) {
      const identity = await this.entity(name).read();
      if (identity !== null) identities.push(identity);
    }
    return identities;
  }
}

/**
 * The dispatcher-global agent-name namespace.
 *
 * Agent names stay dispatcher-global even though the directories are nested, so
 * uniqueness is checked across the dispatcher's own TeamMates plus every Team's
 * leader and TeamMates. It is composed once at the dispatcher composition root
 * from the two collection roots that dispatcher owns, and walks only fixed
 * segments below them — it does not take a locator tuple, and it reads a
 * leader's `name` rather than any field that could redirect a path.
 */
export class AgentNameRegistry {
  constructor(
    private readonly opts: {
      /** `<dispatcher>/teammate` — the dispatcher's own agent collection. */
      teamMateRoot: string;
      /** `<dispatcher>/team` — one child directory per Team. */
      teamRoot: string;
      dispatcherId: string;
      log: DreamuxLogger;
    },
  ) {}

  /** Every name currently occupied anywhere under this dispatcher. */
  async occupied(): Promise<Set<string>> {
    const names = new Set(await listCollectionNames(this.opts.teamMateRoot));
    for (const teamName of await listDirectoryNames(this.opts.teamRoot)) {
      const teamDir = collectionEntityDir(this.opts.teamRoot, teamName);
      const leader = await new AgentIdentityStore({
        dir: teamDir,
        dispatcherId: this.opts.dispatcherId,
        expectedName: null,
        log: this.opts.log,
      }).read();
      if (leader !== null) names.add(leader.name);
      for (const name of await listCollectionNames(
        teamMateCollectionDir(teamDir),
      )) {
        names.add(name);
      }
    }
    return names;
  }

  /** Allocate one generated name against the dispatcher's persisted namespace. */
  async allocate(input: {
    kind: Exclude<ConcreteNameKind, 'team'>;
    base: string;
    teamSlug?: string;
    generateSuffix?: SuffixGenerator;
  }): Promise<string> {
    const occupied = await this.occupied();
    return allocateConcreteName({
      kind: input.kind,
      base: input.base,
      ...(input.teamSlug !== undefined ? { teamSlug: input.teamSlug } : {}),
      exists: (value) => occupied.has(value),
      ...(input.generateSuffix !== undefined
        ? { generateSuffix: input.generateSuffix }
        : {}),
    });
  }
}

/** Valid entity directory names directly under one collection root. */
async function listCollectionNames(dir: string): Promise<string[]> {
  const names = await listDirectoryNames(dir);
  return names.filter((name) => TEAMMATE_NAME_PATTERN.test(name));
}

async function listDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Parse and validate one identity file. `expectedName` is the owner's key for
 * the entity; pass `null` at an owner root (the dispatcher Agent, a TeamLeader),
 * whose name is not encoded in the path — the parsed `name` is then
 * authoritative.
 *
 * A record written before role was removed still carries a `role` key. It is
 * simply not read: this reader takes named fields only, so the stale key is an
 * unknown extra that the next ordinary write drops.
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
    [
      'checkpoint',
      'checkpoint_kind',
      'session_ref',
      'session_id',
      'transcript_locator',
      'display_name',
      'close_status',
    ],
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
    team_id: typeof record['team_id'] === 'string' ? record['team_id'] : null,
    agent_runtime: record['agent_runtime'] as string,
    session: readSessionRef(record['session'], storedName),
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
    cleanup_state: readWorktreeCleanupState(record['cleanup_state']) ??
      (mode === 'managed' ? 'managed-active' : 'not-managed'),
    cleanup_error:
      typeof record['cleanup_error'] === 'string'
        ? record['cleanup_error']
        : null,
  };
}

const WORKTREE_CLEANUP_STATES = new Set<
  AgentEntityWorktreeIdentity['cleanup_state']
>([
  'not-managed',
  'managed-active',
  'cleanup-pending',
  'kept',
  'deleted',
  'retained-dirty',
  'retained-unmerged',
  'retained-unique-commits',
  'retained-error',
]);

function readWorktreeCleanupState(
  value: unknown,
): AgentEntityWorktreeIdentity['cleanup_state'] | null {
  return typeof value === 'string' &&
    WORKTREE_CLEANUP_STATES.has(
      value as AgentEntityWorktreeIdentity['cleanup_state'],
    )
    ? value as AgentEntityWorktreeIdentity['cleanup_state']
    : null;
}

/**
 * Read the provider-owned session object. Core validates only that it is a JSON
 * object carrying a non-empty string `id`; every other field is opaque and is
 * preserved verbatim for the provider that wrote it.
 */
function readSessionRef(
  value: unknown,
  storedName: string | null,
): AgentRuntimeSessionRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `agent identity ${JSON.stringify(storedName)} has a non-object session`,
    );
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      `agent identity ${JSON.stringify(storedName)} has a session without a string id`,
    );
  }
  return record as unknown as AgentRuntimeSessionRef;
}
