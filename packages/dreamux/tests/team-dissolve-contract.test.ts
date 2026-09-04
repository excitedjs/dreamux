import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamClosing } from '../src/service/team-service/closing.js';
import type { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { TeamWorktreeCleanup } from '../src/service/team-collection/worktree-cleanup.js';
import type { WorktreeManager } from '../src/service/worktree/manager.js';
import {
  blockedAssessment,
  closingHarness,
  dispatcherDissolve,
  bootDissolveTeam,
  fakeTeamRecord,
  git,
  initGitRepo,
  makeTempDir,
  newWorktreeManager,
  teamLeaderDissolve,
} from './helpers/dissolve-harness.js';

/**
 * COVERAGE CELL D (team-dissolve): the submission contract dissolve makes to
 * BOTH its callers, the fence that keeps a repeated submission from repeating
 * destructive work, the preflight ordering `TeamClosing` owns per caller kind,
 * and the containment `WorktreeManager` enforces before `force` ever deletes
 * anything. See `.agents/tasks/architecture/minimize-provider-boundaries/`
 * `durable-fact-recovery-principles.md` for what this deliberately does NOT
 * test: there is no dissolve phase machine, no controller/runner entity, and
 * no compensating rollback — `team-dissolve-recovery.test.ts` covers that half.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('the admitted ordering TeamClosing owns per caller kind', () => {
  it('a dispatcher-triggered dissolve rechecks the worktree after every runtime stops', async () => {
    const h = closingHarness();

    await expect(h.closing.dissolve(dispatcherDissolve)).resolves.toBeUndefined();

    expect(h.order).toEqual([
      'workflows.stopAll',
      'scheduler.stop',
      'members.stopAll',
      'leader.stopForHost',
      // the post-stop recheck: is the earlier answer still true now that
      // nothing is running?
      'assess',
      // close
      'workflows.stopAll',
      'scheduler.stop',
      'scheduler.deleteStoreFile',
      'members.close',
      'leader.close',
      'record.commit',
    ]);
    expect(h.assessCalls()).toBe(1);
  });

  it('a TeamLeader self-dissolve stops its other children first, checks while it is still alive, then stops itself', async () => {
    const h = closingHarness();

    await expect(h.closing.dissolve(teamLeaderDissolve)).resolves.toBeUndefined();

    expect(h.order).toEqual([
      // A TeamLeader cannot ask "may I reclaim this workspace" about itself
      // while it is still a writer, so its own children stop first.
      'workflows.stopAll',
      'scheduler.stop',
      'members.stopAll',
      // Asked while the leader is still alive, only long enough to admit.
      'assess',
      'workflows.stopAll',
      'scheduler.stop',
      'members.stopAll',
      'leader.stopForHost',
      // The post-stop recheck.
      'assess',
      'workflows.stopAll',
      'scheduler.stop',
      'scheduler.deleteStoreFile',
      'members.close',
      'leader.close',
      'record.commit',
    ]);
    expect(h.assessCalls()).toBe(2);
  });

  it('the post-stop recheck catches a dispatcher-triggered race that dirtied the worktree after the preflight passed', async () => {
    const h = closingHarness({
      assessSequence: [
        { status: 'eligible' },
        blockedAssessment('dirty', { mode: 'managed', path: '/repo' } as never),
      ],
    });

    await expect(h.closing.requireReclaimableWorktree()).resolves.toBeUndefined();
    await expect(h.closing.dissolve(dispatcherDissolve)).rejects.toThrow(/is dirty/);

    // The stop already ran (nothing is undone), but nothing durable closed.
    expect(h.order).toContain('leader.stopForHost');
    expect(h.order).not.toContain('members.close');
    expect(h.order).not.toContain('leader.close');
    expect(h.order).not.toContain('record.commit');
    expect(h.assessCalls()).toBe(2);
    // Reachable again: admission comes back over what really is on disk.
    expect(h.workflowStart).toHaveBeenCalledTimes(1);
    expect(h.schedulerStart).toHaveBeenCalledTimes(1);
  });

  it('the post-stop recheck catches a self-dissolve race the same way', async () => {
    const h = closingHarness({
      assessSequence: [
        { status: 'eligible' },
        blockedAssessment('unmerged', { mode: 'managed', path: '/repo' } as never),
      ],
    });

    await expect(h.closing.dissolve(teamLeaderDissolve)).rejects.toThrow(/is unmerged/);

    expect(h.order).toContain('leader.stopForHost');
    expect(h.order).not.toContain('members.close');
    expect(h.order).not.toContain('leader.close');
    expect(h.order).not.toContain('record.commit');
  });

  it('force collapses both caller kinds to the identical stop-and-close order, with exactly one (unblockable) recheck', async () => {
    const dispatcherForce = closingHarness();
    const teamLeaderForce = closingHarness();

    await dispatcherForce.closing.dissolve({ ...dispatcherDissolve, force: true });
    await teamLeaderForce.closing.dissolve({ ...teamLeaderDissolve, force: true });

    // `force` replaces the preflight question rather than answering it, for
    // either caller: there is nothing left that distinguishes who asked.
    expect(dispatcherForce.order).toEqual(teamLeaderForce.order);
    expect(dispatcherForce.assessCalls()).toBe(1);
    expect(teamLeaderForce.assessCalls()).toBe(1);
  });

  it('force never lets a blocked assessment stop the dissolve', async () => {
    const h = closingHarness({
      assessSequence: [blockedAssessment('dirty', { mode: 'managed', path: '/repo' } as never)],
    });

    await expect(
      h.closing.dissolve({ ...dispatcherDissolve, force: true }),
    ).resolves.toBeUndefined();

    expect(h.order).toContain('record.commit');
  });
});

describe('no idle-drain machinery in the dissolve path', () => {
  it('no file in the dissolve path — TeamClosing, TeamService, member close, or worktree reclaim — ever references waitIdle', async () => {
    const targets = [
      new URL('../src/service/team-service/closing.ts', import.meta.url),
      new URL('../src/service/team-service/index.ts', import.meta.url),
      new URL('../src/service/teammate-collection/dissolve-members.ts', import.meta.url),
      new URL('../src/service/team-collection/worktree-cleanup.ts', import.meta.url),
    ];
    for (const target of targets) {
      const text = await readFile(target, 'utf8');
      // Dissolve is a stop-and-reclaim, never a drain: this absence is the
      // contract, not an incidental fact about the current implementation.
      expect(text).not.toMatch(/\bwaitIdle\b/);
      expect(text).not.toMatch(/\bisIdle\b/);
    }
  });
});

describe('one submission capability: the Dispatcher-facing dissolve surface has no second path', () => {
  it('dissolveTeam and dissolveTeamForLeader both route through the same private submitDissolve, which itself is the only call site that invokes .dissolve(', async () => {
    const text = await readFile(
      new URL('../src/service/dispatcher-service/index.ts', import.meta.url),
      'utf8',
    );

    const sliceBody = (marker: string): string => {
      const start = text.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      // Each of these members is short; the next blank-line-preceded closing
      // brace at column 2 ends it. A generous fixed window is simpler and
      // just as precise for a body this short.
      return text.slice(start, start + 400);
    };

    expect(sliceBody('dissolveTeam(input: TeamDissolveInput)')).toMatch(
      /this\.submitDissolve\(/,
    );
    expect(sliceBody('dissolveTeamForLeader(input:')).toMatch(
      /this\.submitDissolve\(/,
    );

    // The one place that actually calls the Team's own `.dissolve(...)` is
    // `submitDissolve` itself — there is no second, parallel admission path
    // that reaches a Team's dissolve without going through it.
    const dissolveCallSites = text.match(/\)\.dissolve\(input\)/g) ?? [];
    expect(dissolveCallSites).toHaveLength(1);
  });
});

describe('IMMEDIATE RECEIPT: one TeamService submission capability for both callers', () => {
  it('both a dispatcher and a self-dissolving TeamLeader get the identical receipt shape', async () => {
    const dispatcherTeam = await bootDissolveTeam();
    const leaderTeam = await bootDissolveTeam();
    try {
      const dispatcherReceipt = await dispatcherTeam.service.dissolve({
        requester: 'dispatcher',
        force: true,
        note: 'dispatcher dissolve',
      });
      const leaderReceipt = await leaderTeam.service.dissolve({
        requester: 'team_leader',
        force: true,
        note: 'self dissolve',
      });

      // Same fields, same values (modulo the Team each answers for): there is
      // one TeamDissolveReceipt shape, not a dispatcher one and a leader one.
      expect(dispatcherReceipt).toEqual({
        accepted: true,
        team_name: dispatcherTeam.teamId,
        status: 'submitted',
      });
      expect(leaderReceipt).toEqual({
        accepted: true,
        team_name: leaderTeam.teamId,
        status: 'submitted',
      });
      expect(Object.keys(dispatcherReceipt).sort()).toEqual(
        Object.keys(leaderReceipt).sort(),
      );

      await Promise.all([dispatcherTeam.waitClosed(), leaderTeam.waitClosed()]);
    } finally {
      // Reverse-boot order: each `cleanup()` restores `DREAMUX_ROOT` to
      // whatever it was immediately before that harness's `bootDissolveTeam()`
      // ran, so unwinding FIFO would leave the env pointed at `leaderTeam`'s
      // already-deleted temp dir after `dispatcherTeam.cleanup()` restores it.
      await leaderTeam.cleanup();
      await dispatcherTeam.cleanup();
    }
  });

  it('a self-dissolve returns its receipt before Core stops the calling TeamLeader runtime', async () => {
    const team = await bootDissolveTeam();
    try {
      const leader = team.leader();
      expect(leader).not.toBeNull();
      const stopSpy = vi.spyOn(leader!, 'stopForHost');

      const receipt = await team.service.dissolve({
        requester: 'team_leader',
        force: true,
        note: 'self dissolve',
      });

      expect(receipt).toEqual({
        accepted: true,
        team_name: team.teamId,
        status: 'submitted',
      });
      // Synchronously after the receipt: the whole stop-and-close sequence is
      // scheduled behind it, not started by it.
      expect(stopSpy).not.toHaveBeenCalled();

      await team.waitClosed();
      expect(stopSpy).toHaveBeenCalled();
    } finally {
      await team.cleanup();
    }
  });

  it('a forced dispatcher dissolve returns before the worktree is ever assessed', async () => {
    const team = await bootDissolveTeam();
    try {
      const assessCalls: number[] = [];
      team.setAssessment(async () => {
        assessCalls.push(Date.now());
        return { status: 'eligible' };
      });

      const receipt = await team.service.dissolve({
        requester: 'dispatcher',
        force: true,
        note: 'dispatcher dissolve',
      });

      expect(receipt.status).toBe('submitted');
      expect(assessCalls).toHaveLength(0);

      await team.waitClosed();
      expect(assessCalls.length).toBeGreaterThan(0);
    } finally {
      await team.cleanup();
    }
  });

  it.each(['dispatcher', 'team_leader'] as const)(
    'a blocked non-forced %s dissolve rejects before admission and leaves the Team open',
    async (requester) => {
      const team = await bootDissolveTeam();
      try {
        team.setAssessment(async () =>
          blockedAssessment('dirty', fakeTeamRecord().worktree),
        );

        await expect(team.service.dissolve({
          requester,
          force: false,
          note: 'blocked dissolve',
        })).rejects.toThrow(/dirty/u);

        expect(team.service.view().status).toBe('running');
        await expect(team.service.admit(async () => 'open')).resolves.toBe('open');
      } finally {
        await team.cleanup();
      }
    },
  );
});

describe('OPERATION AS FENCE', () => {
  it('two concurrent non-forced submissions assess freely but dismantle the Team once', async () => {
    const team = await bootDissolveTeam();
    try {
      const closingRef = (team.service as unknown as { closing: TeamClosing }).closing;
      const dissolveSpy = vi.spyOn(closingRef, 'dissolve');

      const receipts = await Promise.all([
        team.service.dissolve({ requester: 'dispatcher', force: false, note: 'x' }),
        team.service.dissolve({ requester: 'dispatcher', force: false, note: 'x' }),
      ]);

      expect(receipts).toEqual([
        { accepted: true, team_name: team.teamId, status: 'submitted' },
        { accepted: true, team_name: team.teamId, status: 'submitted' },
      ]);
      await team.waitClosed();
      expect(dissolveSpy).toHaveBeenCalledTimes(1);
    } finally {
      await team.cleanup();
    }
  });

  it('a repeated non-forced submission joins before assessing the worktree again', async () => {
    const team = await bootDissolveTeam();
    try {
      const closingRef = (team.service as unknown as { closing: TeamClosing }).closing;
      const assessment = vi.spyOn(closingRef, 'requireReclaimableWorktree')
        .mockResolvedValueOnce()
        .mockRejectedValue(new Error('managed checkout already removed'));

      const first = await team.service.dissolve({
        requester: 'dispatcher',
        force: false,
        note: 'first',
      });
      const repeated = await team.service.dissolve({
        requester: 'dispatcher',
        force: false,
        note: 'repeat',
      });

      expect(repeated).toEqual(first);
      expect(assessment).toHaveBeenCalledTimes(1);
      await team.waitClosed();
    } finally {
      await team.cleanup();
    }
  });

  it('a repeated submission never re-triggers the underlying close', async () => {
    const team = await bootDissolveTeam();
    try {
      const closingRef = (team.service as unknown as { closing: TeamClosing }).closing;
      const dissolveSpy = vi.spyOn(closingRef, 'dissolve');

      const receipts = await Promise.all([
        team.service.dissolve({ requester: 'dispatcher', force: true, note: 'x' }),
        team.service.dissolve({ requester: 'dispatcher', force: true, note: 'x' }),
        team.service.dissolve({ requester: 'dispatcher', force: true, note: 'x' }),
      ]);

      for (const receipt of receipts) {
        expect(receipt).toEqual({
          accepted: true,
          team_name: team.teamId,
          status: 'submitted',
        });
      }

      await team.waitClosed();

      // Whether a repeat shares the promise or reports "already submitted" is
      // an implementation detail; what must hold is the observable: the
      // destructive close ran exactly once.
      expect(dissolveSpy).toHaveBeenCalledTimes(1);
    } finally {
      await team.cleanup();
    }
  });
});

describe('FORCE WORKTREE SEMANTICS', () => {
  it('force discards dirty/untracked work in the managed worktree, but the branch and its history survive in the source repo', async () => {
    const dispatcherWorkspace = await makeTempDir('dreamux-force-dispatcher-');
    const sourceRepo = await makeTempDir('dreamux-force-source-');
    tempDirs.push(dispatcherWorkspace, sourceRepo);
    await initGitRepo(sourceRepo);

    const manager = newWorktreeManager();
    const prepared = await manager.prepare({
      dispatcherId: 'd1',
      teammateName: 'alpha',
      cwd: sourceRepo,
      dispatcherWorkspace,
      request: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    // Dirty the managed checkout: uncommitted, untracked work.
    await writeFile(`${prepared.runtimeCwd}/untracked.txt`, 'dirty\n');

    const cleaned = await manager.cleanup(
      {
        source_cwd: prepared.sourceCwd,
        source_repo: prepared.sourceRepo,
        worktree: prepared.worktree,
      },
      { force: true },
    );

    expect(cleaned.cleanup_state).toBe('deleted');
    await expect(access(prepared.runtimeCwd)).rejects.toThrow();

    // Never deletes the branch or its commits.
    const branch = prepared.worktree.branch as string;
    const rev = await git(sourceRepo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    expect(rev.trim()).not.toBe('');
    const log = await git(sourceRepo, ['log', branch, '--oneline']);
    expect(log).toContain('initial');
  });

  it('force refuses a worktree identity whose path is not actually registered to the source repo', async () => {
    const sourceRepo = await makeTempDir('dreamux-force-source-');
    const unrelatedRepo = await makeTempDir('dreamux-force-unrelated-');
    tempDirs.push(sourceRepo, unrelatedRepo);
    await initGitRepo(sourceRepo);
    await initGitRepo(unrelatedRepo);

    const manager = newWorktreeManager();
    const cleaned = await manager.cleanup(
      {
        source_cwd: sourceRepo,
        source_repo: sourceRepo,
        worktree: {
          mode: 'managed',
          slug: 'x',
          path: unrelatedRepo,
          branch: 'whatever',
          base_ref: 'HEAD',
          cleanup: 'delete-on-close',
          cleanup_state: 'managed-active',
          cleanup_error: null,
        } as never,
      },
      { force: true },
    );

    expect(cleaned.cleanup_state).toBe('retained-error');
    expect(cleaned.cleanup_error).toMatch(/not a registered worktree/);
    // Nothing was deleted: the unrelated repository, and its history, survive.
    await expect(access(unrelatedRepo)).resolves.toBeUndefined();
    const log = await git(unrelatedRepo, ['log', '--oneline']);
    expect(log).toContain('initial');
  });

  it('force never removes the source repository itself, even when the worktree identity names it as the path', async () => {
    const sourceRepo = await makeTempDir('dreamux-force-source-');
    tempDirs.push(sourceRepo);
    await initGitRepo(sourceRepo);

    const manager = newWorktreeManager();
    const cleaned = await manager.cleanup(
      {
        source_cwd: sourceRepo,
        source_repo: sourceRepo,
        worktree: {
          mode: 'managed',
          slug: 'y',
          path: sourceRepo,
          branch: 'irrelevant',
          base_ref: 'HEAD',
          cleanup: 'delete-on-close',
          cleanup_state: 'managed-active',
          cleanup_error: null,
        } as never,
      },
      { force: true },
    );

    expect(cleaned.cleanup_state).toBe('retained-error');
    expect(cleaned.cleanup_error).toMatch(/refusing to remove the source repository/);
    await expect(access(sourceRepo)).resolves.toBeUndefined();
    const log = await git(sourceRepo, ['log', '--oneline']);
    expect(log).toContain('initial');
  });

  it('force never touches a reused cwd — cleanup is a no-op regardless of force', async () => {
    const reusedDir = await makeTempDir('dreamux-force-reused-');
    tempDirs.push(reusedDir);
    // Not even a git repository: a reuse-cwd worktree owns no managed checkout,
    // so nothing here is ever assessed by git.
    await mkdir(`${reusedDir}/child`, { recursive: true });

    const manager = newWorktreeManager();
    const worktree = {
      mode: 'reuse-cwd',
      slug: null,
      path: reusedDir,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    } as never;

    const cleaned = await manager.cleanup(
      { source_cwd: reusedDir, source_repo: null, worktree },
      { force: true },
    );

    expect(cleaned).toEqual(worktree);
    await expect(access(reusedDir)).resolves.toBeUndefined();
    await expect(access(`${reusedDir}/child`)).resolves.toBeUndefined();
  });
});

describe('DURABLE-FACT RECOVERY: the cron store deletion is not rolled back by a failed final commit', () => {
  it('a job created before dissolve stays gone from disk and from the live scheduler even when the final record write fails', async () => {
    const team = await bootDissolveTeam();
    try {
      await team.service.scheduler.create({
        cron: '0 0 * * *',
        prompt: 'daily standup',
      });
      expect((await team.service.scheduler.list()).jobs).toHaveLength(1);

      // The commit that would durably say `closed` fails; everything the
      // close already did to get there is not this failure's to undo.
      team.setCommitFails(true);
      team.service.dissolve({ requester: 'dispatcher', force: true, note: 'x' });
      await team.waitDissolveFailed();

      // The Team's own lifecycle fact says it is still open — the one thing
      // this failure actually left true.
      expect(team.service.view().status).not.toBe('closed');

      // The cron store file itself is gone from disk: `deleteStoreFile` ran
      // and committed before the failed final write, and nothing restored it.
      await expect(access(join(team.teamRoot, 'cron-jobs.json'))).rejects.toThrow();

      // Ordinary access to the still-open Team's scheduler sees the durable
      // fact directly: no job is re-armed, because there is no store left to
      // read one from.
      expect((await team.service.scheduler.list()).jobs).toHaveLength(0);

      // The failure lowered the fence: this is not a stuck Team. The next
      // ordinary dissolve retries the same, now-idempotent close (the cron
      // store is already gone; deleting it again is a no-op unlink) and
      // actually converges to closed this time.
      team.setCommitFails(false);
      const retryReceipt = await team.service.dissolve({
        requester: 'dispatcher',
        force: true,
        note: 'retry',
      });
      expect(retryReceipt).toEqual({
        accepted: true,
        team_name: team.teamId,
        status: 'submitted',
      });
      await team.waitClosed();
      expect(team.service.view().status).toBe('closed');
    } finally {
      await team.cleanup();
    }
  });
});

describe('TeamWorktreeCleanup.settle: the pending fact is the whole restart-recovery authority', () => {
  function fakeStore(overrides: {
    record: TeamRecord | null;
    update?: (record: TeamRecord, patch: Record<string, unknown>) => Promise<TeamRecord>;
  }): TeamStore {
    return {
      get: async () => overrides.record,
      update:
        overrides.update ??
        (async (record: TeamRecord, patch: Record<string, unknown>) => ({
          ...record,
          ...patch,
        })),
    } as unknown as TeamStore;
  }

  it('does nothing when the record has no pending cleanup — no worktree call, no write', async () => {
    const record = fakeTeamRecord({
      worktree: { mode: 'managed', path: '/repo', cleanup_state: 'deleted' } as never,
    });
    const cleanupCall = vi.fn();
    const updateCall = vi.fn();
    const cleanup = new TeamWorktreeCleanup({
      store: fakeStore({
        record,
        update: async (r, p) => {
          updateCall(p);
          return { ...r, ...p } as TeamRecord;
        },
      }),
      worktrees: { cleanup: cleanupCall } as unknown as WorktreeManager,
    });

    await cleanup.settle('alpha');

    expect(cleanupCall).not.toHaveBeenCalled();
    expect(updateCall).not.toHaveBeenCalled();
  });

  it('reclaims a pending worktree with the force authorization the pending record carries, then clears it', async () => {
    const record = fakeTeamRecord({
      worktree: { mode: 'managed', path: '/repo', cleanup_state: 'cleanup-pending' } as never,
      worktree_cleanup_force: true,
    } as never);
    const cleanupCall = vi.fn(async () => ({
      mode: 'managed',
      path: '/repo',
      cleanup_state: 'deleted',
      cleanup_error: null,
    }));
    const updateCall = vi.fn();
    const cleanup = new TeamWorktreeCleanup({
      store: fakeStore({
        record,
        update: async (r, p) => {
          updateCall(p);
          return { ...r, ...p } as TeamRecord;
        },
      }),
      worktrees: { cleanup: cleanupCall } as unknown as WorktreeManager,
    });

    await cleanup.settle('alpha');

    // The authorization travels with the pending work it authorized: the
    // record's own `worktree_cleanup_force`, not a fresh caller decision.
    expect(cleanupCall).toHaveBeenCalledWith(
      { source_cwd: record.repo_cwd, source_repo: record.source_repo, worktree: record.worktree },
      { force: true },
    );
    // And it is cleared once spent, so a later ordinary reclaim of the same
    // Team does not silently inherit an old force authorization.
    expect(updateCall).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupForce: false }),
    );
  });

  it('throws without writing a second fact when the reclaim itself fails, leaving the pending record standing for the next start', async () => {
    const record = fakeTeamRecord({
      worktree: { mode: 'managed', path: '/repo', cleanup_state: 'cleanup-pending' } as never,
    });
    const updateCall = vi.fn();
    const cleanup = new TeamWorktreeCleanup({
      store: fakeStore({
        record,
        update: async (r, p) => {
          updateCall(p);
          return { ...r, ...p } as TeamRecord;
        },
      }),
      worktrees: {
        cleanup: async () => ({
          mode: 'managed',
          path: '/repo',
          cleanup_state: 'retained-error',
          cleanup_error: 'worktree is dirty',
        }),
      } as unknown as WorktreeManager,
    });

    await expect(cleanup.settle('alpha')).rejects.toThrow('worktree is dirty');

    // No second, defensive fact was written over the pending one: the same
    // `cleanup-pending` record is exactly what the next start (or the next
    // dissolve retry) will find and act on again.
    expect(updateCall).not.toHaveBeenCalled();
  });
});
