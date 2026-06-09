import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { execa } from 'execa';

import { dispatcherTeamMateWorktreePath } from '../../platform/paths.js';
import { teamMateNameSegment } from '../../platform/paths.js';
import type {
  TeamMateWorktreeCleanupState,
  TeamMateWorktreeIdentity,
  TeamMateWorktreeRequest,
} from './types.js';

export interface PreparedTeamMateWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
}

export class WorktreeManager {
  async prepare(input: {
    dispatcherId: string;
    teammateName: string;
    cwd: string;
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

    const sourceRepo = await this.repoRoot(sourceCwd);
    const slug = validateWorktreeSlug(input.request?.slug ?? input.teammateName);
    const branch = input.request?.branch ?? `dreamux/${teamMateNameSegment(slug)}`;
    const baseRef = input.request?.base_ref ?? 'HEAD';
    const path = dispatcherTeamMateWorktreePath(input.dispatcherId, slug);
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

  async cleanup(identity: {
    source_cwd: string;
    source_repo: string | null;
    worktree: TeamMateWorktreeIdentity;
  }): Promise<TeamMateWorktreeIdentity> {
    const worktree = identity.worktree;
    if (worktree.mode !== 'managed') {
      return worktree;
    }
    if (worktree.cleanup !== 'delete-on-close') {
      return { ...worktree, cleanup_state: 'kept', cleanup_error: null };
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

async function retainedState(
  repo: string,
  worktree: TeamMateWorktreeIdentity,
): Promise<TeamMateWorktreeCleanupState | null> {
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
  worktree: TeamMateWorktreeIdentity,
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

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
