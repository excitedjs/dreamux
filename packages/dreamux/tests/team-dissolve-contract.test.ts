import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';

const execFileAsync = promisify(execFile);

describe('Dispatcher Team dissolve timing contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the acceptance-deadline origin before blocked dispatcher admission', async () => {
    const receipt = { accepted: true, team_name: 'alpha', status: 'closing' };
    const dissolve = vi.fn(async () => receipt);
    let releaseAdmission!: () => void;
    const admissionDelay = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const admitOperation = vi.fn(
      async <T>(task: () => Promise<T>): Promise<T> => {
        await admissionDelay;
        return task();
      },
    );
    const context = {
      teamChannels: { dissolve },
      admitOperation,
    };
    const invoke = DispatcherService.prototype.dissolveTeam as unknown as (
      this: typeof context,
      input: { teamId: string; note: string },
    ) => Promise<unknown>;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const result = invoke.call(context, {
      teamId: 'alpha',
      note: 'finish safely',
    });
    expect(admitOperation).toHaveBeenCalledOnce();
    expect(dissolve).not.toHaveBeenCalled();
    now.mockReturnValue(5_000);
    releaseAdmission();

    await expect(result).resolves.toEqual(receipt);
    expect(dissolve).toHaveBeenCalledWith(
      { teamId: 'alpha', note: 'finish safely' },
      1_000,
    );
    expect(now).toHaveBeenCalledOnce();
  });
});

describe('authoritative managed-worktree dissolve preflight', () => {
  const roots: string[] = [];
  let previousDreamuxRoot: string | undefined;

  afterEach(() => {
    if (previousDreamuxRoot === undefined) delete process.env['DREAMUX_ROOT'];
    else process.env['DREAMUX_ROOT'] = previousDreamuxRoot;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function fixture(slug: string) {
    const root = mkdtempSync(join(tmpdir(), 'dreamux-dissolve-worktree-'));
    roots.push(root);
    previousDreamuxRoot = process.env['DREAMUX_ROOT'];
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux-home');
    const repo = join(root, 'source');
    const workspace = join(root, 'workspace');
    mkdirSync(repo, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const git = async (cwd: string, args: string[]) =>
      (await execFileAsync('git', args, { cwd })).stdout.trim();
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'base']);
    const manager = new WorktreeManager();
    const prepared = await manager.prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: slug,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: {
        mode: 'managed',
        slug,
        cleanup: 'delete-on-close',
      },
    });
    const identity = {
      source_cwd: prepared.sourceCwd,
      source_repo: prepared.sourceRepo,
      worktree: prepared.worktree,
    };
    return { root, repo, manager, identity, git };
  }

  it('detects late dirty work and retains it without mutation', async () => {
    const { manager, identity } = await fixture('dirty');
    await expect(manager.assessCleanup(identity)).resolves.toEqual({
      status: 'eligible',
    });
    writeFileSync(join(identity.worktree.path, 'untracked.txt'), 'keep me\n');
    await expect(manager.assessCleanup(identity)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'dirty',
      worktree: { cleanup_state: 'retained-dirty' },
    });
    await expect(manager.cleanup(identity)).resolves.toMatchObject({
      cleanup_state: 'retained-dirty',
      cleanup_error: null,
    });
    expect(existsSync(identity.worktree.path)).toBe(true);
  });

  it('gives unmerged entries precedence over ordinary dirty state', async () => {
    const { repo, manager, identity, git } = await fixture('unmerged');
    const sourceBranch = await git(repo, ['branch', '--show-current']);
    writeFileSync(join(repo, 'shared.txt'), 'source change\n');
    await git(repo, ['add', 'shared.txt']);
    await git(repo, ['commit', '-qm', 'source change']);
    writeFileSync(join(identity.worktree.path, 'shared.txt'), 'worktree change\n');
    await git(identity.worktree.path, ['add', 'shared.txt']);
    await git(identity.worktree.path, ['commit', '-qm', 'worktree change']);
    await expect(
      git(identity.worktree.path, ['merge', sourceBranch]),
    ).rejects.toBeDefined();
    await expect(manager.assessCleanup(identity)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'unmerged',
      worktree: { cleanup_state: 'retained-unmerged' },
    });
  });

  it('removes only the worktree and preserves its branch-only unique commit', async () => {
    const { repo, manager, identity, git } = await fixture('unique');
    writeFileSync(join(identity.worktree.path, 'unique.txt'), 'unique\n');
    await git(identity.worktree.path, ['add', 'unique.txt']);
    await git(identity.worktree.path, ['commit', '-qm', 'unique work']);
    const head = await git(identity.worktree.path, ['rev-parse', 'HEAD']);
    const branch = identity.worktree.branch!;
    const retainingRefs = (await git(repo, [
      'for-each-ref',
      '--format=%(refname)',
      `--contains=${head}`,
      'refs/heads',
      'refs/remotes',
    ])).split('\n').filter(Boolean);
    expect(retainingRefs).toEqual([`refs/heads/${branch}`]);

    await expect(manager.assessCleanup(identity)).resolves.toEqual({
      status: 'eligible',
    });
    await expect(manager.cleanup(identity)).resolves.toMatchObject({
      cleanup_state: 'deleted',
    });
    expect(existsSync(identity.worktree.path)).toBe(false);
    expect(await git(repo, ['worktree', 'list', '--porcelain']))
      .not.toContain(identity.worktree.path);
    expect(await git(repo, [
      'rev-parse',
      '--verify',
      `refs/heads/${branch}`,
    ])).toBe(head);
    await expect(git(repo, ['cat-file', '-e', `${head}^{commit}`]))
      .resolves.toBe('');
    await expect(git(repo, ['show', `${branch}:unique.txt`]))
      .resolves.toBe('unique');
  });

  it('honors an absolute deadline before any assessment probe', async () => {
    const { manager, identity } = await fixture('deadline');
    await expect(manager.assessCleanup(identity, {
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow(/deadline exceeded/);
    expect(existsSync(identity.worktree.path)).toBe(true);
  });
});
