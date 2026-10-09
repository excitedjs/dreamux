/**
 * What a caller may ask for a Team's or TeamMate's working directory.
 *
 * The request is a workspace fact, so it is read and judged here rather than in
 * the generic Command payload readers: which properties belong to which mode,
 * and what the canonical request means to the worktree layer, is exactly what
 * this layer owns. Both caller-facing surfaces — the canonical Commands and the
 * MCP delegates — read the same shape through these two functions.
 */
import type {
  JsonSchema,
  TeamCreateRepoRequest,
} from '@excitedjs/dreamux-types';

import { ValidationError } from '../../platform/errors.js';
import {
  mustString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { boundedString, enumOf, objectSchema } from '../../command/schema.js';
import type { TeamMateWorktreeRequest } from './types.js';

/**
 * The complete repository policy a Team or TeamMate may request.
 *
 * One closed object rather than a schema union: `mode` selects which of the
 * remaining properties are meaningful, and {@link repoRequest} rejects a
 * property that does not belong to the selected mode. The managed-only controls
 * stay part of the canonical contract — a Channel that owns a narrower policy
 * maps its own shape into this one instead of Core defining a second schema.
 *
 * This is the only repository schema: the canonical Commands validate against
 * it and the MCP creation tools publish it, so the property descriptions a
 * model reads and the length bounds on caller-supplied strings live here and
 * nowhere else. The bounds are the untrusted-input caps — a filesystem path and
 * a git ref name — not domain rules.
 */
export const REPO_REQUEST_SCHEMA: JsonSchema = objectSchema(
  {
    mode: {
      ...enumOf(['reuse-cwd', 'managed']),
      description:
        'reuse-cwd runs in an existing directory; managed creates a git ' +
        'worktree from a source repository.',
    },
    path: {
      ...boundedString(4096, 1),
      description:
        'reuse-cwd: the directory to run in. managed: the source ' +
        "repository; defaults to this agent's workspace.",
    },
    base_ref: {
      ...boundedString(256, 1),
      description:
        'managed: the ref a newly created branch starts from; default ' +
        'HEAD; ignored when branch already exists.',
    },
    branch: {
      ...boundedString(256, 1),
      description:
        'managed: the branch to create or check out; defaults to ' +
        'dreamux/<teammate_name> for a TeamMate or dreamux/team-<team_name> ' +
        'for a Team, using the concrete allocated name.',
    },
    cleanup: {
      ...enumOf(['keep', 'delete-on-close']),
      description:
        'managed: delete-on-close (the default) removes the worktree when ' +
        'the agent closes or its Team dissolves and the tree is clean; keep ' +
        'leaves it in place.',
    },
  },
  ['mode'],
);

/** The managed-only controls a `reuse-cwd` request must not carry. */
const MANAGED_ONLY_KEYS = ['base_ref', 'branch', 'cleanup'] as const;

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
    throw new ValidationError(
      `param '${key}.mode' must be 'reuse-cwd' or 'managed'`,
    );
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
    throw new ValidationError(
      `param '${key}.cleanup' must be 'keep' or 'delete-on-close'`,
    );
  }
  const baseRef = optionalString(obj, 'base_ref');
  const branch = optionalString(obj, 'branch');
  return {
    mode,
    ...(path !== null ? { path } : {}),
    ...(baseRef !== null ? { base_ref: baseRef } : {}),
    ...(branch !== null ? { branch } : {}),
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
  if (repo.mode === 'reuse-cwd')
    return { cwd, worktree: { mode: 'reuse-cwd' } };
  return {
    cwd,
    worktree: {
      mode: 'managed',
      base_ref: repo.base_ref,
      branch: repo.branch,
      cleanup: repo.cleanup,
    },
  };
}
