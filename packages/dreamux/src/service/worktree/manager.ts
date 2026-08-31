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
import type {
  TeamMateSharedWorkspace,
  TeamMateWorktreeRequest,
} from '../teammate-collection/types.js';

export type WorktreeCleanupBlockedReason =
  | 'dirty'
  | 'unmerged';

export type WorktreeCleanupAssessment =
  | {
      status: 'terminal';
      worktree: AgentEntityWorktreeIdentity;
    }
  | {
      status: 'eligible';
    }
  | {
      status: 'blocked';
      reason: WorktreeCleanupBlockedReason;
      worktree: AgentEntityWorktreeIdentity;
    };

interface WorktreeAssessmentOptions {
  /** Absolute wall-clock deadline for every Git probe in this assessment. */
  deadlineAt?: number;
}

export interface WorktreeCleanupOptions {
  /**
   * Discard uncommitted, untracked, and unmerged work in this worktree so the
   * checkout can be removed. It authorizes losing that and nothing else: the
   * managed branch and every commit on it survive, and a worktree that is not
   * this Team's own managed checkout is never reached at all.
   */
  force?: boolean;
}

/**
 * The neutral "this Agent just runs in a directory" workspace fact.
 *
 * It owns nothing: there is no managed checkout behind it, so no close, cleanup,
 * or recovery path has anything to reclaim. Every borrower of somebody else's
 * directory — a Team member running in its Team's checkout, a default work dir —
 * records exactly this.
 */
export function reuseCwdWorktree(
  path: string,
  cleanup: AgentEntityWorktreeIdentity['cleanup'] = 'keep',
): AgentEntityWorktreeIdentity {
  return {
    mode: 'reuse-cwd',
    slug: null,
    path,
    branch: null,
    base_ref: null,
    cleanup,
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };
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
  }): Promise<TeamMateSharedWorkspace> {
    const sourceCwd = resolve(input.cwd);
    const mode = input.request?.mode ?? 'reuse-cwd';
    if (mode === 'reuse-cwd') {
      await assertDirectory(sourceCwd);
      return {
        sourceCwd,
        sourceRepo: await this.tryRepoRoot(sourceCwd),
        runtimeCwd: sourceCwd,
        worktree: reuseCwdWorktree(sourceCwd, input.request?.cleanup ?? 'keep'),
        // Borrowed, never created: the directory had to exist to be used.
        createdCheckout: false,
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
      await git(sourceRepo, [
        'worktree',
        'add',
        ...(branchExists ? [] : ['-b', branch]),
        path,
        branchExists ? branch : baseRef,
      ]);
    } else {
      await assertRegisteredWorktree({
        repo: sourceRepo,
        path,
        branch,
      });
    }
    return {
      sourceCwd,
      sourceRepo,
      runtimeCwd: path,
      createdCheckout: !exists,
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
  }): Promise<TeamMateSharedWorkspace> {
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
      worktree: reuseCwdWorktree(path),
      // A plain work directory, not a checkout: there is nothing to reclaim.
      createdCheckout: false,
    };
  }

  async cleanup(
    identity: {
      source_cwd: string;
      source_repo: string | null;
      worktree: AgentEntityWorktreeIdentity;
    },
    options: WorktreeCleanupOptions = {},
  ): Promise<AgentEntityWorktreeIdentity> {
    const worktree = identity.worktree;
    const force = options.force === true;
    try {
      const assessment = await this.assessCleanup(identity);
      if (assessment.status === 'terminal') return assessment.worktree;
      if (assessment.status === 'blocked' && !force) return assessment.worktree;
      const repo = identity.source_repo ?? (await this.repoRoot(identity.source_cwd));
      if (force) await assertRemovableWorktree({ repo, path: worktree.path });
      await git(repo, [
        'worktree',
        'remove',
        ...(force ? ['--force'] : []),
        worktree.path,
      ]);
      return { ...worktree, cleanup_state: 'deleted', cleanup_error: null };
    } catch (err) {
      // Git's non-forced removal is the final authority. Re-read the cheap
      // dirty/unmerged facts before classifying its refusal as operational. A
      // terminal/blocked result is durable truth, not an infinite retry.
      try {
        const latest = await this.assessCleanup(identity);
        if (latest.status !== 'eligible') return latest.worktree;
      } catch {
        // Preserve the mutation failure below; a later lifecycle retry will
        // repeat the complete assessment.
      }
      return {
        ...worktree,
        cleanup_state: 'retained-error',
        cleanup_error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Assess automatic cleanup without mutating Git, the filesystem, or Dreamux
   * state. Team dissolve uses this authoritative capability before admission
   * and repeats it after every already-admitted shared-worktree writer is idle.
   */
  async assessCleanup(identity: {
    source_cwd: string;
    source_repo: string | null;
    worktree: AgentEntityWorktreeIdentity;
  }, options: WorktreeAssessmentOptions = {}): Promise<WorktreeCleanupAssessment> {
    assertAssessmentDeadline(options);
    const worktree = identity.worktree;
    if (worktree.mode !== 'managed') {
      return { status: 'terminal', worktree };
    }
    if (worktree.cleanup !== 'delete-on-close') {
      return {
        status: 'terminal',
        worktree: { ...worktree, cleanup_state: 'kept', cleanup_error: null },
      };
    }
    const repo = identity.source_repo ??
      (await this.repoRoot(identity.source_cwd, options));
    if (!(await pathExists(worktree.path, options))) {
      const registered = (await listWorktrees(repo, options)).some(
        (entry) => resolve(entry.path) === resolve(worktree.path),
      );
      if (!registered) {
        return {
          status: 'terminal',
          worktree: { ...worktree, cleanup_state: 'deleted', cleanup_error: null },
        };
      }
    }
    const blocked = await retainedState(worktree, options);
    assertAssessmentDeadline(options);
    if (blocked === null) return { status: 'eligible' };
    return {
      status: 'blocked',
      reason: blockedReason(blocked),
      worktree: { ...worktree, cleanup_state: blocked, cleanup_error: null },
    };
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

  private async repoRoot(
    cwd: string,
    options: WorktreeAssessmentOptions = {},
  ): Promise<string> {
    const result = await git(cwd, ['rev-parse', '--show-toplevel'], options);
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
  worktree: AgentEntityWorktreeIdentity,
  options: WorktreeAssessmentOptions = {},
): Promise<
  | Extract<
      AgentEntityWorktreeCleanupState,
      'retained-dirty' | 'retained-unmerged'
    >
  | null
> {
  const unmerged = await git(worktree.path, ['ls-files', '-u'], options);
  if (unmerged.stdout.trim() !== '') return 'retained-unmerged';
  const status = await git(
    worktree.path,
    ['status', '--porcelain=v1', '-uall'],
    options,
  );
  if (status.stdout.trim() !== '') return 'retained-dirty';
  return null;
}

function blockedReason(
  state: Extract<
    AgentEntityWorktreeCleanupState,
    'retained-dirty' | 'retained-unmerged'
  >,
): WorktreeCleanupBlockedReason {
  switch (state) {
    case 'retained-dirty':
      return 'dirty';
    case 'retained-unmerged':
      return 'unmerged';
  }
}

/**
 * Prove what a forced removal is about to delete.
 *
 * Non-forced removal can lean on Git's own refusal; a forced one cannot, so
 * the target is resolved and matched against the repository's worktree
 * registry first. A path that is the repository itself, or that Git does not
 * know as a worktree of it, fails loud rather than being removed — that is the
 * difference between reclaiming this Team's checkout and deleting somebody's
 * source tree.
 */
async function assertRemovableWorktree(input: {
  repo: string;
  path: string;
}): Promise<void> {
  const target = await realpath(input.path);
  if (target === (await realpath(input.repo))) {
    throw new Error(
      'refusing to remove the source repository as a managed worktree: ' +
        input.path,
    );
  }
  const entries = await listWorktrees(input.repo);
  if (!entries.some((entry) => entry.path === target)) {
    throw new Error(
      'refusing to force-remove a path that is not a registered worktree of ' +
        `${input.repo}: ${input.path}`,
    );
  }
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
  options: WorktreeAssessmentOptions = {},
): Promise<Array<{ path: string; branch: string | null }>> {
  const result = await git(repo, ['worktree', 'list', '--porcelain'], options);
  const entries: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) entries.push(current);
      const listedPath = line.slice('worktree '.length);
      current = {
        path: await withinAssessmentDeadline(
          realpath(listedPath).catch((err: unknown) => {
            if (isNotFound(err)) return resolve(listedPath);
            throw err;
          }),
          options,
        ),
        branch: null,
      };
    } else if (line.startsWith('branch ') && current !== null) {
      current.branch = line.slice('branch '.length);
    }
  }
  if (current !== null) entries.push(current);
  return entries;
}

async function git(
  cwd: string,
  args: string[],
  options: WorktreeAssessmentOptions = {},
): Promise<{ stdout: string }> {
  const timeout = options.deadlineAt === undefined
    ? undefined
    : options.deadlineAt - Date.now();
  if (timeout !== undefined && timeout <= 0) {
    throw new Error('worktree assessment deadline exceeded');
  }
  return execa('git', args, {
    cwd,
    ...(timeout === undefined ? {} : { timeout }),
  });
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(
  path: string,
  options: WorktreeAssessmentOptions = {},
): Promise<boolean> {
  try {
    await withinAssessmentDeadline(access(path), options);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function assertAssessmentDeadline(options: WorktreeAssessmentOptions): void {
  if (
    options.deadlineAt !== undefined &&
    options.deadlineAt - Date.now() <= 0
  ) {
    throw new Error('worktree assessment deadline exceeded');
  }
}

async function withinAssessmentDeadline<T>(
  task: Promise<T>,
  options: WorktreeAssessmentOptions,
): Promise<T> {
  if (options.deadlineAt === undefined) return task;
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) {
    void task.catch(() => undefined);
    throw new Error('worktree assessment deadline exceeded');
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('worktree assessment deadline exceeded')),
          remaining,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
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
