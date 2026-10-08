import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';

type Fixture = Awaited<ReturnType<typeof dispatcherFixture>>;
const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await execFileAsync('git', args, { cwd })).stdout;
}
async function managedTeam(fixture: Fixture, prompt?: string) {
  const repo = join(fixture.host.cwd, 'source-repo');
  await mkdir(repo);
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'tracked.txt'), 'initial\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-q', '-m', 'initial']);
  const request = teamRequest('managed-dissolve', prompt);
  const command = {
    ...request.command,
    repo: {
      mode: 'managed' as const,
      path: repo,
      cleanup: 'delete-on-close' as const,
    },
  };
  const created = await fixture.teams.createFromRequest({
    ...request,
    command,
    payloadHash: teamCreatePayloadHash(command),
  });
  return {
    created,
    repo,
    service: await fixture.teams.open(created.team_name),
  };
}
async function diskRecord(fixture: Fixture, name: string) {
  return JSON.parse(
    await readFile(join(fixture.teamRoot, name, 'record.json'), 'utf8'),
  ) as {
    status: string;
    worktree: { cleanup_state: string };
    worktree_cleanup_force: boolean;
  };
}

describe('Team dissolve through actual owners and Git worktrees', () => {
  it('Team members borrow the managed checkout as reuse-cwd keep and cannot reclaim it on member close', async () => {
    const fixture = await dispatcherFixture();
    const { created, service } = await managedTeam(fixture);
    const spawned = await service.teammates.spawn({
      name: 'borrower',
      agentRuntime: 'controlled',
      prompt: 'Work',
      intent: 'Work',
    });
    const path = join(
      fixture.teamRoot,
      created.team_name,
      'teammate',
      spawned.teammate.name,
      'identity.json',
    );
    const identity = JSON.parse(await readFile(path, 'utf8')) as {
      worktree: Record<string, unknown>;
    };
    expect(identity.worktree).toEqual({
      mode: 'reuse-cwd',
      slug: null,
      path: created.runtime_cwd,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    });
    await service.teammates.close({
      name: spawned.teammate.name,
      note: 'Member finished',
    });
    expect(await access(created.runtime_cwd)).toBeUndefined();
    expect(
      await readFile(join(created.runtime_cwd, 'tracked.txt'), 'utf8'),
    ).toBe('initial\n');
  });

  it('dispatcher-scoped TeamMates own and reclaim their separately managed checkout', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const { created, repo } = await managedTeam(fixture);
    const spawned = await fixture.host.teammates.spawn({
      name: 'standalone',
      agentRuntime: 'controlled',
      prompt: 'Work',
      intent: 'Work',
      cwd: repo,
      worktree: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    expect(spawned.teammate.repo.mode).toBe('managed');
    expect(spawned.teammate.repo.cleanup).toBe('delete-on-close');
    expect(spawned.teammate.repo.path).not.toBe(created.runtime_cwd);
    await fixture.host.teammates.close({
      name: spawned.teammate.name,
      note: 'Finished',
    });
    await expect(access(spawned.teammate.repo.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await access(created.runtime_cwd)).toBeUndefined();
  });

  it('forced dissolve returns acceptance while its worktree assessment is still pending', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(
      teamRequest('assessment-receipt'),
    );
    const service = await fixture.teams.open(created.team_name);
    const assessment = deferred<void>();
    fixture.releases.push(() => assessment.resolve());
    const original = WorktreeManager.prototype.assessCleanup;
    const spy = vi
      .spyOn(WorktreeManager.prototype, 'assessCleanup')
      .mockImplementation(async function (this: WorktreeManager, identity) {
        await assessment.promise;
        return original.call(this, identity);
      });
    try {
      expect(
        await service.dissolve({
          note: 'Asynchronous assessment',
          force: true,
        }),
      ).toEqual({
        accepted: true,
        team_name: created.team_name,
        status: 'submitted',
      });
      expect((await diskRecord(fixture, created.team_name)).status).toBe(
        'running',
      );
      assessment.resolve();
      await service.closed;
    } finally {
      assessment.resolve();
      spy.mockRestore();
    }
  });

  it('concurrent and repeated non-forced dissolve requests dismantle the same Team once', async () => {
    const fixture = await dispatcherFixture();
    const stopping = deferred<void>();
    fixture.releases.push(() => stopping.resolve());
    fixture.provider.planNext({ stopBarrier: stopping.promise });
    const { created, service } = await managedTeam(fixture, 'Start');
    const stop = vi.spyOn(fixture.provider.runtimes[0]!.runtime, 'stop');
    const assessment = vi.spyOn(WorktreeManager.prototype, 'assessCleanup');
    try {
      const input = { note: 'Concurrent finish', force: false };
      const [first, second] = await Promise.all([
        service.dissolve(input),
        service.dissolve(input),
      ]);
      expect(second).toEqual(first);
      await fixture.provider.runtimes[0]!.stopStarted.promise;
      const beforeRepeat = assessment.mock.calls.length;
      expect(await service.dissolve(input)).toEqual(first);
      expect(assessment).toHaveBeenCalledTimes(beforeRepeat);
      expect(stop).toHaveBeenCalledTimes(1);
      stopping.resolve();
      await service.closed;
      await vi.waitFor(async () =>
        expect(
          (await diskRecord(fixture, created.team_name)).worktree.cleanup_state,
        ).toBe('deleted'),
      );
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stopping.resolve();
      assessment.mockRestore();
    }
  });
});
