import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import { teamMateNameSegment } from '../../platform/paths.js';

/**
 * Placement of Dreamux-managed Git worktrees (issue #182 PR-4).
 *
 * Managed TeamMate/Team worktrees no longer live under `~/.dreamux`. They are
 * created under the dispatcher's own workspace:
 *
 *   <dispatcher-workspace>/.workspace/worktree/<repo-slug>/<teammate-or-team-slug>/
 *
 * `.workspace/` is a Dreamux-owned, self-ignored boundary inside the workspace
 * (see WorktreeManager.prepare, which drops a `*` .gitignore). `<repo-slug>`
 * disambiguates worktrees of different source repos that happen to share a
 * basename; the inner slug is the teammate name or `team-<id>`.
 */

/** Dreamux-owned boundary directory inside a dispatcher workspace. */
export const MANAGED_WORKSPACE_DIRNAME = '.workspace';
const WORKTREE_SUBDIR = 'worktree';
const WORK_SUBDIR = 'work';

/** `<workspace>/.workspace` — the Dreamux-owned boundary, self-ignored. */
export function managedWorkspaceDir(dispatcherWorkspace: string): string {
  return join(dispatcherWorkspace, MANAGED_WORKSPACE_DIRNAME);
}

/** The `.gitignore` Dreamux writes into `.workspace` so it never becomes repo content. */
export function managedWorkspaceGitignorePath(dispatcherWorkspace: string): string {
  return join(managedWorkspaceDir(dispatcherWorkspace), '.gitignore');
}

/** `<workspace>/.workspace/worktree` — root of all managed git worktrees. */
export function managedWorktreeRoot(dispatcherWorkspace: string): string {
  return join(managedWorkspaceDir(dispatcherWorkspace), WORKTREE_SUBDIR);
}

/** `<workspace>/.workspace/work` — root of default (non-git) per-name work dirs. */
export function managedWorkRoot(dispatcherWorkspace: string): string {
  return join(managedWorkspaceDir(dispatcherWorkspace), WORK_SUBDIR);
}

/**
 * Absolute path of the default (no-`repo`) plain work directory for a concrete
 * TeamMate/Team name under a dispatcher workspace (issue #199). Unlike a managed
 * worktree this is a plain `mkdir`'d directory, not a git worktree — so the
 * dispatcher cwd need not be a git repo — and it shares the self-ignored
 * `.workspace/` boundary so it never becomes dispatcher-repo content. The inner
 * segment is sanitized the same way every neutral teammate path segment is.
 */
export function defaultWorkspaceWorkPath(input: {
  dispatcherWorkspace: string;
  slug: string;
}): string {
  return join(
    managedWorkRoot(input.dispatcherWorkspace),
    teamMateNameSegment(input.slug),
  );
}

/**
 * Repo-disambiguated slug: a sanitized basename joined to a short, stable hash
 * of the canonical source-repo root. Two distinct repos that share a basename
 * map to distinct directories; the same repo always maps to the same directory
 * across every Team and TeamMate worktree, so collisions inside a repo are
 * carried entirely by the inner slug (and caught by the existing
 * managed-worktree-availability check).
 */
export function repoDisambiguatedSlug(canonicalRepoRoot: string): string {
  const base = teamMateNameSegment(basename(canonicalRepoRoot)) || 'repo';
  const hash = createHash('sha256').update(canonicalRepoRoot).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}

/**
 * Absolute path of a managed worktree for a (source repo, slug) pair under a
 * dispatcher workspace. The inner slug segment is sanitized the same way every
 * neutral teammate path segment is.
 */
export function managedWorktreePath(input: {
  dispatcherWorkspace: string;
  canonicalRepoRoot: string;
  slug: string;
}): string {
  return join(
    managedWorktreeRoot(input.dispatcherWorkspace),
    repoDisambiguatedSlug(input.canonicalRepoRoot),
    teamMateNameSegment(input.slug),
  );
}
