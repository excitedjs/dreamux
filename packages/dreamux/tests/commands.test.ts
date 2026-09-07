import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { DreamuxConfig } from '../src/config/config.js';
import { ExecaCommandRunner } from '../src/onboard/commands.js';
import { dreamuxBinPath } from '../src/platform/package-bin.js';
import { getRuntimeConfig, setRuntimeConfig } from '../src/platform/paths.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { Server } from '../src/server.js';
import { adminContext, createCommandHarness } from './helpers/command-harness.js';
import { createFakeChannelProvider } from './helpers/fake-channel-provider.js';

describe('channel.list', () => {
  it('returns every configured Channel in order, including one without an identity', async () => {
    const channels = [
      { channel_id: 'primary', provider: 'npm:@example/primary', identity: '', live: true },
      {
        channel_id: 'secondary',
        provider: 'npm:@example/secondary',
        identity: 'secondary-identity',
        live: false,
      },
    ];
    const harness = createCommandHarness({
      dispatcherOverrides: { listChannels: () => channels },
    });

    await expect(
      harness.port.invoke(adminContext('harness-d1'), 'channel.list', {}),
    ).resolves.toEqual({ channels });
    expect(harness.dispatcherLookups).toEqual(['harness-d1']);
  });

  it('rejects a missing dispatcher_id before looking up an aggregate', async () => {
    const harness = createCommandHarness();

    await expect(
      harness.port.invoke(adminContext(), 'channel.list', {}),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('dispatcher_id') });
    expect(harness.dispatcherLookups).toEqual([]);
  });

  it('rejects an unknown Dispatcher before looking up an aggregate', async () => {
    const harness = createCommandHarness();

    await expect(
      harness.port.invoke(adminContext('unknown-dispatcher'), 'channel.list', {}),
    ).rejects.toMatchObject({ code: 'DISPATCHER_NOT_FOUND' });
    expect(harness.dispatcherLookups).toEqual([]);
  });

  it('reads a stopped Dispatcher through the real Server host without starting sessions', async () => {
    const { server, fake, runtimes, close } = await createChannelListServer();
    const resolveRuntime = vi.spyOn(runtimes, 'resolve');

    try {
      await server.start();
      const context = adminContext('stopped');
      const statusBefore = await server.commands.invoke(context, 'dispatcher.status', {});
      const listBefore = await server.commands.invoke(adminContext(), 'dispatcher.list', {});

      await expect(server.commands.invoke(context, 'channel.list', {})).resolves.toEqual({
        channels: [
          { channel_id: 'primary', provider: 'npm:@example/primary', identity: '', live: false },
          {
            channel_id: 'secondary',
            provider: 'npm:@example/secondary',
            identity: 'secondary-identity',
            live: false,
          },
        ],
      });

      expect(fake.sessions.size).toBe(0);
      expect(resolveRuntime).not.toHaveBeenCalled();
      expect(server.getDispatcher('stopped').runtimeStatus().sessionId).toBeNull();
      expect(statusBefore).toMatchObject({ channel_identity: '', status: 'stopped', session_id: null });
      await expect(server.commands.invoke(context, 'dispatcher.status', {})).resolves.toEqual(statusBefore);
      await expect(server.commands.invoke(adminContext(), 'dispatcher.list', {})).resolves.toEqual(listBefore);
    } finally {
      try {
        await close();
      } finally {
        resolveRuntime.mockRestore();
      }
    }
  });

  it('reports live Channels built and adopted by the real Dispatcher start path', async () => {
    const { server, fake, close } = await createChannelListServer();
    try {
      await server.start();
      const dispatcher = server.getDispatcher('stopped');
      // start() builds, starts, and adopt()s the real ChannelService map.
      await dispatcher.start();
      expect(fake.sessions.size).toBe(2);
      expect([...fake.sessions.values()].every((session) => session.startCalled)).toBe(true);

      const context = adminContext('stopped');
      await expect(server.commands.invoke(context, 'channel.list', {})).resolves.toEqual({
        channels: [
          { channel_id: 'primary', provider: 'npm:@example/primary', identity: '', live: true },
          {
            channel_id: 'secondary',
            provider: 'npm:@example/secondary',
            identity: 'secondary-identity',
            live: true,
          },
        ],
      });

      await dispatcher.stop();
      await expect(server.commands.invoke(context, 'channel.list', {})).resolves.toMatchObject({
        channels: [
          { channel_id: 'primary', live: false },
          { channel_id: 'secondary', live: false },
        ],
      });
    } finally {
      await close();
    }
  });

  it('dreamux channel list --id reaches the real Server through the public bin', async () => {
    const { server, root, fake, close } = await createChannelListServer();
    try {
      await server.start();
      const result = await execa(dreamuxBinPath({}), ['channel', 'list', '--id', 'stopped'], {
        env: { DREAMUX_ROOT: root },
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        channels: [
          { channel_id: 'primary', provider: 'npm:@example/primary', identity: '', live: false },
          {
            channel_id: 'secondary',
            provider: 'npm:@example/secondary',
            identity: 'secondary-identity',
            live: false,
          },
        ],
      });
      expect(fake.sessions.size).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('ExecaCommandRunner', () => {
  let previousLeakEnv: string | undefined;

  beforeEach(() => {
    previousLeakEnv = process.env['DREAMUX_TEST_LEAK'];
  });

  afterEach(() => {
    if (previousLeakEnv === undefined) {
      delete process.env['DREAMUX_TEST_LEAK'];
    } else {
      process.env['DREAMUX_TEST_LEAK'] = previousLeakEnv;
    }
  });

  it('does not inherit ambient environment when explicit env is passed', async () => {
    process.env['DREAMUX_TEST_LEAK'] = 'present';
    const runner = new ExecaCommandRunner();

    await expect(
      runner.check(
        process.execPath,
        [
          '-e',
          'process.exit(process.env.DREAMUX_TEST_LEAK === undefined ? 0 : 1)',
        ],
        { env: {} },
      ),
    ).resolves.toBe(true);
  });
});

/** Real Server fixture shared by the inventory and public CLI cases. */
async function createChannelListServer() {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-channel-list-'));
  const previousConfig = getRuntimeConfig();
  const previousRoot = process.env['DREAMUX_ROOT'];
  process.env['DREAMUX_ROOT'] = root;
  const fake = createFakeChannelProvider();
  const registry = new ProviderRegistry();
  const channels = [
    { id: 'primary', provider: 'npm:@example/primary', config: { marker: 'private' } },
    {
      id: 'secondary',
      provider: 'npm:@example/secondary',
      identity: 'secondary-identity',
      config: { marker: 'private' },
      rawConfig: { marker: 'private-raw' },
    },
  ];
  for (const channel of channels) {
    registry.register({ id: channel.provider, kind: 'channel', ref: parseProviderRef(channel.provider) });
    registry.registerImplementation(channel.provider, fake.provider);
  }
  const runtime = { provider: 'npm:@example/runtime', config: {} };
  const config: DreamuxConfig = {
    agents: { example: runtime },
    dispatchers: [{
      id: 'stopped',
      cwd: root,
      enabled: false,
      workspace: { enabled: false },
      channels,
      agentRuntime: 'example',
      runtime,
    }],
  };
  const runtimes = new AgentRuntimeProviderCatalog({ registry });
  const noop = () => {};
  const server = new Server({
    config,
    providerRegistry: registry,
    agentRuntimeProviderCatalog: runtimes,
    channelProviderCatalog: new ChannelProviderCatalog({ registry }),
    adminSocketPath: join(root, 'run', 'admin.sock'),
    logger: { error: noop, warn: noop, info: noop, debug: noop, trace: noop },
  });

  return {
    server,
    root,
    fake,
    runtimes,
    async close() {
      try {
        await server.shutdown();
      } finally {
        setRuntimeConfig(previousConfig);
        if (previousRoot === undefined) delete process.env['DREAMUX_ROOT'];
        else process.env['DREAMUX_ROOT'] = previousRoot;
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
