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
    await memberRuntime.context.state.publish(title('Member title'));
    await dispatcherRuntime.context.state.publish(title('Dispatcher title'));
    expect((await f.teams.summary(f.created.team_name)).intent).toBe(
      'Review the implementation',
    );
    expect(await readFile(memberPath, 'utf8')).toBe(memberIdentity);

    await otherRuntime.context.state.publish(title('Another Team topic'));
    await f.runtime.context.state.publish(title('Release readiness'));
    await f.runtime.context.state.publish(title('Ship the release'));
    expect(
      JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
    ).toBe('Ship the release');
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
      await f.runtime.context.state.publish(title('Persisted topic'));
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
      await runtime.context.state.publish(title('Recovered leader topic'));
      expect((await restored.teams.list())[0]?.intent).toBe(
        'Recovered leader topic',
      );
      expect(
        JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
      ).toBe('Recovered leader topic');
      expect(() =>
        f.runtime.context.state.publish(title('Old runtime topic')),
      ).toThrow(
        expect.objectContaining({ name: 'AgentRuntimeStateLeaseRevokedError' }),
      );
    },
  );

  it('awaits durability and rejects a title queued before its runtime lease was revoked', async () => {
    const f = await fixture();
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
    let persisted = false;
    const first = f.runtime.context.state
      .publish(title('Write already started'))
      .then(() => {
        persisted = true;
      });
    await entered.promise;
    expect(persisted).toBe(false);
    expect(
      JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
    ).toBe('Review the implementation');
    const queued = f.runtime.context.state.publish(title('Queued stale topic'));
    const outcome = queued.then(
      () => null,
      (error: unknown) => error,
    );

    await f.team.stopForHost();
    await f.team.submitInput({
      source: 'task',
      text: 'A new runtime generation',
    });
    const current = f.provider.runtimes.at(-1)!;
    expect(current).not.toBe(f.runtime);
    const replacement = current.context.state.publish(
      title('Current generation topic'),
    );
    release.resolve();
    await first;
    expect(await outcome).toMatchObject({
      name: 'AgentRuntimeStateLeaseRevokedError',
    });
    await replacement;
    expect(persisted).toBe(true);
    expect((await f.teams.list())[0]?.intent).toBe('Current generation topic');
    expect(
      JSON.parse(await readFile(join(f.root, 'record.json'), 'utf8')).intent,
    ).toBe('Current generation topic');
  });

  it('rejects a real record write failure without changing the committed topic', async () => {
    const f = await fixture();
    const path = join(f.root, 'record.json');
    await rm(path);
    await fs.mkdir(path);
    await expect(
      f.runtime.context.state.publish(title('Unwritable topic')),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect((await f.teams.list())[0]?.intent).toBe('Review the implementation');
  });
});
