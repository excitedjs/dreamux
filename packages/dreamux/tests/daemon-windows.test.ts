import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import { controlUserService } from '../src/daemon/control.js';
import {
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
import {
  assertWindowsServiceInstallable,
  registerWindowsService,
  renderWindowsService,
  windowsPowerShellEnvironment,
} from '../src/daemon/windows.js';
import {
  ExecaCommandRunner,
  type CommandRunner,
} from '../src/platform/command-runner.js';
import { TransparentFileLedger } from '../src/platform/file-ledger.js';
import { windowsServiceFile } from '../src/platform/paths.js';

/** Explicit per-case budget for the real powershell.exe registration cases. */
const SCHEDULED_TASK_FIXTURE_TIMEOUT_MS = 30_000;

class WindowsRunner implements CommandRunner {
  calls: { command: string; script: string }[] = [];
  state = 'Running';
  installed = true;
  registeredLauncher: string | null = null;
  async run(command: string, args: string[], options?: { dryRun?: boolean }) {
    if (options?.dryRun) return;
    this.calls.push({
      command,
      script: Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le'),
    });
  }
  async capture(command: string, args: string[]) {
    if (args[0] === '--version') return 'v22.7.0';
    expect(command).toBe('powershell.exe');
    const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
    this.calls.push({ command, script });
    if (script.includes('$registered.Actions[0].Arguments')) {
      return JSON.stringify(
        this.installed
          ? {
              taskName: 'Dreamux-fixture',
              state: this.state,
              launcher: this.registeredLauncher,
            }
          : null,
      );
    }
    if (script.includes('$task.Definition.Actions.Item(1).Arguments')) {
      return JSON.stringify(
        this.installed ? { enabled: true, launcher: null } : null,
      );
    }
    return JSON.stringify(
      this.installed
        ? {
            state: this.state,
            enabled: true,
            lastResult: 0,
          }
        : null,
    );
  }
  async check(_command: string, args: string[]) {
    return args.includes('--help');
  }
}

function scheduledTaskScriptRunner(
  logonType: 'Password' | 'Interactive' | null,
  fixture: { failSet?: boolean; mockPrompt?: boolean } = {},
) {
  const calls: { command: string; parameters: Record<string, unknown> }[] = [];
  const run = vi.fn<CommandRunner['run']>(async (command, args, options) => {
    if (run.mock.calls.length !== 1)
      throw new Error('Unexpected additional scheduler process');
    expect(command).toBe('powershell.exe');
    const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
    // Only command binding and branching are real here, not Scheduler storage
    // or the reuse of a Password task's stored credentials.
    const shadowed = `
$PSModuleAutoLoadingPreference = 'None'
Import-Module Microsoft.PowerShell.Utility
$fixtureCalls = [System.Collections.Generic.List[object]]::new()
$fixtureTaskName = 'Dreamux-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixturePassword = [guid]::NewGuid().ToString()
function Record-SchedulerCall($command, $parameters) {
  $values = @{} + $parameters
  if ($values.ContainsKey('Password')) { $values.Password = $values.Password -eq $fixturePassword }
  $fixtureCalls.Add(@{ command = $command; parameters = $values })
  [pscustomobject]$values
}
function Get-ScheduledTask {
  [CmdletBinding()] param($TaskPath)
  $null = Record-SchedulerCall 'Get-ScheduledTask' $PSBoundParameters
  [pscustomobject]@{ TaskName = 'Dreamux-unrelated' }
  if ($${logonType !== null}) {
    [pscustomobject]@{
      TaskName = $fixtureTaskName
      TaskPath = '\\'
      Actions = @(@{ Execute = 'old-action' })
      Principal = @{ LogonType = '${logonType}'; RunLevel = 'Highest' }
      Description = 'operator-description'
      Triggers = @('operator-trigger')
      Settings = @{ Description = 'operator-settings' }
    }
  }
}
function New-ScheduledTaskAction {
  [CmdletBinding()] param($Execute, $Argument, $WorkingDirectory)
  Record-SchedulerCall 'New-ScheduledTaskAction' $PSBoundParameters
}
function New-ScheduledTaskTrigger {
  [CmdletBinding()] param([switch]$AtLogOn, $User)
  Record-SchedulerCall 'New-ScheduledTaskTrigger' $PSBoundParameters
}
function New-ScheduledTaskPrincipal {
  [CmdletBinding()] param($UserId, $LogonType, $RunLevel)
  Record-SchedulerCall 'New-ScheduledTaskPrincipal' $PSBoundParameters
}
function New-ScheduledTaskSettingsSet {
  [CmdletBinding()] param([TimeSpan]$ExecutionTimeLimit, $RestartCount, [TimeSpan]$RestartInterval, $MultipleInstances, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
  Record-SchedulerCall 'New-ScheduledTaskSettingsSet' $PSBoundParameters
}
function New-ScheduledTask {
  [CmdletBinding()] param($Action, $Trigger, $Principal, $Settings)
  $null = Record-SchedulerCall 'New-ScheduledTask' $PSBoundParameters
  [pscustomobject]@{ Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings }
}
function Register-ScheduledTask {
  [CmdletBinding()] param($InputObject, $TaskName, $TaskPath, $User, $Password, [switch]$Force)
  $null = Record-SchedulerCall 'Register-ScheduledTask' $PSBoundParameters
}
function Set-ScheduledTask {
  [CmdletBinding()] param($TaskName, $TaskPath, $Action, $InputObject, $User, $Password)
  $null = Record-SchedulerCall 'Set-ScheduledTask' $PSBoundParameters
  if ($${fixture.failSet ?? false}) { Write-Error 'fixture Set-ScheduledTask failed' }
}
${
  fixture.mockPrompt === false
    ? ''
    : `
function Read-Host {
  [CmdletBinding()] param($Prompt, [switch]$AsSecureString)
  $null = Record-SchedulerCall 'Read-Host' $PSBoundParameters
  $secure = [System.Security.SecureString]::new()
  foreach ($character in $fixturePassword.ToCharArray()) { $secure.AppendChar($character) }
  $secure
}
`
}
try {
  & {
${script}
  }
} finally {
  ConvertTo-Json -InputObject @($fixtureCalls.ToArray()) -Depth 10 -Compress
}
`;
    const child = execa(
      command,
      [
        ...args.slice(0, -1),
        Buffer.from(shadowed, 'utf16le').toString('base64'),
      ],
      {
        ...(options?.env ? { env: options.env, extendEnv: false } : {}),
        windowsHide: true,
        reject: false,
      },
    );
    onTestFinished(async () => {
      child.kill();
      await child;
    });
    const result = await child;
    calls.push(...(JSON.parse(result.stdout) as typeof calls));
    if (result.exitCode !== 0) throw new Error(result.stderr);
  });
  const capture = vi.fn<CommandRunner['capture']>(async () => {
    throw new Error('Unexpected scheduler capture');
  });
  const check = vi.fn<CommandRunner['check']>(async () => {
    throw new Error('Unexpected scheduler check');
  });
  return { runner: { run, capture, check }, calls };
}

describe('Windows managed service', () => {
  let root: string;
  let previousRoot: string | undefined;
  let answers: ServiceInstallAnswers;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-windows-service-'));
    previousRoot = process.env['DREAMUX_ROOT'];
    process.env['DREAMUX_ROOT'] = root;
    answers = {
      providerBinChecks: [],
      dreamuxBin: join(root, 'package', 'bin', 'dreamux'),
      nodeBin: process.execPath,
      startService: true,
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
  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['DREAMUX_ROOT'];
    else process.env['DREAMUX_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('installs a user logon task and reads its launch environment and native status', async () => {
    const runner = new WindowsRunner();
    const result = await installUserService({
      answers,
      ledger: new TransparentFileLedger(),
      host: createServiceHost({ runner, platform: 'win32', homeDir: root }),
    });
    expect(result).toMatchObject({
      platform: 'windows',
      unitPath: windowsServiceFile(),
      started: true,
    });
    expect(runner.calls).toHaveLength(7);
    expect(runner.calls[0]?.command).toBe('powershell.exe');
    expect(runner.calls[1]?.script).toContain(
      '-LogonType Password -RunLevel Limited',
    );
    expect(runner.calls[1]?.script).toContain(
      'New-ScheduledTaskTrigger -AtLogOn -User $user',
    );
    const status = await getServiceStatus({ runner, platform: 'win32' });
    expect(status).toMatchObject({
      platform: 'windows',
      installed: true,
      loaded: true,
      running: true,
      enabled: true,
      detail: 'Running, last result=0',
      execStart: [answers.nodeBin, answers.dreamuxBin, 'serve'],
      environment: managedServiceEnvironment(answers),
    });
    runner.state = 'Ready';
    expect(
      (await getServiceStatus({ runner, platform: 'win32' })).running,
    ).toBe(false);
  });

  describe.skipIf(process.platform !== 'win32')(
    'scheduled task registration',
    () => {
      it('allows interactive input only for registration with both TTY streams', async () => {
        const stdinTTY = Object.getOwnPropertyDescriptor(
          process.stdin,
          'isTTY',
        );
        const stdoutTTY = Object.getOwnPropertyDescriptor(
          process.stdout,
          'isTTY',
        );
        try {
          for (const [stdin, stdout] of [
            [true, true],
            [true, false],
            [false, true],
          ]) {
            Object.defineProperty(process.stdin, 'isTTY', {
              configurable: true,
              value: stdin,
            });
            Object.defineProperty(process.stdout, 'isTTY', {
              configurable: true,
              value: stdout,
            });
            const runner = new WindowsRunner();
            const run = vi.spyOn(runner, 'run');
            await registerWindowsService(windowsServiceFile(), runner, {
              ...answers,
              startService: false,
            });
            const args = run.mock.calls[0]?.[1] ?? [];
            expect(args.includes('-NonInteractive')).toBe(!(stdin && stdout));
            expect(args.includes('-WindowStyle')).toBe(!(stdin && stdout));
            await controlUserService('start', { runner, platform: 'win32' });
            expect(run.mock.calls[1]?.[1]).toEqual(
              expect.arrayContaining([
                '-NonInteractive',
                '-WindowStyle',
                'Hidden',
              ]),
            );
          }
        } finally {
          if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
          else Reflect.deleteProperty(process.stdin, 'isTTY');
          if (stdoutTTY)
            Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
          else Reflect.deleteProperty(process.stdout, 'isTTY');
        }
      });

      it(
        'updates only the action of an existing Password task',
        async () => {
          const { runner, calls } = scheduledTaskScriptRunner('Password');
          await registerWindowsService(windowsServiceFile(), runner, {
            ...answers,
            startService: false,
          });
          expect(calls.map((call) => call.command).sort()).toEqual([
            'Get-ScheduledTask',
            'New-ScheduledTaskAction',
            'Set-ScheduledTask',
          ]);
          expect(
            calls.find((call) => call.command === 'Get-ScheduledTask')
              ?.parameters,
          ).toEqual({ TaskPath: '\\' });
          expect(
            calls.find((call) => call.command === 'Set-ScheduledTask')
              ?.parameters,
          ).toEqual({
            TaskName: expect.stringMatching(/^Dreamux-S-1-/),
            TaskPath: '\\',
            Action: {
              Execute: answers.nodeBin,
              Argument: `"${windowsServiceFile()}"`,
              WorkingDirectory: join(root, 'state'),
            },
          });
        },
        SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
      );

      it(
        'registers a missing task with a Password principal and secure prompt',
        async () => {
          const { runner, calls } = scheduledTaskScriptRunner(null);
          await registerWindowsService(windowsServiceFile(), runner, {
            ...answers,
            startService: false,
          });
          expect(calls.map((call) => call.command).sort()).toEqual([
            'Get-ScheduledTask',
            'New-ScheduledTask',
            'New-ScheduledTaskAction',
            'New-ScheduledTaskPrincipal',
            'New-ScheduledTaskSettingsSet',
            'New-ScheduledTaskTrigger',
            'Read-Host',
            'Register-ScheduledTask',
          ]);
          expect(
            calls.find((call) => call.command === 'Read-Host')?.parameters,
          ).toEqual({
            Prompt: 'Windows account password (not PIN)',
            AsSecureString: { IsPresent: true },
          });
          const registration = calls.find(
            (call) => call.command === 'Register-ScheduledTask',
          )?.parameters;
          expect(registration).toEqual({
            TaskName: expect.stringMatching(/^Dreamux-S-1-/),
            TaskPath: '\\',
            User: expect.any(String),
            Password: true,
            InputObject: {
              Actions: [
                {
                  Execute: answers.nodeBin,
                  Argument: `"${windowsServiceFile()}"`,
                  WorkingDirectory: join(root, 'state'),
                },
              ],
              Triggers: [
                {
                  AtLogOn: { IsPresent: true },
                  User: expect.stringMatching(/^S-1-/),
                },
              ],
              Principal: {
                UserId: expect.stringMatching(/^S-1-/),
                LogonType: 'Password',
                RunLevel: 'Limited',
              },
              Settings: {
                ExecutionTimeLimit: expect.objectContaining({
                  TotalSeconds: 0,
                }),
                RestartCount: 999,
                RestartInterval: expect.objectContaining({ TotalSeconds: 60 }),
                MultipleInstances: 'IgnoreNew',
                AllowStartIfOnBatteries: { IsPresent: true },
                DontStopIfGoingOnBatteries: { IsPresent: true },
              },
            },
            Force: { IsPresent: true },
          });
        },
        SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
      );

      it(
        'converts an Interactive task to Password while preserving its definition',
        async () => {
          const { runner, calls } = scheduledTaskScriptRunner('Interactive');
          await registerWindowsService(windowsServiceFile(), runner, {
            ...answers,
            startService: false,
          });
          expect(calls.map((call) => call.command).sort()).toEqual([
            'Get-ScheduledTask',
            'New-ScheduledTaskAction',
            'New-ScheduledTaskPrincipal',
            'Read-Host',
            'Set-ScheduledTask',
          ]);
          expect(
            calls.find((call) => call.command === 'Set-ScheduledTask')
              ?.parameters,
          ).toEqual({
            User: expect.any(String),
            Password: true,
            InputObject: {
              TaskName: expect.stringMatching(/^Dreamux-S-1-/),
              TaskPath: '\\',
              Actions: [
                {
                  Execute: answers.nodeBin,
                  Argument: `"${windowsServiceFile()}"`,
                  WorkingDirectory: join(root, 'state'),
                },
              ],
              Principal: {
                UserId: expect.stringMatching(/^S-1-/),
                LogonType: 'Password',
                RunLevel: 'Highest',
              },
              Description: 'operator-description',
              Triggers: ['operator-trigger'],
              Settings: { Description: 'operator-settings' },
            },
          });
        },
        SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
      );

      it(
        'rejects a password-required non-TTY install without registration or restart',
        async () => {
          const { runner, calls } = scheduledTaskScriptRunner(null, {
            mockPrompt: false,
          });
          const stdinTTY = Object.getOwnPropertyDescriptor(
            process.stdin,
            'isTTY',
          );
          const stdoutTTY = Object.getOwnPropertyDescriptor(
            process.stdout,
            'isTTY',
          );
          Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: false,
          });
          Object.defineProperty(process.stdout, 'isTTY', {
            configurable: true,
            value: false,
          });
          try {
            await expect(
              registerWindowsService(windowsServiceFile(), runner, answers),
            ).rejects.toThrow('requires a Windows account password');
          } finally {
            if (stdinTTY)
              Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
            else Reflect.deleteProperty(process.stdin, 'isTTY');
            if (stdoutTTY)
              Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
            else Reflect.deleteProperty(process.stdout, 'isTTY');
          }
          expect(calls.map((call) => call.command).sort()).toEqual([
            'Get-ScheduledTask',
            'New-ScheduledTaskAction',
          ]);
          expect(runner.run).toHaveBeenCalledTimes(1);
          expect(runner.run.mock.calls[0]?.[1]).toContain('-NonInteractive');
          expect(runner.capture).not.toHaveBeenCalled();
        },
        SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
      );

      it(
        'rejects an action update failure without registering or restarting',
        async () => {
          const { runner, calls } = scheduledTaskScriptRunner('Password', {
            failSet: true,
          });
          await expect(
            registerWindowsService(windowsServiceFile(), runner, {
              ...answers,
              startService: true,
            }),
          ).rejects.toThrow('fixture Set-ScheduledTask failed');
          expect(calls.map((call) => call.command).sort()).toEqual([
            'Get-ScheduledTask',
            'New-ScheduledTaskAction',
            'Set-ScheduledTask',
          ]);
          expect(runner.run).toHaveBeenCalledTimes(1);
          expect(runner.capture).not.toHaveBeenCalled();
          expect(runner.check).not.toHaveBeenCalled();
        },
        SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
      );
    },
  );

  describe('Windows installation guard', () => {
    async function registeredLauncher(
      kind: 'Local' | 'same Global' | 'different Global',
    ) {
      const directory = join(root, 'registered-install');
      await mkdir(directory);
      const launcher = join(directory, 'daemon.mjs');
      const originalRoot = process.env['DREAMUX_ROOT'];
      let content: string;
      try {
        if (kind === 'different Global')
          process.env['DREAMUX_ROOT'] = directory;
        content = renderWindowsService(answers, 'stdout', 'stderr');
      } finally {
        if (originalRoot === undefined) delete process.env['DREAMUX_ROOT'];
        else process.env['DREAMUX_ROOT'] = originalRoot;
      }
      if (kind === 'Local')
        content = content.replace('Global\\\\', 'Local\\\\');
      await writeFile(launcher, content);
      return { launcher, content };
    }

    it.each([
      ['Local', 'Running'],
      ['different Global', 'Queued'],
    ] as const)(
      'rejects an active %s Job before replacing any installation files',
      async (kind, state) => {
        const registered = await registeredLauncher(kind);
        await writeFile(windowsServiceFile(), 'target launcher sentinel');
        const runner = new WindowsRunner();
        runner.state = state;
        runner.registeredLauncher = `"${registered.launcher}"`;
        const run = vi.spyOn(runner, 'run');
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
          'from a terminal outside the service before installing with a different Job identity',
        );
        expect(run).not.toHaveBeenCalled();
        expect(await readFile(registered.launcher, 'utf8')).toBe(
          registered.content,
        );
        expect(await readFile(windowsServiceFile(), 'utf8')).toBe(
          'target launcher sentinel',
        );
      },
    );

    it('allows replacing a stopped Local Job from a different registered launcher path', async () => {
      const registered = await registeredLauncher('Local');
      const runner = new WindowsRunner();
      runner.state = 'Ready';
      runner.registeredLauncher = `"${registered.launcher}"`;
      const run = vi.spyOn(runner, 'run');
      await installUserService({
        answers: { ...answers, startService: false },
        ledger: new TransparentFileLedger(),
        host: createServiceHost({ runner, platform: 'win32', homeDir: root }),
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(await readFile(registered.launcher, 'utf8')).toBe(
        registered.content,
      );
      expect(await readFile(windowsServiceFile(), 'utf8')).toBe(
        renderWindowsService(
          answers,
          join(root, 'logs', 'daemon.stdout.log'),
          join(root, 'logs', 'daemon.stderr.log'),
        ),
      );
    });

    it('allows an active registration with the same Global Job identity', async () => {
      const registered = await registeredLauncher('same Global');
      const runner = new WindowsRunner();
      runner.registeredLauncher = `"${registered.launcher}"`;
      const run = vi.spyOn(runner, 'run');
      await assertWindowsServiceInstallable(runner, false);
      expect(run).not.toHaveBeenCalled();
      expect(await readFile(registered.launcher, 'utf8')).toBe(
        registered.content,
      );
    });
  });

  it('reports a missing registration and launch file without inventing a running service', async () => {
    const runner = new WindowsRunner();
    runner.installed = false;
    expect(await getServiceStatus({ runner, platform: 'win32' })).toMatchObject(
      {
        installed: false,
        loaded: false,
        running: false,
        environment: null,
      },
    );
  });

  it.each(['start', 'stop', 'restart'] as const)(
    'uses native task lifecycle for %s',
    async (verb) => {
      const runner = new WindowsRunner();
      await controlUserService(verb, { runner, platform: 'win32' });
      const script = runner.calls.map((call) => call.script).join('\n');
      expect(script.includes('Start-ScheduledTask')).toBe(verb !== 'stop');
      expect(script.includes('$task.Stop(0)')).toBe(verb !== 'start');
      if (verb === 'restart')
        expect(script.indexOf('$task.Stop(0)')).toBeLessThan(
          script.indexOf('Start-ScheduledTask'),
        );
    },
  );

  it('unregisters only the service and preserves existing configuration', async () => {
    const runner = new WindowsRunner();
    await writeFile(
      windowsServiceFile(),
      renderWindowsService(answers, 'stdout', 'stderr'),
    );
    await writeFile(join(root, 'config.json'), '{}');
    expect(
      await runDaemonUninstall({ runner, platform: 'win32' }),
    ).toMatchObject({ removed: true });
    expect(runner.calls.at(-1)?.script).toContain('Unregister-ScheduledTask');
    await expect(readFile(windowsServiceFile())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{}');
  });

  it('previews installation without writing a script or registering a task', async () => {
    const runner = new WindowsRunner();
    await installUserService({
      answers: { ...answers, dryRun: true },
      ledger: new TransparentFileLedger(),
      host: createServiceHost({ runner, platform: 'win32' }),
    });
    expect(runner.calls).toEqual([]);
    await expect(readFile(windowsServiceFile())).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('checks the Node launcher under the captured Windows profile environment', async () => {
    const checks: {
      command: string;
      args: string[];
      env: NodeJS.ProcessEnv | undefined;
    }[] = [];
    const runner = new WindowsRunner();
    runner.check = async (
      command,
      args,
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      checks.push({ command, args, env: options?.env });
      return true;
    };
    expect((await validateManagedServiceLaunch(answers, runner)).ok).toBe(true);
    expect(checks[0]).toMatchObject({
      command: process.execPath,
      args: [answers.dreamuxBin, '--help'],
      env: {
        USERPROFILE: root,
        APPDATA: answers.env?.['APPDATA'],
        SystemRoot: 'C:\\Windows',
      },
    });
  });

  it.skipIf(process.platform !== 'win32').each(['node', 'cmd'])(
    'runs the generated %s launcher with Unicode paths, logs, arguments and exit status',
    async (kind) => {
      const fixtureDir = join(root, "用户's service");
      await mkdir(fixtureDir);
      await mkdir(join(root, 'state'));
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
      const stdout = join(fixtureDir, 'stdout.log');
      const stderr = join(fixtureDir, 'stderr.log');
      const script = join(fixtureDir, 'daemon.mjs');
      await writeFile(
        script,
        renderWindowsService(
          { ...answers, dreamuxBin: kind === 'cmd' ? shim : launcher },
          stdout,
          stderr,
        ),
      );
      const result = await execa(process.execPath, [script], {
        reject: false,
        windowsHide: true,
        env: windowsPowerShellEnvironment(),
        extendEnv: false,
      });
      expect(result.exitCode, result.stderr).toBe(7);
      expect(
        JSON.parse(
          (await readFile(stdout, 'utf8')).replace(/^\uFEFF/, '').trim(),
        ),
      ).toEqual({ arg: 'serve', home: root });
      expect(await readFile(stderr, 'utf8')).toContain('fixture stderr');
    },
  );

  it.runIf(
    process.platform === 'win32' &&
      process.env['DREAMUX_RUN_WINDOWS_SERVICE_TEST'] === '1',
  )(
    'controls and self-restarts an isolated Interactive lifecycle fixture without surviving children',
    async () => {
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
      const pidFile = join(root, 'pids.json');
      const restartRequest = join(root, 'restart-request');
      const restartMarker = join(root, 'restart-marker.json');
      const launcher = join(root, 'launcher.mjs');
      await writeFile(
        launcher,
        `
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { controlWindowsService } from ${JSON.stringify(new URL('../dist/daemon/windows.js', import.meta.url).href)};
import { ExecaCommandRunner } from ${JSON.stringify(new URL('../dist/platform/command-runner.js', import.meta.url).href)};
import { notifyResumedRestart, RestartIntentConsumer } from ${JSON.stringify(new URL('../dist/service/dispatcher-service/restart-intent.js', import.meta.url).href)};
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
const marker = await RestartIntentConsumer.load({ now: Date.now(), path: ${JSON.stringify(restartMarker)}, log: { warn: console.error } });
await writeFile(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid, notice: marker.claim('fixture', Date.now()) }));
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
        await mkdir(join(root, 'state'));
        await mkdir(join(root, 'logs'));
        await writeFile(
          windowsServiceFile(),
          renderWindowsService(
            {
              ...answers,
              dreamuxBin: launcher,
              env: { ...answers.env, PATH: process.env['PATH'] },
            },
            join(root, 'logs', 'daemon.stdout.log'),
            join(root, 'logs', 'daemon.stderr.log'),
          ),
        );
        const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
        const fixtureRegistration = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute ${quote(answers.nodeBin)} -Argument ${quote(`"${windowsServiceFile()}"`)} -WorkingDirectory ${quote(join(root, 'state'))}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ${quote(taskName)} -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
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
            },
            { timeout: 15000 },
          );
        } catch (cause) {
          const stderr = await readFile(
            join(root, 'logs', 'daemon.stderr.log'),
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
      }
    },
    90000,
  );
});
