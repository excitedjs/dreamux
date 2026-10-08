import { afterEach, expect, it, vi } from 'vitest';
import { UnbuiltAgent } from '../src/service/agent/factory.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
afterEach(() => vi.restoreAllMocks());
it('a record that already says closed is the answer, not a failure', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  const spawned = await f.host.teammates.spawn({
    name: 'retired',
    prompt: 'work',
    intent: 'exercise historical close',
  });
  await f.host.teammates.close({
    name: spawned.teammate.name,
    note: 'closed earlier',
  });
  await f.host.close();
  const next = f.build();
  await next.host.start();
  const builds = vi.spyOn(UnbuiltAgent.prototype, 'build');
  const count = f.provider.runtimes.length;
  await expect(
    next.host.teammates.close({ name: spawned.teammate.name, note: 'cleanup' }),
  ).resolves.toMatchObject({
    teammate: {
      name: spawned.teammate.name,
      status: 'closed',
      close_note: 'closed earlier',
    },
  });
  expect(builds).not.toHaveBeenCalled();
  expect(f.provider.runtimes).toHaveLength(count);
});
it('a close that loses the race to a concurrent one still answers, it does not refuse', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  const release = deferred<void>();
  f.releases.push(() => release.resolve());
  f.provider.planNext({ stopBarrier: release.promise });
  const spawned = await f.host.teammates.spawn({
    name: 'racer',
    prompt: 'pending work',
    intent: 'exercise concurrent close',
  });
  const first = f.host.teammates.close({
    name: spawned.teammate.name,
    note: 'first close',
  });
  await f.provider.runtimes[0]!.stopStarted.promise;
  const second = f.host.teammates.close({
    name: spawned.teammate.name,
    note: 'concurrent close',
  });
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a.teammate.status).toBe('closed');
  expect(b.teammate.status).toBe('closed');
  expect(a.teammate.name).toBe(b.teammate.name);
  expect(f.provider.runtimes).toHaveLength(1);
});
it('a name that never existed is still the caller`s to fix', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  await expect(
    f.host.teammates.close({ name: 'ghost', note: 'cleanup' }),
  ).rejects.toMatchObject({ code: 'TEAMMATE_NOT_FOUND' });
  expect(f.provider.runtimes).toHaveLength(0);
});
