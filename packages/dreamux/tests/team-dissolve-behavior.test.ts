import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { createLeaderTeamMcpDelegate } from '../src/service/team/leader-mcp.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';

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
  it.each(['dispatcher', 'team_leader'] as const)(
    'a blocked non-forced %s dissolve rejects before admission and leaves the Team open',
    async (caller) => {
      const fixture = await dispatcherFixture();
      const { created, service } = await managedTeam(fixture, 'Start work');
      const stop = vi.spyOn(fixture.provider.runtimes[0]!.runtime, 'stop');
      const job = await service.scheduler.create({
        cron: '0 0 1 1 *',
        tz: 'UTC',
        prompt: 'Annual review',
      });
      await writeFile(
        join(created.runtime_cwd, 'dirty.txt'),
        'keep this work\n',
      );
      const dissolving =
        caller === 'dispatcher'
          ? fixture.teams.dissolve(created.team_name, {
              note: 'Blocked',
              force: false,
            })
          : createLeaderTeamMcpDelegate(service).call({
              name: 'dissolve',
              arguments: { note: 'Blocked', force: false },
            });
      await expect(dissolving).rejects.toMatchObject({
        code: 'TEAM_DISSOLVE_BLOCKED',
      });
      expect((await diskRecord(fixture, created.team_name)).status).toBe(
        'running',
      );
      expect(
        (await service.scheduler.list()).jobs.map((entry) => entry.id),
      ).toEqual([job.id]);
      expect(stop).not.toHaveBeenCalled();
      expect(
        (
          await fixture.teams.submitToLeader(created.team_name, {
            source: 'task',
            text: 'Still open',
            deliverCompletionToDispatcher: false,
          })
        ).status,
      ).toBe('submitted');
      expect(
        await readFile(join(created.runtime_cwd, 'dirty.txt'), 'utf8'),
      ).toBe('keep this work\n');
    },
  );

  it('writes closed before serial child destruction and retains dirt discovered after that write without reopening', async () => {
    const fixture = await dispatcherFixture();
    const leaderStop = deferred<void>();
    const memberStop = deferred<void>();
    fixture.releases.push(() => {
      leaderStop.resolve();
      memberStop.resolve();
    });
    fixture.provider.planNext({ stopBarrier: leaderStop.promise });
    const { created, service } = await managedTeam(fixture, 'Start work');
    fixture.provider.planNext({ stopBarrier: memberStop.promise });
    await service.teammates.spawn({
      name: 'member',
      agentRuntime: 'controlled',
      prompt: 'Work',
      intent: 'Work',
    });
    const order: string[] = [];
    void fixture.provider.runtimes[1]!.stopStarted.promise.then(() => {
      order.push('member');
    });
    void fixture.provider.runtimes[0]!.stopStarted.promise.then(() => {
      order.push('leader');
    });
    expect(
      await fixture.teams.dissolve(created.team_name, {
        note: 'Done',
        force: false,
      }),
    ).toEqual({
      accepted: true,
      team_name: created.team_name,
      status: 'submitted',
    });
    await fixture.provider.runtimes[1]!.stopStarted.promise;
    expect((await diskRecord(fixture, created.team_name)).status).toBe(
      'closed',
    );
    expect(order).toEqual(['member']);
    await writeFile(
      join(created.runtime_cwd, 'late-dirty.txt'),
      'work admitted before dissolve\n',
    );
    memberStop.resolve();
    await fixture.provider.runtimes[0]!.stopStarted.promise;
    expect(order).toEqual(['member', 'leader']);
    leaderStop.resolve();
    await service.closed;
    await vi.waitFor(async () =>
      expect(
        (await diskRecord(fixture, created.team_name)).worktree.cleanup_state,
      ).toBe('retained-dirty'),
    );
    expect(await fixture.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
      worktree_cleanup: 'retained-dirty',
    });
    expect(
      await readFile(join(created.runtime_cwd, 'late-dirty.txt'), 'utf8'),
    ).toBe('work admitted before dissolve\n');
    await expect(fixture.teams.open(created.team_name)).rejects.toMatchObject({
      code: 'TEAM_CLOSED',
    });
  });

  it.each(['dispatcher', 'team_leader'] as const)(
    'forced %s dissolve returns its receipt before runtime stop and discards only the dirty checkout',
    async (caller) => {
      const fixture = await dispatcherFixture();
      const stopping = deferred<void>();
      fixture.releases.push(() => stopping.resolve());
      fixture.provider.planNext({ stopBarrier: stopping.promise });
      const { created, service, repo } = await managedTeam(
        fixture,
        'Start work',
      );
      await writeFile(
        join(created.runtime_cwd, 'dirty.txt'),
        'authorized discard\n',
      );
      const receipt =
        caller === 'dispatcher'
          ? await fixture.teams.dissolve(created.team_name, {
              note: 'Discard checkout',
              force: true,
            })
          : await createLeaderTeamMcpDelegate(service)
              .call({
                name: 'dissolve',
                arguments: { note: 'Discard checkout', force: true },
              })
              .then((result) => {
                if (!result.ok) throw new Error(result.message);
                return result.structured;
              });
      expect(receipt).toEqual({
        accepted: true,
        team_name: created.team_name,
        status: 'submitted',
      });
      await fixture.provider.runtimes[0]!.stopStarted.promise;
      expect(await access(created.runtime_cwd)).toBeUndefined();
      expect((await diskRecord(fixture, created.team_name)).status).toBe(
        'closed',
      );
      stopping.resolve();
      await service.closed;
      await vi.waitFor(async () =>
        expect(
          (await diskRecord(fixture, created.team_name)).worktree.cleanup_state,
        ).toBe('deleted'),
      );
      await expect(access(created.runtime_cwd)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe(
        'initial\n',
      );
      expect(
        (await git(repo, ['branch', '--list', 'dreamux/*'])).trim(),
      ).not.toBe('');
      expect(await git(repo, ['log', '--oneline'])).toContain('initial');
    },
  );

  it('leaves runtime and cron untouched when the closed write fails, then permits an ordinary retry', async () => {
    const fixture = await dispatcherFixture();
    const errors = vi.spyOn(fixture.log, 'error');
    const created = await fixture.teams.createFromRequest(
      teamRequest('write-failure', 'Start'),
    );
    const service = await fixture.teams.open(created.team_name);
    const stop = vi.spyOn(fixture.provider.runtimes[0]!.runtime, 'stop');
    const job = await service.scheduler.create({
      cron: '0 0 1 1 *',
      tz: 'UTC',
      prompt: 'Annual review',
    });
    const path = join(fixture.teamRoot, created.team_name, 'record.json');
    const original = await readFile(path, 'utf8');
    await rm(path);
    await mkdir(path);
    await fixture.teams.dissolve(created.team_name, {
      note: 'Cannot persist yet',
      force: true,
    });
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        expect.anything(),
        'Team dissolve failed to prepare or commit its closed record',
      ),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(await fixture.teams.summary(created.team_name)).toMatchObject({
      status: 'running',
    });
    expect(
      (await service.scheduler.list()).jobs.map((entry) => entry.id),
    ).toEqual([job.id]);
    await rm(path, { recursive: true });
    await writeFile(path, original);
    await fixture.teams.dissolve(created.team_name, {
      note: 'Retry after repair',
      force: true,
    });
    await service.closed;
    expect((await diskRecord(fixture, created.team_name)).status).toBe(
      'closed',
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps cron deleted after physical reclaim succeeds but the final cleanup record write fails', async () => {
    const fixture = await dispatcherFixture();
    const errors = vi.spyOn(fixture.log, 'error');
    const stopping = deferred<void>();
    fixture.releases.push(() => stopping.resolve());
    fixture.provider.planNext({ stopBarrier: stopping.promise });
    const { created, service } = await managedTeam(fixture, 'Start');
    await service.scheduler.create({
      cron: '0 0 1 1 *',
      tz: 'UTC',
      prompt: 'Annual review',
    });
    const root = join(fixture.teamRoot, created.team_name);
    const path = join(root, 'record.json');
    await fixture.teams.dissolve(created.team_name, {
      note: 'Done',
      force: true,
    });
    await fixture.provider.runtimes[0]!.stopStarted.promise;
    expect((await diskRecord(fixture, created.team_name)).status).toBe(
      'closed',
    );
    await expect(access(join(root, 'cron-jobs.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(path);
    await mkdir(path);
    stopping.resolve();
    await service.closed;
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        expect.anything(),
        'Team managed worktree cleanup failed',
      ),
    );
    await expect(access(created.runtime_cwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(join(root, 'cron-jobs.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(service.scheduler.list()).rejects.toMatchObject({
      code: 'TEAM_CLOSED',
    });
  });

  it('keeps the Team closed and stops its leader even when cron destruction fails', async () => {
    const fixture = await dispatcherFixture();
    const errors = vi.spyOn(fixture.log, 'error');
    const created = await fixture.teams.createFromRequest(
      teamRequest('cron-cleanup-failure', 'Start'),
    );
    const service = await fixture.teams.open(created.team_name);
    await service.scheduler.create({
      cron: '0 0 1 1 *',
      tz: 'UTC',
      prompt: 'Annual review',
    });
    const path = join(fixture.teamRoot, created.team_name, 'cron-jobs.json');
    await rm(path);
    await mkdir(path);
    const stop = vi.spyOn(fixture.provider.runtimes[0]!.runtime, 'stop');
    await fixture.teams.dissolve(created.team_name, {
      note: 'Done despite residue',
      force: true,
    });
    await service.closed;
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await diskRecord(fixture, created.team_name)).status).toBe(
      'closed',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.anything(),
      'Team dissolve did not converge',
    );
    await expect(fixture.teams.open(created.team_name)).rejects.toMatchObject({
      code: 'TEAM_CLOSED',
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
  });
});
