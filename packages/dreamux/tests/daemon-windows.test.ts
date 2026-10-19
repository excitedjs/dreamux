import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

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

class WindowsRunner implements CommandRunner {
  calls: { command: string; script: string }[] = [];
  state = 'Running';
  installed = true;
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
        this.installed ? { taskName: 'Dreamux-fixture', launcher: null } : null,
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

function schedulerDiagnostic(
  stage: string,
  details: Record<string, unknown> = {},
) {
  console.error(
    `PR476_SCHEDULER_DIAG ${JSON.stringify({
      pid: process.pid,
      monotonicMs: performance.now(),
      stage,
      ...details,
    })}`,
  );
}

function scheduledTaskScriptRunner(installed: boolean, failSet = false) {
  schedulerDiagnostic('helper.enter', { installed, failSet });
  const calls: { command: string; parameters: Record<string, unknown> }[] = [];
  const run = vi.fn<CommandRunner['run']>(async (command, args, options) => {
    schedulerDiagnostic('runner.enter');
    if (run.mock.calls.length !== 1)
      throw new Error('Unexpected additional scheduler process');
    expect(command).toBe('powershell.exe');
    schedulerDiagnostic('runner.command.assert.end');
    const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le');
    // Only command binding and branching are real here, not Scheduler storage
    // or the reuse of a Password task's stored credentials.
    const shadowed = `
$fixtureClock = [System.Diagnostics.Stopwatch]::StartNew()
function Write-SchedulerDiagnostic($stage) {
  [Console]::Error.WriteLine(('PR476_SCHEDULER_PS_DIAG {{"pid":{0},"monotonicMs":{1},"stage":"{2}"}}' -f $PID, $fixtureClock.Elapsed.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture), $stage))
}
Write-SchedulerDiagnostic 'script.enter'
$PSModuleAutoLoadingPreference = 'None'
Write-SchedulerDiagnostic 'utility.import.begin'
Import-Module Microsoft.PowerShell.Utility
Write-SchedulerDiagnostic 'utility.import.end'
$fixtureCalls = [System.Collections.Generic.List[object]]::new()
$fixtureTaskName = 'Dreamux-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Record-SchedulerCall($command, $parameters) {
  Write-SchedulerDiagnostic ('cmdlet.' + $command)
  $values = @{} + $parameters
  $fixtureCalls.Add(@{ command = $command; parameters = $values })
  [pscustomobject]$values
}
function Get-ScheduledTask {
  [CmdletBinding()] param($TaskPath)
  $null = Record-SchedulerCall 'Get-ScheduledTask' $PSBoundParameters
  [pscustomobject]@{ TaskName = 'Dreamux-unrelated' }
  if ($${installed}) {
    [pscustomobject]@{
      TaskName = $fixtureTaskName
      Principal = @{ LogonType = 'Password'; RunLevel = 'Highest' }
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
function Register-ScheduledTask {
  [CmdletBinding()] param($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
  $null = Record-SchedulerCall 'Register-ScheduledTask' $PSBoundParameters
}
function Set-ScheduledTask {
  [CmdletBinding()] param($TaskName, $TaskPath, $Action, $Principal, $Trigger, $Settings, $User, $Password)
  $null = Record-SchedulerCall 'Set-ScheduledTask' $PSBoundParameters
  if ($${failSet}) { Write-Error 'fixture Set-ScheduledTask failed' }
}
Write-SchedulerDiagnostic 'shadows.ready'
try {
  Write-SchedulerDiagnostic 'generated.begin'
  & {
${script}
  }
  Write-SchedulerDiagnostic 'generated.end'
} finally {
  Write-SchedulerDiagnostic 'finally.json.begin'
  ConvertTo-Json -InputObject @($fixtureCalls.ToArray()) -Depth 10 -Compress
  Write-SchedulerDiagnostic 'finally.json.end'
}
`;
    schedulerDiagnostic('execa.call.begin');
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
    schedulerDiagnostic('execa.call.end', { childPid: child.pid });
    child.on('spawn', () => {
      schedulerDiagnostic('child.spawn', { childPid: child.pid });
    });
    child.on('exit', (code, signal) => {
      schedulerDiagnostic('child.exit', { childPid: child.pid, code, signal });
    });
    child.on('close', (code, signal) => {
      schedulerDiagnostic('child.close', { childPid: child.pid, code, signal });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      schedulerDiagnostic('child.stderr', {
        childPid: child.pid,
        chunk: chunk.toString(),
      });
    });
    onTestFinished(async () => {
      schedulerDiagnostic('finished.kill.begin', { childPid: child.pid });
      child.kill();
      schedulerDiagnostic('finished.kill.end', { childPid: child.pid });
      schedulerDiagnostic('finished.join.begin', { childPid: child.pid });
      await child;
      schedulerDiagnostic('finished.join.end', { childPid: child.pid });
    });
    schedulerDiagnostic('runner.await.begin');
    const result = await child;
    schedulerDiagnostic('runner.await.end', { exitCode: result.exitCode });
    schedulerDiagnostic('runner.json.begin');
    calls.push(...(JSON.parse(result.stdout) as typeof calls));
    schedulerDiagnostic('runner.json.end');
    if (result.exitCode !== 0) throw new Error(result.stderr);
    schedulerDiagnostic('runner.return');
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
    expect(runner.calls).toHaveLength(6);
    expect(runner.calls[0]?.command).toBe('powershell.exe');
    expect(runner.calls[0]?.script).toContain(
      '-LogonType Interactive -RunLevel Limited',
    );
    expect(runner.calls[0]?.script).toContain(
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
      it('updates only the action of an existing Password task', async () => {
        schedulerDiagnostic('test.begin', { case: 'existing' });
        const { runner, calls } = scheduledTaskScriptRunner(true);
        schedulerDiagnostic('test.register.begin');
        await registerWindowsService(windowsServiceFile(), runner, {
          ...answers,
          startService: false,
        });
        schedulerDiagnostic('test.register.end');
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
        schedulerDiagnostic('test.assertions.end', { case: 'existing' });
      }, 30_000);

      it('registers the original defaults when the task is missing', async () => {
        schedulerDiagnostic('test.begin', { case: 'missing' });
        const { runner, calls } = scheduledTaskScriptRunner(false);
        schedulerDiagnostic('test.register.begin');
        await registerWindowsService(windowsServiceFile(), runner, {
          ...answers,
          startService: false,
        });
        schedulerDiagnostic('test.register.end');
        expect(calls.map((call) => call.command).sort()).toEqual([
          'Get-ScheduledTask',
          'New-ScheduledTaskAction',
          'New-ScheduledTaskPrincipal',
          'New-ScheduledTaskSettingsSet',
          'New-ScheduledTaskTrigger',
          'Register-ScheduledTask',
        ]);
        const registration = calls.find(
          (call) => call.command === 'Register-ScheduledTask',
        )?.parameters;
        expect(registration).toEqual({
          TaskName: expect.stringMatching(/^Dreamux-S-1-/),
          Action: {
            Execute: answers.nodeBin,
            Argument: `"${windowsServiceFile()}"`,
            WorkingDirectory: join(root, 'state'),
          },
          Trigger: {
            AtLogOn: { IsPresent: true },
            User: expect.stringMatching(/^S-1-/),
          },
          Principal: {
            UserId: expect.stringMatching(/^S-1-/),
            LogonType: 'Interactive',
            RunLevel: 'Limited',
          },
          Settings: {
            ExecutionTimeLimit: expect.objectContaining({ TotalSeconds: 0 }),
            RestartCount: 999,
            RestartInterval: expect.objectContaining({ TotalSeconds: 60 }),
            MultipleInstances: 'IgnoreNew',
            AllowStartIfOnBatteries: { IsPresent: true },
            DontStopIfGoingOnBatteries: { IsPresent: true },
          },
          Force: { IsPresent: true },
        });
        schedulerDiagnostic('test.assertions.end', { case: 'missing' });
      }, 30_000);

      it('rejects an action update failure without registering or restarting', async () => {
        schedulerDiagnostic('test.begin', { case: 'set-failure' });
        const { runner, calls } = scheduledTaskScriptRunner(true, true);
        schedulerDiagnostic('test.register.begin');
        await expect(
          registerWindowsService(windowsServiceFile(), runner, {
            ...answers,
            startService: true,
          }),
        ).rejects.toThrow('fixture Set-ScheduledTask failed');
        schedulerDiagnostic('test.rejection.assert.end');
        expect(calls.map((call) => call.command).sort()).toEqual([
          'Get-ScheduledTask',
          'New-ScheduledTaskAction',
          'Set-ScheduledTask',
        ]);
        expect(runner.run).toHaveBeenCalledTimes(1);
        expect(runner.capture).not.toHaveBeenCalled();
        expect(runner.check).not.toHaveBeenCalled();
        schedulerDiagnostic('test.assertions.end', { case: 'set-failure' });
      }, 30_000);
    },
  );

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
    'controls and self-restarts an isolated task without surviving children',
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
        await installUserService({
          answers: {
            ...answers,
            dreamuxBin: launcher,
            env: { ...answers.env, PATH: process.env['PATH'] },
          },
          ledger: new TransparentFileLedger(),
          host: createServiceHost({ runner, platform: 'win32' }),
        });
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
