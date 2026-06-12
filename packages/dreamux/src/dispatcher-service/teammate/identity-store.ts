import { readFile, readdir } from 'node:fs/promises';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import {
  dispatcherTeamMateRecordsDir,
  dispatcherTeamMateRecordPath,
} from '../../platform/paths.js';
import { assertNoRemovedRecordFields, LegacyStateError } from '../legacy-state.js';
import {
  validateTeamMateName,
  type TeamMateIdentity,
  type TeamMateIdentityStatus,
  type TeamMateOwner,
  type TeamMateRole,
  type TeamMateWorktreeIdentity,
} from './types.js';

export interface TeamMateIdentityStoreLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface TeamMateIdentityCreateInput {
  dispatcherId: string;
  name: string;
  owner?: TeamMateOwner;
  role?: TeamMateRole;
  teamId?: string | null;
  agentRuntime: string;
  sessionId?: string | null;
  sourceCwd: string;
  sourceRepo: string | null;
  cwd: string;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
  intent?: string | null;
  status?: TeamMateIdentityStatus;
}

export interface TeamMateIdentityUpdateInput {
  agentRuntime?: string;
  sessionId?: string | null;
  sourceCwd?: string;
  sourceRepo?: string | null;
  cwd?: string;
  runtimeCwd?: string;
  worktree?: TeamMateWorktreeIdentity;
  intent?: string | null;
  status?: TeamMateIdentityStatus;
  lastError?: string | null;
  closedAt?: number | null;
  closeNote?: string | null;
  /** Rolling recovery summary (issue #199 Slice 3), bumped on each turn. */
  turnCount?: number;
  lastSeenAt?: number;
  lastPromptPreview?: string | null;
  lastAssistantPreview?: string | null;
}

export class TeamMateIdentityStore {
  constructor(private readonly log: TeamMateIdentityStoreLog) {}

  async get(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateIdentity | null> {
    validateTeamMateName(name);
    try {
      return readIdentity(
        dispatcherId,
        name,
        await readFile(dispatcherTeamMateRecordPath(dispatcherId, name), 'utf8'),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dispatcherId: string): Promise<TeamMateIdentity[]> {
    let entries: string[];
    try {
      entries = await readdir(dispatcherTeamMateRecordsDir(dispatcherId));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const identities: TeamMateIdentity[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      try {
        const identity = await this.get(dispatcherId, name);
        if (identity !== null) identities.push(identity);
      } catch (err) {
        // #199 Slice 5: removed-field / legacy old state must fail loud on the
        // list/history read paths too (scopedList → here), never silently skip.
        // A genuinely corrupt/unreadable record is still tolerated with a warn.
        if (err instanceof LegacyStateError) throw err;
        this.log.warn('skipping unreadable TeamMate identity', {
          dispatcher_id: dispatcherId,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return identities;
  }

  async create(input: TeamMateIdentityCreateInput): Promise<TeamMateIdentity> {
    validateTeamMateName(input.name);
    const now = Date.now();
    const identity: TeamMateIdentity = {
      version: 1,
      dispatcher_id: input.dispatcherId,
      name: input.name,
      owner: input.owner ?? dispatcherOwner(input.dispatcherId),
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
    await this.write(identity);
    return identity;
  }

  async update(
    identity: TeamMateIdentity,
    input: TeamMateIdentityUpdateInput,
  ): Promise<TeamMateIdentity> {
    const updated: TeamMateIdentity = {
      ...identity,
      ...(input.agentRuntime !== undefined ? { agent_runtime: input.agentRuntime } : {}),
      ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
      ...(input.sourceCwd !== undefined ? { source_cwd: input.sourceCwd } : {}),
      ...(input.sourceRepo !== undefined ? { source_repo: input.sourceRepo } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.runtimeCwd !== undefined ? { runtime_cwd: input.runtimeCwd } : {}),
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
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
    return updated;
  }

  private async write(identity: TeamMateIdentity): Promise<void> {
    const path = dispatcherTeamMateRecordPath(
      identity.dispatcher_id,
      identity.name,
    );
    // Atomic write (issue #199 Slice 4): a concurrent `last`/`get` reader (e.g.
    // a parallel settle capture) must never observe a truncated record.
    await writeFileAtomic(path, `${JSON.stringify(identity, null, 2)}\n`);
  }
}

function readIdentity(
  dispatcherId: string,
  name: string,
  raw: string,
): TeamMateIdentity {
  const value = JSON.parse(raw) as Record<string, unknown>;
  // #98 fail-loud: a pre-#148 identity carried `provider_ref` (a provider ref)
  // instead of `agent_runtime` (an agents[].id). It cannot be resolved against
  // the named agents map, so reject it with rebuild guidance rather than
  // silently defaulting a runtime.
  if (
    typeof value['agent_runtime'] !== 'string' &&
    typeof value['provider_ref'] === 'string'
  ) {
    throw new LegacyStateError(
      `TeamMate identity ${JSON.stringify(name)} uses the legacy provider_ref ` +
        'format (pre-#148). Teammate identities now reference an agents[].id via ' +
        'agent_runtime. Close and respawn this teammate, or delete its identity ' +
        'file to rebuild it.',
    );
  }
  // #199 Slice 5 fail-loud: a pre-#199 record carried the Dreamux resume
  // wrapper (`checkpoint` / `checkpoint_kind` / `session_ref`), the Dreamux-made
  // `display_name`, or the retired `close_status`. Those concepts are gone, so
  // reject the record with rebuild guidance rather than reading a stale shape.
  assertNoRemovedRecordFields(
    `TeamMate record ${JSON.stringify(name)}`,
    value,
    ['checkpoint', 'checkpoint_kind', 'session_ref', 'display_name', 'close_status'],
    `close and respawn this teammate, or delete its record at ${dispatcherTeamMateRecordPath(dispatcherId, name)} to rebuild it.`,
  );
  if (
    value['version'] !== 1 ||
    value['dispatcher_id'] !== dispatcherId ||
    value['name'] !== name ||
    typeof value['agent_runtime'] !== 'string' ||
    typeof value['cwd'] !== 'string'
  ) {
    throw new Error(`invalid TeamMate identity ${JSON.stringify(name)}`);
  }
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
  // #199 Slice 3: build the record by EXPLICIT field, never a loose spread of the
  // raw JSON — so a removed legacy field (e.g. `display_name`, the old
  // `checkpoint` object, or the Dreamux-minted session id) is never carried back
  // out or re-persisted. Missing fields read forward-compatibly with defaults.
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    name,
    owner: readOwner(record['owner'], dispatcherId),
    role: readRole(record['role']),
    team_id: typeof record['team_id'] === 'string' ? record['team_id'] : null,
    agent_runtime: record['agent_runtime'] as string,
    // session_id is the runtime-native thread id (null until the runtime reports
    // one); the removed `checkpoint` object is never read back.
    session_id:
      typeof record['session_id'] === 'string' ? record['session_id'] : null,
    source_cwd: sourceCwd,
    source_repo: sourceRepo,
    cwd: record['cwd'] as string,
    runtime_cwd: runtimeCwd,
    worktree,
    intent: typeof record['intent'] === 'string' ? record['intent'] : null,
    created_at: createdAt,
    updated_at: updatedAt,
    status: readStatus(record['status']),
    last_error: typeof record['last_error'] === 'string' ? record['last_error'] : null,
    closed_at: typeof record['closed_at'] === 'number' ? record['closed_at'] : null,
    close_note: typeof record['close_note'] === 'string' ? record['close_note'] : null,
    // Rolling summary — default for a record written before these fields existed.
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

const IDENTITY_STATUSES = new Set<TeamMateIdentityStatus>([
  'starting',
  'running',
  'degraded',
  'closed',
  'stopped',
]);

function readStatus(value: unknown): TeamMateIdentityStatus {
  return typeof value === 'string' && IDENTITY_STATUSES.has(value as TeamMateIdentityStatus)
    ? (value as TeamMateIdentityStatus)
    : 'stopped';
}

function readRole(value: unknown): TeamMateRole {
  if (value === 'team_leader' || value === 'team_member') return value;
  return 'teammate';
}

function readOwner(value: unknown, dispatcherId: string): TeamMateOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return dispatcherOwner(dispatcherId);
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'dispatcher' && typeof record['dispatcher_id'] === 'string') {
    return { kind: 'dispatcher', dispatcher_id: record['dispatcher_id'] };
  }
  if (
    record['kind'] === 'team' &&
    typeof record['dispatcher_id'] === 'string' &&
    typeof record['team_id'] === 'string' &&
    typeof record['leader_name'] === 'string'
  ) {
    return {
      kind: 'team',
      dispatcher_id: record['dispatcher_id'],
      team_id: record['team_id'],
      leader_name: record['leader_name'],
    };
  }
  return dispatcherOwner(dispatcherId);
}

function dispatcherOwner(dispatcherId: string): TeamMateOwner {
  return { kind: 'dispatcher', dispatcher_id: dispatcherId };
}

function readWorktreeIdentity(
  value: unknown,
  runtimeCwd: string,
): TeamMateWorktreeIdentity {
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
        ? (record['cleanup_state'] as TeamMateWorktreeIdentity['cleanup_state'])
        : mode === 'managed'
          ? 'managed-active'
          : 'not-managed',
    cleanup_error:
      typeof record['cleanup_error'] === 'string'
        ? record['cleanup_error']
        : null,
  };
}
