import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExecaCommandRunner } from '../src/onboard/commands.js';
import { adminContext, createCommandHarness } from './helpers/command-harness.js';

/**
 * The 'reads a stopped Dispatcher through the real Server host without
 * starting sessions' and 'reports live Channels built and adopted by the
 * real Dispatcher start path' cases that used to live here, and their shared
 * `createChannelListServer()` fixture, were deleted as Stage 2a Item 6
 * collateral (the fixture built a `DispatcherConfig` with the now-deleted
 * `.runtime` field) — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 6.
 */
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

