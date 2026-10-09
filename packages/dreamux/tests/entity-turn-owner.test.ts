import { expect, it, vi } from 'vitest';
import type { RuntimeAdmission } from '@excitedjs/dreamux-types';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';
it('retains a late-attached Turn during actual Agent close until settlement, without reporting it', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  const ready = await f.host.submitToAgent({
    source: 'channel',
    text: 'fixture-ready',
  });
  if (ready.status !== 'submitted') throw new Error('fixture not submitted');
  f.provider.runtimes[0]!.submissions[0]!.complete(null);
  await ready.turn.settled;
  const pending = deferred<RuntimeAdmission>();
  const turn = controllableRuntimeSubmission();
  f.releases.push(() => {
    pending.resolve({ status: 'submitted', submission: turn.submission });
    turn.stop();
  });
  f.provider.planNext({ delayedAdmission: pending.promise });
  const spawn = f.host.teammates.spawn({
    name: 'late-turn',
    intent: 'Test late admission',
    prompt: 'Wait for result',
    agentRuntime: 'controlled',
  });
  await vi.waitFor(() => expect(f.provider.runtimes).toHaveLength(2));
  await f.provider.runtimes[1]!.submitStarted.promise;
  const [member] = await f.host.teammates.list();
  if (!member) throw new Error('missing member');
  const rejected = expect(
    f.host.teammates.close({ name: member.name, note: 'Owner ended task' }),
  ).rejects.toThrow(/1 unsettled submission/);
  await f.provider.runtimes[1]!.stopStarted.promise;
  pending.resolve({ status: 'submitted', submission: turn.submission });
  expect(await spawn).toMatchObject({ status: 'submitted' });
  await rejected;
  expect(f.host.fence.isClosing()).toBe(false);
  turn.complete('late result');
  await expect(
    f.host.teammates.close({ name: member.name, note: 'Finish convergence' }),
  ).resolves.toMatchObject({ teammate: { status: 'closed' } });
  expect(f.provider.runtimes[0]!.inputs).toEqual([
    '<channel>fixture-ready</channel>',
  ]);
});
