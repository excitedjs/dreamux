import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { execa, type ResultPromise } from 'execa';
import { WindowsJob } from '@excitedjs/dreamux-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { controlUserService } from '../src/daemon/control.js';
import {
  managedServiceCommand,
  managedServiceEnvironment,
  validateManagedServiceLaunch,
  type ServiceInstallAnswers,
} from '../src/daemon/environment.js';
import { createServiceHost } from '../src/daemon/host.js';
import {
  installUserService,
  runDaemonUninstall,
} from '../src/daemon/install.js';
import { getServiceStatus } from '../src/daemon/status.js';
import { assertWindowsServiceInstallable } from '../src/daemon/windows.js';
import {
  windowsPowerShellEnvironment,
  type WindowsTaskRegistration,
} from '../src/daemon/windows-task.js';
import {
  ExecaCommandRunner,
  type CommandRunner,
} from '../src/platform/command-runner.js';
import { TransparentFileLedger } from '../src/platform/file-ledger.js';
import {
  restartIntentPath,
  windowsServiceJobName,
} from '../src/platform/paths.js';

const serviceEntry = fileURLToPath(
  new URL('../dist/daemon/windows-entry.js', import.meta.url),
);

function entryOptions(root: string) {
  return {
    cwd: join(root, 'state'),
    reject: false,
    windowsHide: true,
    env: windowsPowerShellEnvironment(),
    extendEnv: false,
  } as const;
}

function registeredTask(
  answers: ServiceInstallAnswers,
  overrides: Partial<WindowsTaskRegistration> = {},
): WindowsTaskRegistration {
  const environment = managedServiceEnvironment(answers);
  delete environment['DREAMUX_ROOT'];
  return {
    name: 'Dreamux-fixture',
    path: '\\Dreamux-fixture',
    state: 4,
    enabled: true,
    lastResult: 0,
    workingDirectory: join(answers.homeDir!, 'state'),
    data: JSON.stringify({
      environment,
      execStart: managedServiceCommand(answers, 'serve'),
    }),
    ...overrides,
  };
}

function taskRunner(task: WindowsTaskRegistration | null) {
  return {
    capture: vi
      .fn<CommandRunner['capture']>()
      .mockResolvedValue(JSON.stringify(task)),
    run: vi
      .fn<CommandRunner['run']>()
      .mockRejectedValue(new Error('Unexpected command execution')),
    check: vi
      .fn<CommandRunner['check']>()
      .mockRejectedValue(new Error('Unexpected executable check')),
  };
}

describe('Windows managed service', () => {
  let root: string;
  let previousRoot: string | undefined;
  let answers: ServiceInstallAnswers;
  let children: ResultPromise<ReturnType<typeof entryOptions>>[];
  let cleanup: { removable: boolean; closing: boolean };
  beforeEach(async () => {
    children = [];
    cleanup = { removable: true, closing: false };
    root = await mkdtemp(join(tmpdir(), 'dreamux-windows-service-'));
    previousRoot = process.env['DREAMUX_ROOT'];
    process.env['DREAMUX_ROOT'] = root;
    answers = {
      providerBinChecks: [],
      dreamuxBin: join(root, 'package', 'bin', 'dreamux'),
      nodeBin: process.execPath,
      startService: false,
      dryRun: false,
      homeDir: root,
      platform: 'win32',
      env: {
        PATH: 'session-bin',
        APPDATA: join(root, 'AppData'),
        SystemRoot: 'C:\\Windows',
      },
      fallbackDirs: [],
    };
  });
  afterEach(async ({ task }) => {
    const fixtureRoot = root;
    const fixtureChildren = children;
    const fixtureCleanup = cleanup;
    const fixturePreviousRoot = previousRoot;
    fixtureCleanup.closing = true;
    try {
      if (fixtureChildren.length > 0) {
        let job: WindowsJob | undefined;
        try {
          // Retain the exact fixture Job through native exit waits. Reserving
          // its name also fences an entry still starting when the test times out.
          job = await WindowsJob.acquire(windowsServiceJobName(fixtureRoot));
          await job.terminate();
        } finally {
          try {
            await Promise.all(
              fixtureChildren.map(async (child) => {
                try {
                  child.kill();
                } finally {
                  await child;
                }
              }),
            );
          } finally {
            job?.close();
          }
        }
      }
      // A timed-out body can still read its logs after its child settles.
      // Preserve failed/incomplete fixtures rather than race that activity.
      if (fixtureCleanup.removable && task.result?.state !== 'fail')
        await rm(fixtureRoot, { recursive: true, force: true });
    } finally {
      if (process.env['DREAMUX_ROOT'] === fixtureRoot) {
        if (fixturePreviousRoot === undefined)
          delete process.env['DREAMUX_ROOT'];
        else process.env['DREAMUX_ROOT'] = fixturePreviousRoot;
      }
    }
  });

  it('installs a user logon task and reads its launch environment and native status', async () => {
    const task = registeredTask(answers);
    const runner = taskRunner(task);
    runner.capture
      .mockResolvedValueOnce('null')
      .mockResolvedValueOnce(task.path);
    const result = await installUserService({
      answers,
      ledger: new TransparentFileLedger(),
      host: createServiceHost({ runner, platform: 'win32', homeDir: root }),
    });
    expect(result).toMatchObject({
      platform: 'windows',
      unitPath: task.path,
      started: false,
      handedOff: false,
    });
    expect(runner.capture).toHaveBeenCalledTimes(2);
    expect(runner.run).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'daemon.mjs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const status = await getServiceStatus({ runner, platform: 'win32' });
    expect(status).toMatchObject({
      platform: 'windows',
      unitPath: task.path,
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      detail: 'Running, last result=0',
      execStart: [answers.nodeBin, answers.dreamuxBin, 'serve'],
      environment: managedServiceEnvironment(answers),
    });
    runner.capture.mockResolvedValue(JSON.stringify({ ...task, state: 3 }));
    expect(
      (await getServiceStatus({ runner, platform: 'win32' })).running,
    ).toBe(false);
  });

  describe('Windows installation guard', () => {
    it.each([2, 4])(
      'rejects an active registration at another root (state %i) before changing installation files',
      async (state) => {
        const task = registeredTask(answers, {
          state,
          workingDirectory: join(root, 'other-install', 'state'),
        });
        const sentinel = join(root, 'installation-sentinel');
        await writeFile(sentinel, 'original installation');
        const runner = taskRunner(task);
        await expect(
          installUserService({
            answers,
            ledger: new TransparentFileLedger(),
            host: createServiceHost({
              runner,
              platform: 'win32',
              homeDir: root,
            }),
          }),
        ).rejects.toThrow(
          'from a terminal outside the service before installing with a different root',
        );
        expect(runner.capture).toHaveBeenCalledTimes(1);
        expect(runner.run).not.toHaveBeenCalled();
        expect(await readFile(sentinel, 'utf8')).toBe('original installation');
        await expect(
          readFile(join(root, 'logs', 'daemon.stdout.log')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );

    it('rejects an old registration without task data before writing installation files', async () => {
      const runner = taskRunner(registeredTask(answers, { data: '' }));
      await expect(
        installUserService({
          answers,
          ledger: new TransparentFileLedger(),
          host: createServiceHost({ runner, platform: 'win32', homeDir: root }),
        }),
      ).rejects.toThrow('missing or invalid task data');
      expect(runner.capture).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
      await expect(
        readFile(join(root, 'logs', 'daemon.stdout.log')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('allows replacing a stopped registration from a different root', async () => {
      const task = registeredTask(answers, {
        state: 3,
        workingDirectory: join(root, 'other-install', 'state'),
      });
      const runner = taskRunner(task);
      runner.capture
        .mockResolvedValueOnce(JSON.stringify(task))
        .mockResolvedValueOnce(task.path);
      expect(
        await installUserService({
          answers,
          ledger: new TransparentFileLedger(),
          host: createServiceHost({ runner, platform: 'win32', homeDir: root }),
        }),
      ).toMatchObject({
        unitPath: task.path,
        registered: true,
        started: false,
      });
      expect(runner.capture).toHaveBeenCalledTimes(2);
      expect(runner.run).not.toHaveBeenCalled();
      expect(
        await readFile(join(root, 'logs', 'daemon.stdout.log'), 'utf8'),
      ).toBe('');
    });

    it('allows an active registration with the same Global Job identity', async () => {
      const runner = taskRunner(registeredTask(answers));
      await assertWindowsServiceInstallable(runner, false);
      expect(runner.capture).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
    });
  });

  it('reports a missing registration without inventing a running service', async () => {
    expect(
      await getServiceStatus({ runner: taskRunner(null), platform: 'win32' }),
    ).toMatchObject({
      installed: false,
      loaded: false,
      running: false,
      environment: null,
    });
  });

  it.each(['start', 'stop', 'restart'] as const)(
    'previews %s without querying or controlling a task',
    async (verb) => {
      const runner = taskRunner(null);
      expect(
        await controlUserService(verb, {
          runner,
          platform: 'win32',
          dryRun: true,
        }),
      ).toMatchObject({
        platform: 'windows',
        verb,
        commands: [],
        handedOff: false,
      });
      expect(runner.capture).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'unregisters only the service and preserves existing configuration',
    async () => {
      const task = registeredTask(answers);
      const runner = taskRunner(task);
      runner.capture
        .mockResolvedValueOnce(JSON.stringify(task))
        .mockResolvedValueOnce('true');
      runner.run.mockResolvedValue(undefined);
      await writeFile(join(root, 'config.json'), '{}');
      expect(
        await runDaemonUninstall({ runner, platform: 'win32' }),
      ).toMatchObject({ unitPath: task.path, removed: true });
      expect(runner.run).toHaveBeenCalledTimes(3);
      expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{}');
    },
  );

  it.each([false, true])(
    'previews installation without writing a script or registering a task (start: %s)',
    async (startService) => {
      const runner = taskRunner(null);
      const result = await installUserService({
        answers: { ...answers, dryRun: true, startService },
        ledger: new TransparentFileLedger(),
        host: createServiceHost({ runner, platform: 'win32' }),
      });
      expect(result.unitPath).toBe('\\Dreamux-<current-user-SID>');
      expect(result).toMatchObject({ started: startService, handedOff: false });
      expect(runner.capture).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      await expect(readFile(join(root, 'daemon.mjs'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'reports self-install handoff without claiming the service started',
    async () => {
      const fixtureRoot = root;
      const fixtureChildren = children;
      const fixtureCleanup = cleanup;
      const installAnswers = { ...answers, startService: true };
      const task = registeredTask(installAnswers);
      await mkdir(join(fixtureRoot, 'state'));
      await mkdir(join(fixtureRoot, 'logs'));
      const installer = join(fixtureRoot, 'self-install.mjs');
      await writeFile(
        installer,
        `
import { installUserService } from ${JSON.stringify(new URL('../dist/daemon/install.js', import.meta.url).href)};
import { createServiceHost } from ${JSON.stringify(new URL('../dist/daemon/host.js', import.meta.url).href)};
import { TransparentFileLedger } from ${JSON.stringify(new URL('../dist/platform/file-ledger.js', import.meta.url).href)};
const task = ${JSON.stringify(task)};
let captures = 0;
let runs = 0;
const runner = {
  capture: async () => ++captures === 2 ? task.path : JSON.stringify(task),
  run: async () => { runs++; },
  check: async () => { throw new Error('Unexpected executable check'); },
};
const service = await installUserService({
  answers: ${JSON.stringify(installAnswers)},
  ledger: new TransparentFileLedger(),
  host: createServiceHost({ runner, platform: 'win32', homeDir: ${JSON.stringify(fixtureRoot)} }),
});
console.log(JSON.stringify({ service, captures, runs }));
`,
      );
      const entryTask = {
        ...task,
        data: JSON.stringify({
          environment: {},
          execStart: [process.execPath, installer],
        }),
      };
      const wrapper = join(fixtureRoot, 'invoke-self-install.mjs');
      await writeFile(
        wrapper,
        `
import { runWindowsService } from ${JSON.stringify(new URL('../dist/daemon/windows-entry.js', import.meta.url).href)};
await runWindowsService(${JSON.stringify(task.name)}, {
  capture: async () => ${JSON.stringify(JSON.stringify(entryTask))},
  run: async () => { throw new Error('Unexpected entry runner.run'); },
  check: async () => { throw new Error('Unexpected executable check'); },
});
`,
      );
      if (fixtureCleanup.closing)
        throw new Error('Fixture cleanup has started');
      const child = execa(
        process.execPath,
        [wrapper],
        entryOptions(fixtureRoot),
      );
      fixtureChildren.push(child);
      const result = await child;
      const stderr = await readFile(
        join(fixtureRoot, 'logs', 'daemon.stderr.log'),
        'utf8',
      );
      expect(result.exitCode, `${result.stderr}\n${stderr}`).toBe(0);
      expect(
        JSON.parse(
          (
            await readFile(
              join(fixtureRoot, 'logs', 'daemon.stdout.log'),
              'utf8',
            )
          ).trim(),
        ),
      ).toMatchObject({
        service: {
          platform: 'windows',
          unitPath: task.path,
          registered: true,
          started: false,
          handedOff: true,
        },
        captures: 3,
        runs: 1,
      });
    },
    30_000,
  );

  it('checks the Node launcher under the captured Windows profile environment', async () => {
    const runner = taskRunner(null);
    runner.capture.mockResolvedValue('v22.7.0');
    runner.check.mockResolvedValue(true);
    expect((await validateManagedServiceLaunch(answers, runner)).ok).toBe(true);
    expect(runner.check).toHaveBeenCalledWith(
      process.execPath,
      [answers.dreamuxBin, '--help'],
      {
        env: expect.objectContaining({
          USERPROFILE: root,
          APPDATA: answers.env?.['APPDATA'],
          SystemRoot: 'C:\\Windows',
        }),
      },
    );
  });

  it.skipIf(process.platform !== 'win32').each(['node', 'cmd'])(
    'runs the packaged %s launcher with Unicode paths, logs, arguments and exit status',
    async (kind) => {
      const fixtureRoot = root;
      const fixtureAnswers = answers;
      const fixtureChildren = children;
      const fixtureCleanup = cleanup;
      const fixtureDir = join(fixtureRoot, "用户's service");
      await mkdir(fixtureDir);
      await mkdir(join(fixtureRoot, 'state'));
      await mkdir(join(fixtureRoot, 'logs'));
      const launcher = join(fixtureDir, 'launcher.cjs');
      await writeFile(
        launcher,
        `console.log(JSON.stringify({arg: process.argv[2], home: process.env.USERPROFILE})); console.error('fixture stderr'); process.exitCode = 7;`,
      );
      const shim = join(fixtureDir, 'launcher.cmd');
      if (kind === 'cmd')
        await writeFile(
          shim,
          `@echo off\r\n"${process.execPath}" "%~dp0launcher.cjs" %*\r\n`,
        );
      const task = registeredTask({
        ...fixtureAnswers,
        dreamuxBin: kind === 'cmd' ? shim : launcher,
      });
      const wrapper = join(fixtureDir, 'invoke-entry.mjs');
      await writeFile(
        wrapper,
        `
import { runWindowsService } from ${JSON.stringify(new URL('../dist/daemon/windows-entry.js', import.meta.url).href)};
await runWindowsService(${JSON.stringify(task.name)}, {
  capture: async () => ${JSON.stringify(JSON.stringify(task))},
  run: async () => { throw new Error('Unexpected command execution'); },
  check: async () => { throw new Error('Unexpected executable check'); },
});
`,
      );
      if (fixtureCleanup.closing)
        throw new Error('Fixture cleanup has started');
      const child = execa(
        process.execPath,
        [wrapper],
        entryOptions(fixtureRoot),
      );
      fixtureChildren.push(child);
      const result = await child;
      expect(result.exitCode, result.stderr).toBe(7);
      expect(
        JSON.parse(
          (
            await readFile(
              join(fixtureRoot, 'logs', 'daemon.stdout.log'),
              'utf8',
            )
          )
            .replace(/^\uFEFF/, '')
            .trim(),
        ),
      ).toEqual({ arg: 'serve', home: fixtureRoot });
      expect(
        await readFile(join(fixtureRoot, 'logs', 'daemon.stderr.log'), 'utf8'),
      ).toContain('fixture stderr');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'records a real command startup failure without an unhandled rejection',
    async () => {
      const fixtureRoot = root;
      const fixtureAnswers = answers;
      const fixtureChildren = children;
      const fixtureCleanup = cleanup;
      await mkdir(join(fixtureRoot, 'state'));
      await mkdir(join(fixtureRoot, 'logs'));
      const task = registeredTask({
        ...fixtureAnswers,
        dreamuxBin: join(fixtureRoot, 'missing-command.exe'),
      });
      const wrapper = join(fixtureRoot, 'invoke-missing-entry.mjs');
      await writeFile(
        wrapper,
        `
import { runWindowsService } from ${JSON.stringify(new URL('../dist/daemon/windows-entry.js', import.meta.url).href)};
await runWindowsService(${JSON.stringify(task.name)}, {
  capture: async () => ${JSON.stringify(JSON.stringify(task))},
  run: async () => { throw new Error('Unexpected command execution'); },
  check: async () => { throw new Error('Unexpected executable check'); },
});
`,
      );
      if (fixtureCleanup.closing)
        throw new Error('Fixture cleanup has started');
      const child = execa(
        process.execPath,
        [wrapper],
        entryOptions(fixtureRoot),
      );
      fixtureChildren.push(child);
      const result = await child;
      expect(result.exitCode).not.toBe(0);
      const stderr = await readFile(
        join(fixtureRoot, 'logs', 'daemon.stderr.log'),
        'utf8',
      );
      expect(stderr).toContain('Windows daemon start failed');
      expect(stderr).toContain('ENOENT');
      expect(`${result.stderr}\n${stderr}`).not.toMatch(
        /UnhandledPromiseRejection|unhandledRejection|ERR_UNHANDLED_REJECTION|triggerUncaughtException|fromPromise/i,
      );
    },
  );

  it.runIf(
    process.platform === 'win32' &&
      process.env['DREAMUX_RUN_WINDOWS_SERVICE_TEST'] === '1',
  )(
    'controls and self-restarts an isolated Interactive lifecycle fixture without surviving children',
    async () => {
      const fixtureCleanup = cleanup;
      fixtureCleanup.removable = false;
      const fixtureRoot = root;
      const fixtureAnswers = answers;
      const taskName = `Dreamux-Test-${randomUUID()}`;
      const systemRunner = new ExecaCommandRunner();
      const taskArgs = (args: string[]) => {
        const script = Buffer.from(args.at(-1) ?? '', 'base64').toString(
          'utf16le',
        );
        return [
          ...args.slice(0, -1),
          Buffer.from(
            script.replace(
              "$taskName = 'Dreamux-' + $user",
              `$taskName = '${taskName}'`,
            ),
            'utf16le',
          ).toString('base64'),
        ];
      };
      const runner: CommandRunner = {
        run: (command, args, options) =>
          systemRunner.run(command, taskArgs(args), options),
        capture: (command, args, options) =>
          systemRunner.capture(command, taskArgs(args), options),
        check: (command, args, options) =>
          systemRunner.check(command, taskArgs(args), options),
      };
      const pidFile = join(fixtureRoot, 'pids.json');
      const restartRequest = join(fixtureRoot, 'restart-request');
      const restartMarker = restartIntentPath(fixtureRoot);
      const launcher = join(fixtureRoot, 'launcher.mjs');
      await writeFile(
        launcher,
        `
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createAdminSocketServer } from ${JSON.stringify(new URL('../dist/admin/socket.js', import.meta.url).href)};
import { UnknownCommandError } from ${JSON.stringify(new URL('../dist/command/errors.js', import.meta.url).href)};
import { createLogger } from ${JSON.stringify(new URL('../dist/platform/logger.js', import.meta.url).href)};
import { adminSocketPath } from ${JSON.stringify(new URL('../dist/platform/paths.js', import.meta.url).href)};
import { controlWindowsService } from ${JSON.stringify(new URL('../dist/daemon/windows.js', import.meta.url).href)};
import { ExecaCommandRunner } from ${JSON.stringify(new URL('../dist/platform/command-runner.js', import.meta.url).href)};
import { notifyResumedRestart, RestartIntentConsumer } from ${JSON.stringify(new URL('../dist/service/dispatcher-service/restart-intent.js', import.meta.url).href)};
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
const admin = createAdminSocketServer({
  logger: createLogger({ destination: { write() {} } }),
  commands: {
    async invoke(_context, method) {
      if (method !== 'server.status') throw new UnknownCommandError(method);
      return { pid: process.pid };
    },
  },
}, adminSocketPath());
await admin.start();
const marker = await RestartIntentConsumer.load({ now: Date.now(), path: ${JSON.stringify(restartMarker)}, log: { warn: console.error } });
await writeFile(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid, notice: marker.claim('fixture', Date.now()), noticeAgain: marker.claim('fixture', Date.now()) }));
let controlling = false;
setInterval(async () => {
  if (controlling) return;
  let request;
  try { request = await readFile(${JSON.stringify(restartRequest)}, 'utf8'); } catch { return; }
  controlling = true;
  await rm(${JSON.stringify(restartRequest)});
  if (request === 'restart') {
    await notifyResumedRestart({
      targets: ['fixture'], now: Date.now(), path: ${JSON.stringify(restartMarker)},
      runControl: () => controlWindowsService('restart', new ExecaCommandRunner(), false, ${JSON.stringify(taskName)}),
    });
  } else {
    await controlWindowsService('stop', new ExecaCommandRunner(), false, ${JSON.stringify(taskName)});
  }
}, 25);
`,
      );
      const readPids = async () =>
        JSON.parse(await readFile(pidFile, 'utf8')) as {
          parent: number;
          child: number;
          notice: string | null;
          noticeAgain: string | null;
        };
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const assertStopped = (pids: { parent: number; child: number }) => {
        expect(alive(pids.parent)).toBe(false);
        expect(alive(pids.child)).toBe(false);
      };
      try {
        // This opt-in fixture covers task control in the current session, not
        // Password credentials or execution across logon sessions.
        await mkdir(join(fixtureRoot, 'state'));
        await mkdir(join(fixtureRoot, 'logs'));
        const task = registeredTask(
          {
            ...fixtureAnswers,
            dreamuxBin: launcher,
            env: { ...fixtureAnswers.env, PATH: process.env['PATH'] },
          },
          { name: taskName, path: `\\${taskName}` },
        );
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const fixtureRegistration = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.SecurityDescriptor = 'D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;' + $user + ')'
$definition.Principal.UserId = $user
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $user
$trigger.Enabled = $true
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.RestartCount = 999
$definition.Settings.RestartInterval = 'PT1M'
$definition.Settings.MultipleInstances = 2
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Data = ${quote(task.data)}
$action = $definition.Actions.Create(0)
$action.Path = ${quote(fixtureAnswers.nodeBin)}
$action.Arguments = ${quote(`"${serviceEntry}" "${taskName}"`)}
$action.WorkingDirectory = ${quote(task.workingDirectory)}
Register-ScheduledTask -TaskName ${quote(taskName)} -TaskPath '\\' -Xml $definition.XmlText -Force | Out-Null
$registered = $scheduler.GetFolder('\\').GetTask(${quote(taskName)})
$security = [System.Security.AccessControl.RawSecurityDescriptor]::new($registered.GetSecurityDescriptor(4))
$userAccess = @($security.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -eq $user -and $_.AceQualifier -eq 'AccessAllowed' })
if ($userAccess.Count -eq 0) { throw 'Fixture task did not retain its account access rule' }
`;
        await systemRunner.run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            Buffer.from(fixtureRegistration, 'utf16le').toString('base64'),
          ],
          { env: windowsPowerShellEnvironment() },
        );
        await controlUserService('start', { runner, platform: 'win32' });
        await vi.waitFor(
          async () => expect((await readPids()).parent).toBeGreaterThan(0),
          { timeout: 15000 },
        );
        for (let index = 0; index < 2; index += 1) {
          const previous = await readPids();
          await controlUserService('restart', { runner, platform: 'win32' });
          assertStopped(previous);
          await vi.waitFor(
            async () =>
              expect((await readPids()).parent).not.toBe(previous.parent),
            { timeout: 15000 },
          );
        }
        const beforeSelfRestart = await readPids();
        await writeFile(restartRequest, 'restart');
        try {
          await vi.waitFor(
            async () => {
              const resumed = await readPids();
              expect(resumed.parent).not.toBe(beforeSelfRestart.parent);
              expect(resumed.notice).toBe('Restart completed.');
              expect(resumed.noticeAgain).toBeNull();
            },
            { timeout: 15000 },
          );
        } catch (cause) {
          const stderr = await readFile(
            join(fixtureRoot, 'logs', 'daemon.stderr.log'),
            'utf8',
          );
          throw new Error(`Self-restart fixture failed: ${stderr}`, { cause });
        }
        assertStopped(beforeSelfRestart);
        await expect(readFile(restartMarker)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const beforeSelfStop = await readPids();
        await writeFile(restartRequest, 'stop');
        await vi.waitFor(
          async () =>
            expect(
              await getServiceStatus({ runner, platform: 'win32' }),
            ).toMatchObject({ running: false, enabled: true }),
          { timeout: 15000 },
        );
        assertStopped(beforeSelfStop);
        await controlUserService('start', { runner, platform: 'win32' });
        await vi.waitFor(
          async () =>
            expect((await readPids()).parent).not.toBe(beforeSelfStop.parent),
          { timeout: 15000 },
        );
        let previous = await readPids();
        await controlUserService('stop', { runner, platform: 'win32' });
        assertStopped(previous);
        expect(
          (await getServiceStatus({ runner, platform: 'win32' })).running,
        ).toBe(false);
        await systemRunner.run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-Command',
            `Disable-ScheduledTask -TaskName '${taskName}' | Out-Null`,
          ],
          { env: windowsPowerShellEnvironment() },
        );
        await controlUserService('stop', { runner, platform: 'win32' });
        expect(
          (await getServiceStatus({ runner, platform: 'win32' })).enabled,
        ).toBe(false);
        await controlUserService('start', { runner, platform: 'win32' });
        await vi.waitFor(
          async () =>
            expect((await readPids()).parent).not.toBe(previous.parent),
          { timeout: 15000 },
        );
        previous = await readPids();
        await runDaemonUninstall({ runner, platform: 'win32' });
        assertStopped(previous);
        expect(
          (await getServiceStatus({ runner, platform: 'win32' })).installed,
        ).toBe(false);
      } finally {
        await runDaemonUninstall({ runner, platform: 'win32' });
        fixtureCleanup.removable = true;
      }
    },
    90000,
  );
});
