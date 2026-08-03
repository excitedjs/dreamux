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
import { TeamDissolveInterruptedError } from '../src/service/team-collection/errors.js';
import {
  TEAM_DISSOLVE_RESULT_BUDGET_MS,
  projectDispatcherDissolveResult,
} from '../src/service/team-collection/dissolve-lifecycle.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveRecord,
  TeamSummary,
} from '../src/service/team-collection/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';

const execFileAsync = promisify(execFile);

describe('Dispatcher Team dissolve timing contract', () => {
  it('starts the exact 9s decision budget at method entry', async () => {
    const record = dissolveRecord('waiting_for_team_idle');
    const handle = acceptedHandle(record);
    const dissolve = vi.fn(async () => handle);
    const project = vi.fn(async () => handle.receipt);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValue(10_000);
    const context = {
      teamChannels: { dissolve },
      teams: { dispatcherDissolveResult: project },
      admitOperation: async <T>(task: () => Promise<T>) => task(),
    };
    const invoke = DispatcherService.prototype.dissolveTeam as unknown as (
      this: typeof context,
      input: { teamId: string; note: string },
    ) => Promise<unknown>;

    await expect(invoke.call(context, {
      teamId: 'alpha',
      note: 'finish safely',
    })).resolves.toEqual(handle.receipt);
    expect(TEAM_DISSOLVE_RESULT_BUDGET_MS).toBe(9_000);
    expect(dissolve).toHaveBeenCalledWith({
      teamId: 'alpha',
      note: 'finish safely',
      decisionDeadlineAt: 10_000,
    });
    expect(project).toHaveBeenCalledWith(handle, 0);
  });

  it('projects cleanup-pending after timeout without budget-external state I/O', async () => {
    const record = dissolveRecord('worktree_cleanup_pending');
    const handle = acceptedHandle(record);
    await expect(projectDispatcherDissolveResult(handle, 0)).resolves.toEqual({
      accepted: true,
      team_name: 'alpha',
      status: 'closed',
      worktree_cleanup: 'pending',
      message: 'Managed worktree cleanup continues in the background.',
    });
  });

  it('preserves cleanup-pending projection across shutdown interruption', async () => {
    const record = dissolveRecord('worktree_cleanup_pending');
    const handle = {
      ...acceptedHandle(record),
      completed: Promise.reject(new TeamDissolveInterruptedError()),
    };
    await expect(projectDispatcherDissolveResult(handle, 9_000)).resolves
      .toEqual({
        accepted: true,
        team_name: 'alpha',
        status: 'closed',
        worktree_cleanup: 'pending',
        message: 'Managed worktree cleanup continues in the background.',
      });
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

  it('requires unique commits to be preserved on another local or remote ref', async () => {
    const { repo, manager, identity, git } = await fixture('unique');
    writeFileSync(join(identity.worktree.path, 'unique.txt'), 'unique\n');
    await git(identity.worktree.path, ['add', 'unique.txt']);
    await git(identity.worktree.path, ['commit', '-qm', 'unique work']);
    const head = await git(identity.worktree.path, ['rev-parse', 'HEAD']);
    await expect(manager.assessCleanup(identity)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'unique-commits',
    });

    await git(repo, ['branch', 'preserved-local', head]);
    await expect(manager.assessCleanup(identity)).resolves.toEqual({
      status: 'eligible',
    });
    await git(repo, ['branch', '-D', 'preserved-local']);
    await git(repo, ['update-ref', 'refs/remotes/origin/preserved', head]);
    await expect(manager.assessCleanup(identity)).resolves.toEqual({
      status: 'eligible',
    });
    await expect(manager.cleanup(identity)).resolves.toMatchObject({
      cleanup_state: 'deleted',
    });
    expect(existsSync(identity.worktree.path)).toBe(false);
  });

  it('honors an absolute deadline before any assessment probe', async () => {
    const { manager, identity } = await fixture('deadline');
    await expect(manager.assessCleanup(identity, {
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow(/deadline exceeded/);
    expect(existsSync(identity.worktree.path)).toBe(true);
  });
});

function dissolveRecord(phase: TeamDissolveRecord['phase']): TeamDissolveRecord {
  return {
    operation_id: 'operation-alpha',
    requester_kind: 'dispatcher',
    leader_name: null,
    target_handoff_ids: [],
    note: 'finish safely',
    accepted_at: 1,
    phase,
    last_error: null,
    cleanup_attempts: 0,
    next_retry_at: null,
  };
}

function acceptedHandle(record: TeamDissolveRecord): AcceptedTeamDissolve {
  const pending = new Promise<TeamSummary>(() => {});
  return {
    operationId: record.operation_id,
    teamId: 'alpha',
    receipt: { accepted: true, team_name: 'alpha', status: 'closing' },
    logicalClosed: pending,
    completed: pending,
    dissolveSnapshot: () => record,
  };
}
