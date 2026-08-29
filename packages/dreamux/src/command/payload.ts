/**
 * Transport-neutral payload readers shared by every Command's `parse`.
 *
 * These were the admin socket's parameter validators. They are not transport
 * code: a Command's input contract is the same whatever adapter carried it, so
 * the readers live beside the registry and every adapter reuses them instead of
 * re-validating a payload it forwards.
 *
 * `parse` is synchronous and touches only the payload. Anything that needs the
 * process — resolving a dispatcher, normalizing skill sources against the
 * filesystem — belongs in `execute`.
 */
import type {
  AgentRuntimeSkillSource,
  JsonSchema,
  JsonValue,
  TeamCreateRepoRequest,
} from '@excitedjs/dreamux-types';

import {
  normalizeAgentRuntimeSkillSources,
  parseAgentRuntimeSkillSources,
} from '../agent-runtime/skill-sources.js';
import type {
  AgentEntityHistoryQuery,
  AgentEntityIdentityStatus,
} from '../service/agent-entity/types.js';
import type { TeamMateWorktreeRequest } from '../service/teammate-collection/types.js';
import { ValidationError, errorMessage } from './errors.js';
import { STRING, enumOf, objectSchema } from './schema.js';

/** One Command payload in the object form every `parse` reads. */
export type CommandPayload = Record<string, unknown>;

/**
 * Read the invocation payload as an object. An absent payload is the empty
 * object, so a Command with only optional inputs stays callable with no payload
 * at all; anything else is a malformed request rather than a domain failure.
 */
export function commandPayload(payload: JsonValue | undefined): CommandPayload {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('command payload must be an object');
  }
  return payload as CommandPayload;
}

export function mustString(params: CommandPayload, key: string): string {
  if (typeof params[key] !== 'string') {
    throw new ValidationError(`missing or non-string param '${key}'`);
  }
  return params[key] as string;
}

export function mustNonEmptyString(params: CommandPayload, key: string): string {
  const value = mustString(params, key);
  if (value === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

export function mustNonBlankString(params: CommandPayload, key: string): string {
  const value = mustString(params, key);
  if (value.trim() === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

export function mustRecord(params: CommandPayload, key: string): Record<string, unknown> {
  const value = params[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(params: CommandPayload, key: string): string | null {
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new ValidationError(`param '${key}' must be a string`);
  }
  return v;
}

export function optionalNonBlankString(
  params: CommandPayload,
  key: string,
): string | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value.trim() === '') {
    throw new ValidationError(`param '${key}' must be a non-empty string`);
  }
  return value;
}

/**
 * Parse supplied skill sources without touching the filesystem. Normalization
 * against the bundled roots is a `execute`-time step; see
 * {@link normalizeSkillSources}.
 */
export function optionalParsedSkillSources(
  params: CommandPayload,
): readonly AgentRuntimeSkillSource[] | null {
  if (params['skill_sources'] === undefined) return null;
  try {
    return parseAgentRuntimeSkillSources(
      params['skill_sources'],
      "param 'skill_sources'",
    );
  } catch (err) {
    throw new ValidationError(errorMessage(err));
  }
}

/** Resolve parsed skill sources, adding the owner's mandatory roots. */
export async function normalizeSkillSources(
  parsed: readonly AgentRuntimeSkillSource[] | null,
  options: { requiredSources?: readonly AgentRuntimeSkillSource[] } = {},
): Promise<readonly AgentRuntimeSkillSource[] | null> {
  if (parsed === null) return null;
  try {
    return await normalizeAgentRuntimeSkillSources(parsed, {
      label: "param 'skill_sources'",
      ...(options.requiredSources !== undefined
        ? { requiredSources: options.requiredSources }
        : {}),
    });
  } catch (err) {
    throw new ValidationError(errorMessage(err));
  }
}

/**
 * The complete repository policy a Team or TeamMate may request.
 *
 * One closed object rather than a schema union: `mode` selects which of the
 * remaining properties are meaningful, and {@link repoRequest} rejects a
 * property that does not belong to the selected mode. The managed-only controls
 * stay part of the canonical contract — a Channel that owns a narrower policy
 * maps its own shape into this one instead of Core defining a second schema.
 */
export const REPO_REQUEST_SCHEMA: JsonSchema = objectSchema(
  {
    mode: enumOf(['reuse-cwd', 'managed']),
    path: STRING,
    base_ref: STRING,
    branch: STRING,
    slug: STRING,
    cleanup: enumOf(['keep', 'delete-on-close']),
  },
  ['mode'],
);

/** The managed-only controls a `reuse-cwd` request must not carry. */
const MANAGED_ONLY_KEYS = ['base_ref', 'branch', 'slug', 'cleanup'] as const;

/**
 * Read the canonical repository policy. A reused working directory is never
 * deletable, so the managed-only controls — including `cleanup` — are refused
 * rather than silently dropped under `reuse-cwd`.
 */
export function repoRequest(
  params: CommandPayload,
  key: string,
): TeamCreateRepoRequest | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object`);
  }
  const obj = value as CommandPayload;
  const mode = mustString(obj, 'mode');
  if (mode !== 'reuse-cwd' && mode !== 'managed') {
    throw new ValidationError(`param '${key}.mode' must be 'reuse-cwd' or 'managed'`);
  }
  const path = optionalString(obj, 'path');
  if (mode === 'reuse-cwd') {
    for (const managedOnly of MANAGED_ONLY_KEYS) {
      if (obj[managedOnly] !== undefined) {
        throw new ValidationError(
          `param '${key}.${managedOnly}' is only accepted for a managed repository`,
        );
      }
    }
    return { mode, ...(path !== null ? { path } : {}) };
  }
  const cleanup = optionalString(obj, 'cleanup');
  if (cleanup !== null && cleanup !== 'keep' && cleanup !== 'delete-on-close') {
    throw new ValidationError(`param '${key}.cleanup' must be 'keep' or 'delete-on-close'`);
  }
  const baseRef = optionalString(obj, 'base_ref');
  const branch = optionalString(obj, 'branch');
  const slug = optionalString(obj, 'slug');
  return {
    mode,
    ...(path !== null ? { path } : {}),
    ...(baseRef !== null ? { base_ref: baseRef } : {}),
    ...(branch !== null ? { branch } : {}),
    ...(slug !== null ? { slug } : {}),
    ...(cleanup !== null ? { cleanup } : {}),
  };
}

/**
 * Project the canonical policy onto the worktree request the entity stores
 * consume. `cwd` is `null` when the caller named no path, which the owning
 * service resolves to its own default workspace.
 */
export function repoWorktree(
  repo: TeamCreateRepoRequest | null,
): { cwd: string | null; worktree: TeamMateWorktreeRequest } | null {
  if (repo === null) return null;
  const cwd = repo.path ?? null;
  if (repo.mode === 'reuse-cwd') return { cwd, worktree: { mode: 'reuse-cwd' } };
  return {
    cwd,
    worktree: {
      mode: 'managed',
      ...(repo.slug !== undefined ? { slug: repo.slug } : {}),
      ...(repo.base_ref !== undefined ? { base_ref: repo.base_ref } : {}),
      ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
      ...(repo.cleanup !== undefined ? { cleanup: repo.cleanup } : {}),
    },
  };
}

export function historyQuery(params: CommandPayload): AgentEntityHistoryQuery {
  const name = optionalString(params, 'name');
  const status = optionalTeammateStatus(params, 'status');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  return {
    ...(name !== null ? { name } : {}),
    ...(status !== null ? { status } : {}),
    ...(agentRuntime !== null ? { agentRuntime } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

export function optionalTeamStatus(
  params: CommandPayload,
  key: string,
): 'starting' | 'running' | 'closed' | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value === 'starting' || value === 'running' || value === 'closed') return value;
  throw new ValidationError(`param '${key}' must be starting, running, or closed`);
}

export function optionalInteger(params: CommandPayload, key: string): number | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new ValidationError(`param '${key}' must be an integer`);
  }
  return value as number;
}

export function optionalStringField(
  params: CommandPayload,
  key: string,
): Record<string, string> {
  const value = optionalString(params, key);
  return value === null ? {} : { [key]: value };
}

export function optionalNullableStringField(
  params: CommandPayload,
  key: string,
): Record<string, string | null> {
  if (!(key in params)) return {};
  const value = params[key];
  if (value === null) return { [key]: null };
  if (typeof value !== 'string') {
    throw new ValidationError(`param '${key}' must be a string or null`);
  }
  return { [key]: value };
}

export function optionalBooleanField(
  params: CommandPayload,
  key: string,
): Record<string, boolean> {
  if (!(key in params)) return {};
  const value = params[key];
  if (typeof value !== 'boolean') {
    throw new ValidationError(`param '${key}' must be a boolean`);
  }
  return { [key]: value };
}

export function optionalRecordField(
  params: CommandPayload,
  key: string,
): Record<string, Record<string, unknown>> {
  if (!(key in params)) return {};
  const value = params[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object`);
  }
  return { [key]: value as Record<string, unknown> };
}

export function optionalNullableRecordField(
  params: CommandPayload,
  key: string,
): Record<string, Record<string, unknown> | null> {
  if (!(key in params)) return {};
  const value = params[key];
  if (value === null) return { [key]: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`param '${key}' must be an object or null`);
  }
  return { [key]: value as Record<string, unknown> };
}

function optionalTeammateStatus(
  params: CommandPayload,
  key: string,
): AgentEntityIdentityStatus | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (
    value === 'starting' ||
    value === 'running' ||
    value === 'degraded' ||
    value === 'closed' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new ValidationError(
    `param '${key}' must be starting, running, degraded, closed, or stopped`,
  );
}
