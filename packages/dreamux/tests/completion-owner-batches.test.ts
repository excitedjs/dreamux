import { expect, it, vi } from 'vitest';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
async function batch(count: number) {
  const f = await dispatcherFixture();
  await f.host.start();
  const ready = await f.host.submitToAgent({
    source: 'channel',
    text: 'ready',
  });
  if (ready.status !== 'submitted') throw new Error('recipient not active');
  const recipient = f.provider.runtimes[0]!;
  recipient.submissions[0]!.complete(null);
  await ready.turn.settled;
  const children: Array<{
    created: Awaited<ReturnType<typeof f.teams.createFromRequest>>;
    service: Awaited<ReturnType<typeof f.teams.open>>;
    runtime: typeof recipient;
  }> = [];
  for (let index = 0; index < count; index++) {
    const created = await f.teams.createFromRequest({
      ...teamRequest(`batch-${index}`, `work-${index}`),
      deliverCompletionToDispatcher: true,
    });
    children.push({
      created,
      service: await f.teams.open(created.team_name),
      runtime: f.provider.runtimes.at(-1)!,
    });
  }
  const notices = () =>
    recipient.inputs.filter((text) => text.startsWith('<task-notification>'));
  const dissolve = async () => {
    await Promise.all(
      children.map(({ created }) =>
        f.teams.dissolve(created.team_name, { note: 'End batch', force: true }),
      ),
    );
    await Promise.all(children.map(({ service }) => service.closed));
  };
  return { ...f, children, notices, dissolve };
}
it('dissolving a batch of real Teams with unfinished leader turns produces zero completion pushes', async () => {
  const f = await batch(6);
  expect(f.provider.runtimes).toHaveLength(7);
  await f.dissolve();
  expect(f.host.fence.isClosing()).toBe(false);
  expect(f.notices()).toEqual([]);
  expect(await f.teams.list()).toEqual(
    expect.arrayContaining(
      f.children.map(({ created }) =>
        expect.objectContaining({
          team_name: created.team_name,
          status: 'closed',
        }),
      ),
    ),
  );
});
it('keeps results delivered before real Team dissolve and suppresses only unfinished turns', async () => {
  const f = await batch(9);
  for (let index = 0; index < 3; index++)
    f.children[index]!.runtime.submissions[0]!.complete(`answer-${index}`);
  await vi.waitFor(() => expect(f.notices()).toHaveLength(3));
  for (let index = 0; index < 3; index++)
    expect(f.notices()[index]).toContain(`answer-${index}`);
  const before = [...f.notices()];
  await f.dissolve();
  expect(f.host.fence.isClosing()).toBe(false);
  expect(f.notices()).toEqual(before);
});
