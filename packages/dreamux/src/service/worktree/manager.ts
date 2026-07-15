import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { execa } from 'execa';

import { isNotFound } from '../../platform/fs-errors.js';
import {
  isRealPathUnderDreamuxRoot,
  teamMateNameSegment,
} from '../../platform/paths.js';
import {
  defaultWorkspaceWorkPath,
  directWorkspaceWorkPath,
  managedWorkspaceDir,
  managedWorkspaceGitignorePath,
  managedWorktreePath,
} from './paths.js';
import type {
  AgentEntityWorktreeCleanupState,
  AgentEntityWorktreeIdentity,
} from '../agent-entity/types.js';
import type { TeamMateWorktreeRequest } from '../teammate-collection/types.js';

export interface PreparedTeamMateWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: AgentEntityWorktreeIdentity;
}

export class WorktreeManager {
  async prepare(input: {
    dispatcherId: string;
    teammateName: string;
    cwd: string;
    /**
     * The validated dispatcher workspace (issue #182 PR-4): managed worktrees
     * are placed under `<dispatcherWorkspace>/.workspace/worktree/...`. Required
     * for managed mode; reuse-cwd ignores it (and callers omit it there, so a
     * reuse-cwd spawn never forces the dispatcher cwd contract).
     */
    dispatcherWorkspace?: string;
    request?: TeamMateWorktreeRequest;
  }): Promise<PreparedTeamMateWorkspace> {
    const sourceCwd = resolve(input.cwd);
    const mode = input.request?.mode ?? 'reuse-cwd';
    if (mode === 'reuse-cwd') {
      await assertDirectory(sourceCwd);
      return {
        sourceCwd,
        sourceRepo: await this.tryRepoRoot(sourceCwd),
        runtimeCwd: sourceCwd,
        worktree: {
          mode: 'reuse-cwd',
          slug: null,
          path: sourceCwd,
          branch: null,
          base_ref: null,
          cleanup: input.request?.cleanup ?? 'keep',
          cleanup_state: 'not-managed',
          cleanup_error: null,
        },
      };
    }

    if (input.dispatcherWorkspace === undefined) {
      throw new Error(
        'managed worktree creation requires a dispatcher workspace; the ' +
          'dispatcher must declare an explicit `cwd` (issue #182 PR-4)',
      );
    }
    // Canonicalize the workspace with realpath BEFORE the Dreamux-home guard and
    // before building the worktree path (issue #182 PR-4, PR #186 review P1): a
    // workspace that is outside `~/.dreamux` lexically but symlinks into it would
    // otherwise place managed worktrees physically under Dreamux home. The
    // workspace exists here — `ensureDispatcherWorkspace` mkdir'd it — so the
    // real path is well-defined.
    const dispatcherWorkspace = await realpath(input.dispatcherWorkspace);
    // A managed worktree must never land inside Dreamux's own home tree —
    // including the retired state-dir fallback and any symlink into it. The cwd
    // contract makes a missing workspace fail at startup; this guard additionally
    // rejects a workspace that (really) resolves under `~/.dreamux`.
    if (await isRealPathUnderDreamuxRoot(dispatcherWorkspace)) {
      throw new Error(
        'managed worktrees must not be created under the Dreamux home ' +
          `(~/.dreamux); dispatcher workspace resolves there: ${dispatcherWorkspace}`,
      );
    }
    const sourceRepo = await this.repoRoot(sourceCwd);
    const canonicalRepoRoot = await realpath(sourceRepo);
    const slug = validateWorktreeSlug(input.request?.slug ?? input.teammateName);
    const branch = input.request?.branch ?? `dreamux/${teamMateNameSegment(slug)}`;
    const baseRef = input.request?.base_ref ?? 'HEAD';
    const baseCommit = await resolveCommit(sourceRepo, baseRef);
    const path = managedWorktreePath({
      dispatcherWorkspace,
      canonicalRepoRoot,
      slug,
    });
    await this.ensureWorkspaceBoundary(dispatcherWorkspace);
    await mkdir(dirname(path), { recursive: true });
    const exists = await pathExists(path);
    if (!exists) {
      const branchExists = await gitOk(sourceRepo, [
        'rev-parse',
        '--verify',
        `refs/heads/${branch}`,
      ]);
      if (
        branchExists &&
        !(await gitOk(sourceRepo, [
          'merge-base',
          '--is-ancestor',
          baseCommit,
          `refs/heads/${branch}`,
        ]))
      ) {
        throw new Error(
          `managed worktree branch does not descend from its pinned base commit: ${branch}`,
        );
      }
      await git(sourceRepo, [
        'worktree',
        'add',
        ...(branchExists ? [] : ['-b', branch]),
        path,
        branchExists ? branch : baseCommit,
      ]);
    } else {
      await assertRegisteredWorktree({
        repo: sourceRepo,
        path,
        branch,
      });
      if (
        !(await gitOk(sourceRepo, [
          'merge-base',
          '--is-ancestor',
          baseCommit,
          `refs/heads/${branch}`,
        ]))
      ) {
        throw new Error(
          `managed worktree branch does not descend from its pinned base commit: ${branch}`,
        );
      }
    }
    return {
      sourceCwd,
      sourceRepo,
      runtimeCwd: path,
      worktree: {
        mode: 'managed',
        slug,
        path,
        branch,
        base_ref: baseRef,
        cleanup: input.request?.cleanup ?? 'keep',
        cleanup_state: 'managed-active',
        cleanup_error: null,
      },
    };
  }

  /**
   * Prepare the default (no-`repo`) workspace for a concrete TeamMate/Team name
   * (issue #199): either a plain `<dispatcherWorkspace>/.workspace/work/<slug>/`
   * directory when workspace isolation is enabled, or the dispatcher workspace
   * itself when explicitly disabled. Neither mode creates a git worktree. The
   * dispatcher cwd need not be a git repo — no git command runs — so
   * `source_repo` is reported as null even if the directory happens to sit inside
   * a repo. The `.workspace/` boundary is only created for the isolated mode.
   */
  async prepareDefaultWorkspace(input: {
    dispatcherWorkspace: string;
    slug: string;
    workspaceEnabled: boolean;
  }): Promise<PreparedTeamMateWorkspace> {
    const dispatcherWorkspace = await realpath(input.dispatcherWorkspace);
    if (await isRealPathUnderDreamuxRoot(dispatcherWorkspace)) {
      throw new Error(
        'default TeamMate/Team work directories must not be created under the ' +
          `Dreamux home (~/.dreamux); dispatcher workspace resolves there: ${dispatcherWorkspace}`,
      );
    }
    if (input.workspaceEnabled) {
      await this.ensureWorkspaceBoundary(dispatcherWorkspace);
    }
    const path = input.workspaceEnabled
      ? defaultWorkspaceWorkPath({ dispatcherWorkspace, slug: input.slug })
      : directWorkspaceWorkPath({ dispatcherWorkspace, slug: input.slug });
    await mkdir(path, { recursive: true });
    return {
      sourceCwd: path,
      sourceRepo: null,
      runtimeCwd: path,
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path,
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
    };
  }

  async cleanup(identity: {
    source_cwd: string;
    source_repo: string | null;
    worktree: AgentEntityWorktreeIdentity;
  }): Promise<AgentEntityWorktreeIdentity> {
    const worktree = identity.worktree;
    if (worktree.mode !== 'managed') {
      return worktree;
    }
    if (worktree.cleanup !== 'delete-on-close') {
      return { ...worktree, cleanup_state: 'kept', cleanup_error: null };
    }
    if (!(await pathExists(worktree.path))) {
      // Physical absence is already the desired result. Repository metadata is
      // secondary and may itself have been deleted after the task finished.
      try {
        const repo = identity.source_repo ?? (await this.repoRoot(identity.source_cwd));
        await git(repo, ['worktree', 'prune']);
      } catch {
        // Best effort only: stale Git administrative data cannot resurrect the
        // managed directory and must not turn completed cleanup into failure.
      }
      return { ...worktree, cleanup_state: 'deleted', cleanup_error: null };
    }
    try {
      const repo = identity.source_repo ?? (await this.repoRoot(identity.source_cwd));
      const retain = await retainedState(repo, worktree);
      if (retain !== null) {
        return {
          ...worktree,
          cleanup_state: retain,
          cleanup_error: null,
        };
      }
      await git(repo, ['worktree', 'remove', worktree.path]);
      return { ...worktree, cleanup_state: 'deleted', cleanup_error: null };
    } catch (err) {
      return {
        ...worktree,
        cleanup_state: 'retained-error',
        cleanup_error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Clean the deterministic worktree left by a crash before its Team row was
   * committed. This computes the expected path without preparing or creating it.
   */
  async cleanupProvisional(input: {
    dispatcherWorkspace: string;
    cwd: string;
    slug: string;
    baseRef: string | null;
    branch?: string;
  }): Promise<AgentEntityWorktreeIdentity> {
    const dispatcherWorkspace = await realpath(input.dispatcherWorkspace);
    // Repository policies persist a canonical root. Re-canonicalize while the
    // root exists because some platforms expose a lexical temporary-directory
    // alias (for example, Git reports the physical path). Once the repository
    // is gone, retain the persisted lexical value so physical worktree absence
    // can still converge to `deleted` without requiring the source repository.
    let sourceRepo: string;
    try {
      sourceRepo = await realpath(input.cwd);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      sourceRepo = resolve(input.cwd);
    }
    const sourceCwd = sourceRepo;
    const slug = validateWorktreeSlug(input.slug);
    const worktree: AgentEntityWorktreeIdentity = {
      mode: 'managed',
      slug,
      path: managedWorktreePath({
        dispatcherWorkspace,
        canonicalRepoRoot: sourceRepo,
        slug,
      }),
      branch: input.branch ?? `dreamux/${teamMateNameSegment(slug)}`,
      base_ref: input.baseRef ?? 'HEAD',
      cleanup: 'delete-on-close',
      cleanup_state: 'managed-active',
      cleanup_error: null,
    };
    return this.cleanup({
      source_cwd: sourceCwd,
      source_repo: sourceRepo,
      worktree,
    });
  }

  /**
   * Ensure `<workspace>/.workspace/` exists and self-ignores its whole subtree,
   * so Dreamux-managed worktrees never surface as content of the dispatcher's
   * own repo (issue #182 PR-4). The boundary is Dreamux-owned, so an existing
   * `.gitignore` that does NOT safely ignore everything is repaired to the
   * canonical content rather than trusted (PR #186 review P2): a stale or
   * tampered boundary file would otherwise let worktree contents leak into the
   * dispatcher repo view.
   */
  private async ensureWorkspaceBoundary(dispatcherWorkspace: string): Promise<void> {
    await mkdir(managedWorkspaceDir(dispatcherWorkspace), { recursive: true });
    const gitignore = managedWorkspaceGitignorePath(dispatcherWorkspace);
    if (await boundaryGitignoreIsSafe(gitignore)) return;
    await writeFile(gitignore, BOUNDARY_GITIGNORE_CONTENT, 'utf8');
  }

  private async repoRoot(cwd: string): Promise<string> {
    const result = await git(cwd, ['rev-parse', '--show-toplevel']);
    return result.stdout.trim();
  }

  private async tryRepoRoot(cwd: string): Promise<string | null> {
    try {
      return await this.repoRoot(cwd);
    } catch {
      return null;
    }
  }
}

const BOUNDARY_GITIGNORE_CONTENT =
  '# Dreamux-managed worktrees — never repo content.\n*\n';

/**
 * A `.workspace/.gitignore` is "safe" only when it ignores everything in the
 * boundary: it must contain a bare `*` ignore-all line and NO `!`-negation that
 * could un-ignore worktree content (PR #186 review P2). A missing file is
 * unsafe (nothing is ignored yet). Comments and blank lines are ignored.
 */
async function boundaryGitignoreIsSafe(gitignorePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  let ignoresAll = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) return false;
    if (line === '*') ignoresAll = true;
  }
  return ignoresAll;
}

async function retainedState(
  repo: string,
  worktree: AgentEntityWorktreeIdentity,
): Promise<AgentEntityWorktreeCleanupState | null> {
  const unmerged = await git(worktree.path, ['ls-files', '-u']);
  if (unmerged.stdout.trim() !== '') return 'retained-unmerged';
  const status = await git(worktree.path, ['status', '--porcelain=v1', '-uall']);
  if (status.stdout.trim() !== '') return 'retained-dirty';
  const head = await git(worktree.path, ['rev-parse', '--verify', 'HEAD']);
  const headSha = head.stdout.trim();
  const safeRefs = await safeReachabilityRefs(repo, worktree);
  if (safeRefs.length === 0) return 'retained-unique-commits';
  const containsHead = await git(repo, [
    'branch',
    '--contains',
    headSha,
    '--format=%(refname:short)',
  ]);
  const containingRefs = new Set(
    containsHead.stdout
      .split('\n')
      .map((line) => line.replace(/^\*\s*/, '').trim())
      .filter((line) => line !== ''),
  );
  if (!safeRefs.some((ref) => containingRefs.has(ref))) {
    return 'retained-unique-commits';
  }
  return null;
}

async function safeReachabilityRefs(
  repo: string,
  worktree: AgentEntityWorktreeIdentity,
): Promise<string[]> {
  const refs = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  const allRefs = refs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref !== '');
  const candidates = new Set<string>();
  for (const ref of allRefs) {
    if (worktree.branch === null || ref !== worktree.branch) candidates.add(ref);
  }
  if (worktree.base_ref !== null) {
    const baseSha = await revParseOrNull(repo, worktree.base_ref);
    if (baseSha !== null) {
      for (const ref of allRefs) {
        if (await gitOk(repo, ['merge-base', '--is-ancestor', baseSha, ref])) {
          candidates.add(ref);
        }
      }
    }
  }
  return [...candidates];
}

async function revParseOrNull(cwd: string, ref: string): Promise<string | null> {
  try {
    const result = await git(cwd, ['rev-parse', '--verify', ref]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  const result = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const commit = result.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error('managed worktree base did not resolve to a canonical Git object ID');
  }
  return commit;
}

async function assertRegisteredWorktree(input: {
  repo: string;
  path: string;
  branch: string;
}): Promise<void> {
  const entries = await listWorktrees(input.repo);
  const expectedPath = await realpath(input.path);
  const matched = entries.find((entry) => entry.path === expectedPath);
  if (matched === undefined) {
    throw new Error(
      `managed worktree path already exists but is not registered for source repo: ${input.path}`,
    );
  }
  const expectedBranch = `refs/heads/${input.branch}`;
  if (matched.branch !== expectedBranch) {
    throw new Error(
      `managed worktree path already exists with unexpected branch: ` +
        `${input.path} has ${matched.branch ?? 'detached HEAD'}, expected ${expectedBranch}`,
    );
  }
}

async function listWorktrees(
  repo: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) entries.push(current);
      current = { path: await realpath(line.slice('worktree '.length)), branch: null };
    } else if (line.startsWith('branch ') && current !== null) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return execa('git', args, { cwd });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`cwd is not a directory: ${path}`);
  }
}

function validateWorktreeSlug(slug: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slug)) {
    throw new Error(
      'worktree slug must be 1-64 ASCII letters, digits, dots, underscores, ' +
        `or dashes, starting with a letter or digit: ${slug}`,
    );
  }
  return slug;
}
