import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { createDaemonCommand } from '../src/cli/commands/daemon.js';
import { createOnboardCommand } from '../src/cli/commands/onboard.js';
import * as serviceInstall from '../src/daemon/install.js';
import * as onboarding from '../src/onboard/run.js';
import * as onboardWizard from '../src/onboard/wizard.js';
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

describe('service installation handoff output', () => {
  it.each([true, false])(
    'reports daemon install completion as unconfirmed only for handoff (%s)',
    async (handedOff) => {
      const install = vi
        .spyOn(serviceInstall, 'runDaemonInstall')
        .mockResolvedValue({
          files: [],
          service: {
            platform: 'windows',
            unitPath: '\\Dreamux-fixture',
            registered: true,
            started: !handedOff,
            handedOff,
            lingerEnabled: null,
            warnings: [],
          },
        });
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await yargs()
          .exitProcess(false)
          .command(createDaemonCommand())
          .parseAsync(['daemon', 'install']);
        expect(install).toHaveBeenCalledWith({
          startService: true,
          dryRun: false,
        });
        expect(output.mock.calls).toEqual([
          ['dreamux daemon install file ledger:'],
          ['dreamux daemon install service: windows \\Dreamux-fixture'],
          ...(handedOff
            ? [
                [
                  'dreamux daemon install: handed off to an external controller; completion is not yet confirmed',
                ],
              ]
            : []),
        ]);
      } finally {
        output.mockRestore();
        install.mockRestore();
      }
    },
  );

  it.each([true, false])(
    'reports onboard completion as unconfirmed only for handoff (%s)',
    async (handedOff) => {
      const answers = {
        dispatcherId: 'fixture',
        dispatcherCwd: '/fixture',
        agentRuntime: { id: 'fixture', provider: 'builtin:codex', config: {} },
        channels: [],
        registerService: true,
        startService: true,
        dreamuxBin: '/fixture/dreamux',
        dryRun: false,
      };
      const collect = vi
        .spyOn(onboardWizard, 'collectOnboardAnswers')
        .mockResolvedValue(answers);
      const onboard = vi.spyOn(onboarding, 'runOnboard').mockResolvedValue({
        files: [],
        doctor: { ok: true, detail: 'fixture', errors: [], reports: [] },
        service: {
          platform: 'windows',
          unitPath: '\\Dreamux-fixture',
          registered: true,
          started: !handedOff,
          handedOff,
          lingerEnabled: null,
          warnings: [],
        },
      });
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await yargs()
          .exitProcess(false)
          .command(createOnboardCommand())
          .parseAsync(['onboard']);
        expect(onboard).toHaveBeenCalledWith({ answers });
        expect(output.mock.calls).toEqual([
          ['dreamux onboard file ledger:'],
          ['dreamux onboard doctor: ok'],
          ['dreamux onboard service: windows \\Dreamux-fixture'],
          ...(handedOff
            ? [
                [
                  'dreamux onboard service: handed off to an external controller; completion is not yet confirmed',
                ],
              ]
            : []),
        ]);
      } finally {
        output.mockRestore();
        onboard.mockRestore();
        collect.mockRestore();
      }
    },
  );
});
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
  it('pipes Unicode input through EOF without using the command line', async () => {
    const input = '工具🔑'.repeat(20_000);
    await expect(
      new ExecaCommandRunner().capture(
        process.execPath,
        [
          '-e',
          "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(input));",
        ],
        { input },
      ),
    ).resolves.toBe(input);
  });

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
