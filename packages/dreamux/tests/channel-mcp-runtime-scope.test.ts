import { expect, it, vi } from 'vitest';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { fakeChannelToolRegistration } from './helpers/fake-channel-provider.js';
it('injects Channel MCP only into actual Dispatcher and TeamLeader runtime contexts', async () => {
  const f = await dispatcherFixture({
    channel: true,
    channelOptions: {
      mcp: {
        describe: () => [
          fakeChannelToolRegistration({
            name: 'channel_probe',
            target: 'provider',
          }),
        ],
        providerInvoke: async () => ({ ok: true, value: {} }),
      },
    },
  });
  await f.host.start();
  await f.host.submitToAgent({ source: 'channel', text: 'dispatcher work' });
  const created = await f.teams.createFromRequest(
    teamRequest('scoped-tools', 'leader work'),
  );
  const team = await f.teams.open(created.team_name);
  await team.teammates.spawn({
    name: 'member',
    prompt: 'member work',
    intent: 'member task',
  });
  await f.host.teammates.spawn({
    name: 'standalone',
    prompt: 'standalone work',
    intent: 'standalone task',
  });
  expect(f.provider.runtimes).toHaveLength(4);
  const names = (index: number) =>
    f.provider.runtimes[index]!.context.mcpServers.filter((server) =>
      server.name.startsWith('channel-'),
    ).map((server) => server.name);
  expect(names(0)).toEqual(['channel-fixture-channel']);
  expect(names(1)).toEqual(['channel-fixture-channel']);
  expect(names(2)).toEqual([]);
  expect(names(3)).toEqual([]);
  await f.host.workflows.run({
    script:
      'export const meta = { name: "scope", description: "Check worker tools" }; return await agent("workflow worker");',
  });
  await vi.waitFor(() => expect(f.provider.runtimes).toHaveLength(5));
  expect(names(4)).toEqual([]);
});
