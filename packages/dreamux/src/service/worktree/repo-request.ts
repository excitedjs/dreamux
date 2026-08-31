/**
 * What a caller may ask for a Team's or TeamMate's working directory.
 *
 * The request is a workspace fact, so it is read and judged here rather than in
 * the generic Command payload readers: which properties belong to which mode,
 * and what the canonical request means to the worktree layer, is exactly what
 * this layer owns. Both caller-facing surfaces — the canonical Commands and the
 * MCP delegates — read the same shape through these two functions.
 */
import type { JsonSchema, TeamCreateRepoRequest } from '@excitedjs/dreamux-types';

import { ValidationError } from '../../command/errors.js';
import {
  mustString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { STRING, enumOf, objectSchema } from '../../command/schema.js';
import type { TeamMateWorktreeRequest } from '../teammate-collection/types.js';

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
