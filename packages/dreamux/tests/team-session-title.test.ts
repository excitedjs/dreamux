import * as fs from 'node:fs/promises';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';

// Pause real atomic writes to exercise the Team record's actual queue.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await dispatcherFixture();
  const created = await f.teams.createFromRequest(
    teamRequest('title-team', 'Start review'),
  );
  const team = await f.teams.open(created.team_name);
  const runtime = f.provider.runtimes[0]!;
  const root = join(f.teamRoot, created.team_name);
  return { ...f, created, team, runtime, root };
}

const title = (value: string) => ({
  kind: 'session.title.changed' as const,
  title: value,
});

describe('Team intent follows its own leader session title', () => {
  it('persists only the owning leader title, preserves identities, and projects the latest intent in list', async () => {
    const f = await fixture();
    await f.host.start();
    const other = await f.teams.createFromRequest(
      teamRequest('other-team', 'Other work'),
    );
    const otherRuntime = f.provider.runtimes.at(-1)!;
    const member = await f.team.teammates.spawn({
      name: 'member',
      intent: 'Member work',
      prompt: 'go',
    });
    const memberRuntime = f.provider.runtimes.at(-1)!;
    await f.host.dispatcherAgent
      .mustAgent()
      .submitInput({ source: 'task', text: 'Dispatcher work' });
    const dispatcherRuntime = f.provider.runtimes.at(-1)!;

    const leaderPath = join(f.root, 'identity.json');
    const memberPath = join(
      f.root,
      'teammate',
      member.teammate.name,
      'identity.json',
    );
    const leaderIdentity = await readFile(leaderPath, 'utf8');
    const memberIdentity = await readFile(memberPath, 'utf8');
    memberRuntime.context.events(title('Member title'));
    dispatcherRuntime.context.events(title('Dispatcher title'));
    expect((await f.teams.summary(f.created.team_name)).intent).toBe(
      'Review the implementation',
    );
    expect(await readFile(memberPath, 'utf8')).toBe(memberIdentity);

    otherRuntime.context.events(title('Another Team topic'));
    f.runtime.context.events(title('Release readiness'));
    f.runtime.context.events(title('Ship the release'));
    await vi.waitFor(async () => {
      expect(
        JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
      ).toBe('Ship the release');
    });
    expect(await readFile(leaderPath, 'utf8')).toBe(leaderIdentity);
    expect(await f.teams.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_name: f.created.team_name,
          intent: 'Ship the release',
        }),
        expect.objectContaining({
          team_name: other.team_name,
          intent: 'Another Team topic',
        }),
      ]),
    );
  });

  it.each([false, true])(
    'recovers the persisted topic and consumes later titles (missing identity: %s)',
    async (missingIdentity) => {
      const f = await fixture();
      await f.runtime.context.state.publish({
        kind: 'session',
        sessionId: 'session-before-restart',
      });
      f.runtime.context.events(title('Persisted topic'));
      await f.host.close();
      const identityPath = join(f.root, 'identity.json');
      if (missingIdentity) await rm(identityPath);

      const restored = f.build();
      expect((await restored.teams.list())[0]?.intent).toBe('Persisted topic');
      const team = await restored.teams.open(f.created.team_name);
      expect(JSON.parse(await readFile(identityPath, 'utf8')).intent).toBe(
        missingIdentity ? 'Persisted topic' : 'Review the implementation',
      );
      await team.submitInput({ source: 'task', text: 'Continue review' });
      const runtime = f.provider.runtimes.at(-1)!;
      expect(runtime.context.identity.sessionId).toBe(
        missingIdentity ? null : 'session-before-restart',
      );
      runtime.context.events(title('Recovered leader topic'));
      await vi.waitFor(async () => {
        expect((await restored.teams.list())[0]?.intent).toBe(
          'Recovered leader topic',
        );
      });
      expect(
        JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
      ).toBe('Recovered leader topic');
      expect(() =>
        f.runtime.context.events(title('Old runtime topic')),
      ).not.toThrow();
      expect((await restored.teams.list())[0]?.intent).toBe(
        'Recovered leader topic',
      );
    },
  );

  it('commits received titles in FIFO order across revocation and drops late old events', async () => {
    const f = await fixture();
    const path = join(f.root, 'record.json');
    const entered = deferred<void>();
    const release = deferred<void>();
    f.releases.push(() => release.resolve());
    const { rename } =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const committed: string[] = [];
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === path && committed.length === 0) {
        entered.resolve();
        await release.promise;
      }
      await rename(from, to);
      if (to === path)
        committed.push(JSON.parse(await readFile(path, 'utf8')).intent);
    });
    expect(
      f.runtime.context.events(title('Write already started')),
    ).toBeUndefined();
    await entered.promise;
    expect(JSON.parse(await readFile(path, 'utf8')).intent).toBe(
      'Review the implementation',
    );
    f.runtime.context.events(title('Accepted before revocation'));

    const stopping = f.team.stopForHost();
    await vi.waitFor(async () => {
      expect(
        (
          await f.team.submitInput({
            source: 'task',
            text: 'A new runtime generation',
          })
        ).status,
      ).toBe('submitted');
      expect(f.provider.runtimes.at(-1)).not.toBe(f.runtime);
    });
    const current = f.provider.runtimes.at(-1)!;
    expect(current).not.toBe(f.runtime);
    current.context.events(title('Current generation topic'));
    f.runtime.context.events(title('Late old generation topic'));
    release.resolve();
    await stopping;
    await vi.waitFor(async () => {
      expect((await f.teams.list())[0]?.intent).toBe(
        'Current generation topic',
      );
    });
    expect(committed).toEqual([
      'Write already started',
      'Accepted before revocation',
      'Current generation topic',
    ]);
    expect(JSON.parse(await readFile(path, 'utf8')).intent).toBe(
      'Current generation topic',
    );
  });

  it('logs a denied atomic rename, preserves the committed record and runtime, and accepts the next write', async () => {
    const f = await fixture();
    const path = join(f.root, 'record.json');
    const before = await readFile(path, 'utf8');
    const logged = vi.spyOn(f.log, 'error');
    const stop = vi.spyOn(f.runtime.runtime, 'stop');
    const failure = Object.assign(
      new Error('permission denied renaming Team record'),
      { code: 'EACCES' },
    );
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    expect(() =>
      f.runtime.context.events(title('Unwritable topic')),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          team_id: f.created.team_name,
          error: failure.message,
        }),
        'failed to persist Team intent from session title',
      ),
    );
    expect((await f.teams.list())[0]?.intent).toBe('Review the implementation');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(stop).not.toHaveBeenCalled();
    await f.team.submitInput({
      source: 'task',
      text: 'Work after persistence failure',
    });
    expect(f.provider.runtimes.at(-1)).toBe(f.runtime);
    expect(f.runtime.inputs.at(-1)).toContain('Work after persistence failure');
    f.runtime.context.events(title('Next title succeeds'));
    await vi.waitFor(async () => {
      expect((await f.teams.list())[0]?.intent).toBe('Next title succeeds');
    });
    expect(JSON.parse(await readFile(path, 'utf8')).intent).toBe(
      'Next title succeeds',
    );
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    f.runtime.context.events(title('Failed write at shutdown'));
    await expect(f.host.close()).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toContain('Next title succeeds');
  });

  it('drains accepted record writes even when native stop reports a failure', async () => {
    const f = await dispatcherFixture();
    const failure = new Error('native stop failed');
    f.provider.planNext({ stopFailures: [failure] });
    const created = await f.teams.createFromRequest(
      teamRequest('failed-stop', 'Start work'),
    );
    const team = await f.teams.open(created.team_name);
    const runtime = f.provider.runtimes[0]!;
    runtime.submissions[0]!.complete('Finished before stop');
    const path = join(f.teamRoot, created.team_name, 'record.json');
    const entered = deferred<void>();
    const release = deferred<void>();
    f.releases.push(() => release.resolve());
    const { rename } =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      entered.resolve();
      await release.promise;
      return rename(from, to);
    });
    runtime.context.events(title('Accepted before failed stop'));
    await entered.promise;
    let stopped = false;
    const stopping = team.stopForHost().then(
      () => {
        stopped = true;
        return null;
      },
      (error: unknown) => {
        stopped = true;
        return error;
      },
    );
    await runtime.stopStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release.resolve();
    expect(await stopping).toBe(failure);
    expect(JSON.parse(await readFile(path, 'utf8')).intent).toBe(
      'Accepted before failed stop',
    );
  });

  it('contains a throwing Agent observer without throwing into the provider', async () => {
    const f = await fixture();
    await f.host.start();
    const agent = f.host.dispatcherAgent.mustAgent();
    await agent.submitInput({ source: 'task', text: 'Start dispatcher' });
    const runtime = f.provider.runtimes.at(-1)!;
    const observed = new Error('observer failed');
    const logged = vi.spyOn(f.log, 'error');
    agent.events.once('session.title.changed', () => {
      throw observed;
    });
    expect(() => runtime.context.events(title('Observed title'))).not.toThrow();
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session.title.changed',
        error: observed.message,
      }),
      'Agent Runtime event observer failed',
    );
    await agent.submitInput({ source: 'task', text: 'Still usable' });
    expect(f.provider.runtimes.at(-1)).toBe(runtime);
  });
});
