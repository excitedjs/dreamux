import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from '../src/service/worktree/manager.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import { TeamWorktreeCleanup } from '../src/service/team-collection/worktree-cleanup.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';

const execFileAsync = promisify(execFile);

/**
 * Behavioral coverage for the worktree layer's ownership and safety contracts
 * (coverage cell G): who owns rollback of a partially-created managed worktree,
 * how `cleanup-pending` is recovered from a durable record alone, and the exact
 * bounds a `force` cleanup is confined to. Real temporary git repositories are
 * used throughout — no execa/git mocking — because these ARE the behaviors the
 * mocked scale test in `worktree-cleanup-structure.test.ts` deliberately does
 * not exercise (it proves git call SHAPE at repository scale; this proves git
 * outcome CORRECTNESS against a real checkout).
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/** A real, minimal git repository with one commit on `master`/`main`. */
async function initRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe('WorktreeManager.prepare(): create-failure ownership', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-create-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a failed `git worktree add` leaves no durable claim: no branch, no registered worktree, no directory', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const manager = new WorktreeManager();

    await expect(
      manager.prepare({
        dispatcherId: 'flow',
        teammateName: 'reviewer',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed', base_ref: 'refs/heads/does-not-exist' },
      }),
    ).rejects.toThrow();

    // Nothing durable survives the failed attempt: no identity was ever
    // written (WorktreeManager itself persists nothing — that is the caller's
    // job, and the caller never got a result to persist), Git created no
    // branch, and it registered no worktree.
    const worktreeList = await git(repo, ['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toMatch(/dreamux\/reviewer/);
    const branches = await git(repo, ['branch', '--list']);
    expect(branches).not.toMatch(/dreamux\/reviewer/);
  });

  it('ownership of a retry after a failed attempt: WorktreeManager itself, since nothing durable was claimed', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const manager = new WorktreeManager();

    await expect(
      manager.prepare({
        dispatcherId: 'flow',
        teammateName: 'reviewer',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed', base_ref: 'refs/heads/does-not-exist' },
      }),
    ).rejects.toThrow();

    // A clean retry with a valid base_ref succeeds without any special
    // recovery step from the caller: the failed attempt left nothing behind
    // that a retry must first undo.
    const result = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'reviewer',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed', base_ref: 'HEAD' },
    });
    expect(result.createdCheckout).toBe(true);
    expect(result.worktree.cleanup_state).toBe('managed-active');
    expect(await pathIsDirectory(result.worktree.path)).toBe(true);
  });
});

describe('TeamWorktreeCleanup.settle(): cleanup-pending is record-only recovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-pending-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function baseTeamInput(input: {
    teamId: string;
    worktree: TeamRecord['worktree'];
    force: boolean;
  }): Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'> {
    return {
      dispatcher_id: 'flow',
      team_id: input.teamId,
      name: input.teamId,
      repo_cwd: input.worktree.path,
      source_repo: null,
      leader_name: `tl-${input.teamId}-abcd`,
      leader_agent_runtime: 'codex',
      leader_identity_prompt: null,
      leader_skill_sources: [],
      runtime_cwd: input.worktree.path,
      worktree: input.worktree,
      status: 'closed',
      intent: 'ship the feature',
      closed_at: Date.now(),
      close_note: 'dissolved',
      create_request_id: null,
      create_payload_hash: null,
    };
  }

  it('reclaims a cleanup-pending managed worktree from the record alone, without ever constructing a TeamService', async () => {
    // This test file never imports `TeamService` at all — the absence is the
    // proof. `TeamWorktreeCleanup` is given only a `TeamStore` and a
    // `WorktreeManager`, exactly the durable-fact-recovery contract in
    // `.agents/tasks/architecture/minimize-provider-boundaries/`
    // (`worktree-cleanup.ts` doc comment): "there is no live Team left to
    // construct."
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const manager = new WorktreeManager();
    const prepared = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'team-alpha',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    expect(await pathIsDirectory(prepared.worktree.path)).toBe(true);

    const teamStoreRoot = join(root, 'state', 'team');
    const store = new TeamStore({ root: teamStoreRoot, dispatcherId: 'flow' });
    const created = await store.create(
      baseTeamInput({
        teamId: 'team-alpha',
        worktree: { ...prepared.worktree, cleanup_state: 'cleanup-pending' },
        force: false,
      }),
    );
    expect(created).not.toBeNull();

    const cleanup = new TeamWorktreeCleanup({ store, worktrees: manager });
    await cleanup.settle('team-alpha');

    // The physical checkout is gone…
    expect(await pathIsDirectory(prepared.worktree.path)).toBe(false);
    // …and the ONLY durable fact — the record — reflects it. Nothing else
    // was ever consulted or written.
    const settled = await store.get('team-alpha');
    expect(settled!.worktree.cleanup_state).toBe('deleted');
    expect(settled!.worktree.cleanup_error).toBeNull();
  });

  it('is a no-op for a record that is not cleanup-pending (idempotent, never re-derives work)', async () => {
    const repo = await initRepo(root);
    const teamStoreRoot = join(root, 'state', 'team');
    const store = new TeamStore({ root: teamStoreRoot, dispatcherId: 'flow' });
    const created = await store.create(
      baseTeamInput({
        teamId: 'team-beta',
        worktree: {
          mode: 'reuse-cwd',
          slug: null,
          path: repo,
          branch: null,
          base_ref: null,
          cleanup: 'keep',
          cleanup_state: 'not-managed',
          cleanup_error: null,
        },
        force: false,
      }),
    );
    expect(created).not.toBeNull();

    const cleanup = new TeamWorktreeCleanup({
      store,
      worktrees: new WorktreeManager(),
    });
    await cleanup.settle('team-beta');

    const after = await store.get('team-beta');
    expect(after!.updated_at).toBe(created!.updated_at);
    expect(after!.worktree.cleanup_state).toBe('not-managed');
  });
});

describe('WorktreeManager: force cleanup bounds', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-force-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to force-remove the source repository itself, even when named as the worktree path', async () => {
    const repo = await initRepo(root);
    const manager = new WorktreeManager();
    const identity = {
      source_cwd: repo,
      source_repo: repo,
      worktree: {
        mode: 'managed' as const,
        slug: 'x',
        // The worktree "path" is (incorrectly, or maliciously) the repo root
        // itself — the exact case the containment check exists to catch.
        path: repo,
        branch: 'dreamux/x',
        base_ref: 'HEAD',
        cleanup: 'delete-on-close' as const,
        cleanup_state: 'managed-active' as const,
        cleanup_error: null,
      },
    };
    const result = await manager.cleanup(identity, { force: true });
    expect(result.cleanup_state).toBe('retained-error');
    expect(result.cleanup_error).toMatch(/refusing to remove the source repository/);
    // The repo is untouched: still a readable git repo with its commit.
    expect(await pathIsDirectory(repo)).toBe(true);
    expect((await git(repo, ['log', '--oneline'])).trim()).not.toBe('');
  });

  it('refuses to force-remove a path that is not a registered worktree of the source repo', async () => {
    const repo = await initRepo(root);
    // An unrelated, but otherwise perfectly clean, second git repository — not
    // a worktree of `repo` at all. This is the "never a reused cwd / never
    // some other checkout" bound: a clean unrelated git directory must not be
    // treated as this Team's own managed checkout just because its identity
    // claims `mode: managed`.
    const decoy = await initRepo(join(root, 'decoy-root'));

    const manager = new WorktreeManager();
    const identity = {
      source_cwd: repo,
      source_repo: repo,
      worktree: {
        mode: 'managed' as const,
        slug: 'x',
        path: decoy,
        branch: 'dreamux/x',
        base_ref: 'HEAD',
        cleanup: 'delete-on-close' as const,
        cleanup_state: 'managed-active' as const,
        cleanup_error: null,
      },
    };
    const result = await manager.cleanup(identity, { force: true });
    expect(result.cleanup_state).toBe('retained-error');
    expect(result.cleanup_error).toMatch(/not a registered worktree of/);
    // The decoy repo is untouched.
    expect(await pathIsDirectory(decoy)).toBe(true);
    expect((await git(decoy, ['log', '--oneline'])).trim()).not.toBe('');
  });

  it('a dirty managed worktree is retained without force, and only force discards it', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const manager = new WorktreeManager();
    const prepared = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'reviewer',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    // Uncommitted work the operator has not authorized losing.
    await writeFile(join(prepared.worktree.path, 'untracked.txt'), 'wip\n');

    const identity = {
      source_cwd: repo,
      source_repo: repo,
      worktree: prepared.worktree,
    };
    const blocked = await manager.cleanup(identity);
    expect(blocked.cleanup_state).toBe('retained-dirty');
    expect(await pathIsDirectory(prepared.worktree.path)).toBe(true);
    expect(
      await readFile(join(prepared.worktree.path, 'untracked.txt'), 'utf8'),
    ).toBe('wip\n');

    const forced = await manager.cleanup(identity, { force: true });
    expect(forced.cleanup_state).toBe('deleted');
    expect(await pathIsDirectory(prepared.worktree.path)).toBe(false);
  });
});

describe('WorktreeManager: reuse-cwd safety', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-reuse-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('cleanup() never deletes a reuse-cwd workspace, with or without force', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dreamux-reuse-target-'));
    await writeFile(join(workspace, 'keep.txt'), 'do not delete me\n');
    const manager = new WorktreeManager();
    const identity = {
      source_cwd: workspace,
      source_repo: null,
      worktree: {
        mode: 'reuse-cwd' as const,
        slug: null,
        path: workspace,
        branch: null,
        base_ref: null,
        cleanup: 'delete-on-close' as const, // even an (unusual) delete request…
        cleanup_state: 'not-managed' as const,
        cleanup_error: null,
      },
    };

    const withoutForce = await manager.cleanup(identity);
    expect(withoutForce).toEqual(identity.worktree);
    expect(await pathIsDirectory(workspace)).toBe(true);

    const withForce = await manager.cleanup(identity, { force: true });
    expect(withForce).toEqual(identity.worktree);
    expect(await pathIsDirectory(workspace)).toBe(true);
    expect(await readFile(join(workspace, 'keep.txt'), 'utf8')).toBe(
      'do not delete me\n',
    );

    await rm(workspace, { recursive: true, force: true });
  });
});
