import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaCommandRunner } from '../src/platform/command-runner.js';
import {
  adminContext,
  createCommandHarness,
} from './helpers/command-harness.js';
const inventoryChannels = [
  {
    id: 'primary',
    provider: 'builtin:fixture-primary',
    config: { marker: 'private' },
  },
  {
    id: 'secondary',
    provider: 'builtin:fixture-secondary',
    config: { marker: 'private', identity: 'secondary-identity' },
  },
];
function inventory(live: boolean) {
  return [
    {
      channel_id: 'primary',
      provider: 'builtin:fixture-primary',
      identity: '',
      live,
    },
    {
      channel_id: 'secondary',
      provider: 'builtin:fixture-secondary',
      identity: 'secondary-identity',
      live,
    },
  ];
}
describe('channel.list', () => {
  it('returns every configured Channel in order, including one without an identity', async () => {
    const channels = [
      {
        channel_id: 'primary',
        provider: 'npm:@example/primary',
        identity: '',
        live: true,
      },
      {
        channel_id: 'secondary',
        provider: 'npm:@example/secondary',
        identity: 'secondary-identity',
        live: false,
      },
    ];
    const harness = await createCommandHarness({
      dispatcherOverrides: { listChannels: () => channels },
    });

    await expect(
      harness.port.invoke(adminContext('harness-d1'), 'channel.list', {}),
    ).resolves.toEqual({ channels });
    expect(harness.dispatcherLookups).toEqual(['harness-d1']);
  });

  it('rejects a missing dispatcher_id before looking up an aggregate', async () => {
    const harness = await createCommandHarness();

    await expect(
      harness.port.invoke(adminContext(), 'channel.list', {}),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('dispatcher_id'),
    });
    expect(harness.dispatcherLookups).toEqual([]);
  });

  it('rejects an unknown Dispatcher before looking up an aggregate', async () => {
    const harness = await createCommandHarness();

    await expect(
      harness.port.invoke(
        adminContext('unknown-dispatcher'),
        'channel.list',
        {},
      ),
    ).rejects.toMatchObject({ code: 'DISPATCHER_NOT_FOUND' });
    expect(harness.dispatcherLookups).toEqual([]);
  });

  it('reads a stopped Dispatcher through the real Server host without starting sessions', async () => {
    const harness = await createCommandHarness({
      enabled: false,
      channels: inventoryChannels,
    });
    const context = adminContext('harness-d1');
    const statusBefore = await harness.host.commands.invoke(
      context,
      'dispatcher.status',
      {},
    );
    const listBefore = await harness.host.commands.invoke(
      adminContext(),
      'dispatcher.list',
      {},
    );
    await expect(
      harness.host.commands.invoke(context, 'channel.list', {}),
    ).resolves.toEqual({ channels: inventory(false) });
    expect(harness.fake.sessions.size).toBe(0);
    expect(harness.provider.runtimes).toHaveLength(0);
    expect(statusBefore).toMatchObject({
      channel_identity: '',
      status: 'declared',
      session_id: null,
    });
    await expect(
      harness.host.commands.invoke(context, 'dispatcher.status', {}),
    ).resolves.toEqual(statusBefore);
    await expect(
      harness.host.commands.invoke(adminContext(), 'dispatcher.list', {}),
    ).resolves.toEqual(listBefore);
  });

  it('reports live Channels built and adopted by the real Dispatcher start path', async () => {
    const harness = await createCommandHarness({
      enabled: false,
      channels: inventoryChannels,
    });
    await harness.dispatcher.start();
    expect(harness.fake.sessions.size).toBe(2);
    expect(
      [...harness.fake.sessions.values()].every(
        (session) => session.startCalled,
      ),
    ).toBe(true);
    await expect(
      harness.host.commands.invoke(
        adminContext('harness-d1'),
        'channel.list',
        {},
      ),
    ).resolves.toEqual({ channels: inventory(true) });
    await harness.dispatcher.close();
    await expect(
      harness.host.commands.invoke(
        adminContext('harness-d1'),
        'channel.list',
        {},
      ),
    ).resolves.toEqual({ channels: inventory(false) });
    expect(harness.provider.runtimes).toHaveLength(0);
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
