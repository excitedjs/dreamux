import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dispatcherTeamMateIdentitiesDir,
  dispatcherTeamMateIdentityPath,
} from '../../platform/paths.js';
import {
  validateTeamMateName,
  type TeamMateIdentity,
  type TeamMateIdentityStatus,
  type TeamMateOwner,
  type TeamMateRole,
  type TeamMateWorktreeIdentity,
} from './types.js';
import type { AgentRuntimeResumeCheckpoint } from '../../agent-runtime/index.js';

export interface TeamMateIdentityStoreLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface TeamMateIdentityCreateInput {
  dispatcherId: string;
  name: string;
  /** Agent-supplied base slug / display hint behind the concrete name (issue #188). */
  displayName?: string | null;
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
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
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
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
  status?: TeamMateIdentityStatus;
  lastError?: string | null;
  closedAt?: number | null;
  closeNote?: string | null;
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
        await readFile(dispatcherTeamMateIdentityPath(dispatcherId, name), 'utf8'),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dispatcherId: string): Promise<TeamMateIdentity[]> {
    let entries: string[];
    try {
      entries = await readdir(dispatcherTeamMateIdentitiesDir(dispatcherId));
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
      display_name: input.displayName ?? null,
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
      checkpoint: input.checkpoint ?? null,
      last_error: null,
      closed_at: null,
      close_note: null,
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
      ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
      ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
      ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
      updated_at: Date.now(),
    };
    await this.write(updated);
    return updated;
  }

  private async write(identity: TeamMateIdentity): Promise<void> {
    const path = dispatcherTeamMateIdentityPath(
      identity.dispatcher_id,
      identity.name,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, {
      mode: 0o600,
    });
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
    throw new Error(
      `TeamMate identity ${JSON.stringify(name)} uses the legacy provider_ref ` +
        'format (pre-#148). Teammate identities now reference an agents[].id via ' +
        'agent_runtime. Close and respawn this teammate, or delete its identity ' +
        'file to rebuild it.',
    );
  }
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
  return {
    ...(value as unknown as TeamMateIdentity),
    owner: readOwner(record['owner'], dispatcherId),
    role: readRole(record['role']),
    team_id: typeof record['team_id'] === 'string' ? record['team_id'] : null,
    source_cwd: sourceCwd,
    source_repo: sourceRepo,
    runtime_cwd: runtimeCwd,
    worktree,
    intent: typeof record['intent'] === 'string' ? record['intent'] : null,
    // Pre-#182-PR-5 records have no session id; read as null (a fresh spawn
    // mints one). Forward-compatible: newer records carry the string.
    session_id:
      typeof record['session_id'] === 'string' ? record['session_id'] : null,
    // Pre-#188 records have no display name; read as null so callers fall back
    // to the concrete `name`. Legacy records stay readable without migration.
    display_name:
      typeof record['display_name'] === 'string' ? record['display_name'] : null,
  };
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

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
