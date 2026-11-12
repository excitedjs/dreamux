import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

import {
  managedServiceCommand,
  managedServiceEnvironment,
  type ServiceInstallAnswers,
} from '../src/daemon/environment.js';
import {
  psString,
  readWindowsTask,
  registerWindowsTask,
  windowsPowerShellArgs,
  windowsPowerShellEnvironment,
  windowsServiceEntryPath,
  windowsTaskData,
  windowsTaskRoot,
  type WindowsTaskRegistration,
} from '../src/daemon/windows-task.js';
import type { CommandRunner } from '../src/platform/command-runner.js';

const SCHEDULED_TASK_FIXTURE_TIMEOUT_MS = 30_000;
const CUSTOM_TASK_SECURITY_DESCRIPTOR = 'D:(A;;GA;;;SY)(A;;GRGX;;;BA)';

function scheduledTaskScriptRunner(
  logonType: 'Password' | 'Interactive' | null,
  workingDirectory: string,
  fixture: {
    data?: string;
    failSet?: boolean;
    failRegister?: boolean;
    promptError?: number;
    wrongAccount?: boolean;
  } = {},
) {
  const observed = {
    calls: [] as { command: string; parameters: Record<string, unknown> }[],
    prompt: {
      count: 0,
      flags: 0,
      message: '',
      errorCode: null as number | null,
    },
    stored: null as Record<string, unknown> | null,
  };
  const capture = vi.fn<CommandRunner['capture']>(
    async (command, args, options) => {
      if (capture.mock.calls.length !== 1)
        throw new Error('Unexpected additional scheduler process');
      expect(command).toBe('powershell.exe');
      const script = Buffer.from(args.at(-1) ?? '', 'base64').toString(
        'utf16le',
      );
      // Only NewTask(0) and definition properties use real COM, entirely in memory.
      // Connect, folder queries, persistence and CredUI are all replaced below.
      // Native packing/unpacking is real; the product's P/Invoke class compilation,
      // actual dialog, stored credentials and cross-session logon are not exercised.
      const shadowed = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module Microsoft.PowerShell.Utility
Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class DreamuxCredentialNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Info
    {
        public int Size;
        public IntPtr Parent;
        public string Message;
        public string Caption;
        public IntPtr Banner;
    }
    public static string Password = Guid.NewGuid().ToString() + "-密碼🔑";
    public static int PromptCount;
    public static uint PromptError = ${fixture.promptError ?? 0};
    public static uint PromptFlags;
    public static string PromptMessage;
    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr buffer, ref uint size);
    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size, IntPtr user, ref uint userChars, IntPtr domain, ref uint domainChars, IntPtr password, ref uint passwordChars);
    public static uint CredUIPromptForWindowsCredentialsW(ref Info info, uint error, ref uint package, IntPtr input, uint inputSize, out IntPtr output, out uint outputSize, IntPtr save, uint flags)
    {
        PromptCount++;
        PromptFlags = flags;
        PromptMessage = info.Message;
        output = IntPtr.Zero;
        outputSize = 0;
        if (PromptError != 0) return PromptError;
        string account = ${fixture.wrongAccount ? '"NT AUTHORITY\\\\SYSTEM"' : 'WindowsIdentity.GetCurrent().Name'};
        if (!CredPackAuthenticationBufferW(4, account, Password, IntPtr.Zero, ref outputSize) && Marshal.GetLastWin32Error() != 122)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        output = Marshal.AllocCoTaskMem((int)outputSize);
        if (!CredPackAuthenticationBufferW(4, account, Password, output, ref outputSize))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return 0;
    }
}
'@
# Keep the product's P/Invoke declarations from replacing the prompt substitute.
function Add-Type { [CmdletBinding()] param($TypeDefinition) }
$fixtureCalls = [System.Collections.Generic.List[object]]::new()
$fixtureTaskName = 'Dreamux-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fixturePassword = [DreamuxCredentialNative]::Password
$fixtureErrorCode = $null
$fixtureResult = ''
$fixtureFactory = Microsoft.PowerShell.Utility\\New-Object -ComObject 'Schedule.Service'
$fixtureExists = $${logonType !== null}
$initial = $fixtureFactory.NewTask(0)
$initial.Data = ${psString(fixture.data ?? '')}
$initial.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$initial.Principal.LogonType = ${logonType === 'Password' ? 1 : 3}
$initial.Principal.RunLevel = 1
$initial.RegistrationInfo.Description = 'operator-description'
$initial.RegistrationInfo.SecurityDescriptor = ${psString(CUSTOM_TASK_SECURITY_DESCRIPTOR)}
$initial.Settings.Enabled = $false
$initial.Settings.Hidden = $true
$initial.Settings.RestartCount = 7
$initial.Settings.RestartInterval = 'PT7M'
$initial.Settings.ExecutionTimeLimit = 'PT2H'
$initial.Settings.MultipleInstances = 2
$initial.Settings.DisallowStartIfOnBatteries = $true
$initial.Settings.StopIfGoingOnBatteries = $true
$initialAction = $initial.Actions.Create(0)
$initialAction.Path = 'old-action.exe'
$initialAction.Arguments = 'old-arguments'
$initialAction.WorkingDirectory = ${psString(workingDirectory)}
$initialTrigger = $initial.Triggers.Create(9)
$initialTrigger.UserId = $initial.Principal.UserId
$initialTrigger.Delay = 'PT2M'
$fixtureStoredXml = $initial.XmlText
function Record-SchedulerCall($command, $parameters) {
  $values = @{} + $parameters
  if ($values.ContainsKey('Password')) { $values.Password = $values.Password -eq $fixturePassword }
  $fixtureCalls.Add(@{ command = $command; parameters = $values })
}
function Test-CurrentAccount($account) {
  $sid = if ($account.StartsWith('S-1-')) { $account } else {
    [Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier]).Value
  }
  $sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function Get-FixtureTask {
  $definition = $fixtureFactory.NewTask(0)
  $definition.XmlText = $fixtureStoredXml
  [pscustomobject]@{
    Name = $fixtureTaskName
    Path = '\\' + $fixtureTaskName
    State = 4
    Enabled = $definition.Settings.Enabled
    LastTaskResult = 42
    Definition = $definition
  }
}
$fixtureFolder = [pscustomobject]@{}
$fixtureFolder | Add-Member ScriptMethod GetTasks {
  param($flags)
  Record-SchedulerCall 'GetTasks' @{ flags = $flags }
  [pscustomobject]@{ Name = 'Dreamux-unrelated' }
  if ($script:fixtureExists) { Get-FixtureTask }
}
$fixtureFolder | Add-Member ScriptMethod GetTask {
  param($name)
  Record-SchedulerCall 'GetTask' @{ name = $name }
  if (-not $script:fixtureExists -or $name -ne $script:fixtureTaskName) { throw 'Fixture task not registered' }
  Get-FixtureTask
}
$fixtureService = [pscustomobject]@{}
$fixtureService | Add-Member ScriptMethod Connect {
  Record-SchedulerCall 'Connect' @{}
}
$fixtureService | Add-Member ScriptMethod GetFolder {
  param($path)
  Record-SchedulerCall 'GetFolder' @{ path = $path }
  if ($path -ne '\\') { throw 'Unexpected task folder' }
  $script:fixtureFolder
}
$fixtureService | Add-Member ScriptMethod NewTask {
  param($flags)
  Record-SchedulerCall 'NewTask' @{ flags = $flags }
  $script:fixtureFactory.NewTask($flags)
}
function New-Object {
  [CmdletBinding()] param($ComObject)
  if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object' }
  $fixtureService
}
function New-ScheduledTaskAction {
  [CmdletBinding()] param($Execute, $Argument, $WorkingDirectory)
  Record-SchedulerCall 'New-ScheduledTaskAction' $PSBoundParameters
  [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
}
function Set-ScheduledTask {
  [CmdletBinding()] param($TaskName, $TaskPath, $Action)
  Record-SchedulerCall 'Set-ScheduledTask' $PSBoundParameters
  if ($${fixture.failSet ?? false}) { throw 'fixture Set-ScheduledTask failed' }
  if ($TaskName -ne $fixtureTaskName -or $TaskPath -ne '\\') { throw 'Unexpected task identity' }
  $definition = (Get-FixtureTask).Definition
  $definition.Actions.Clear()
  $updated = $definition.Actions.Create(0)
  $updated.Path = $Action.Execute
  $updated.Arguments = $Action.Argument
  $updated.WorkingDirectory = $Action.WorkingDirectory
  $script:fixtureStoredXml = $definition.XmlText
}
function Register-ScheduledTask {
  [CmdletBinding()] param($Xml, $TaskName, $TaskPath, $User, $Password, [switch]$Force)
  Record-SchedulerCall 'Register-ScheduledTask' $PSBoundParameters
  if ($${fixture.failRegister ?? false}) { throw 'fixture Register-ScheduledTask failed' }
  if ($TaskName -ne $fixtureTaskName -or $TaskPath -ne '\\') { throw 'Unexpected task identity' }
  $definition = $fixtureFactory.NewTask(0)
  $definition.XmlText = $Xml
  $script:fixtureStoredXml = $definition.XmlText
  $script:fixtureExists = $true
}
try {
  $fixtureResult = & {
${script}
  }
} catch {
  $fixtureErrorCode = $_.Exception.NativeErrorCode
  throw
} finally {
  $stored = $null
  if ($fixtureExists) {
    $definition = (Get-FixtureTask).Definition
    $action = $definition.Actions.Item(1)
    $trigger = $definition.Triggers.Item(1)
    $security = [Security.AccessControl.RawSecurityDescriptor]::new($definition.RegistrationInfo.SecurityDescriptor)
    $stored = @{
      data = $definition.Data
      action = @{ path = $action.Path; arguments = $action.Arguments; workingDirectory = $action.WorkingDirectory }
      principal = @{ currentAccount = Test-CurrentAccount $definition.Principal.UserId; logonType = $definition.Principal.LogonType; runLevel = $definition.Principal.RunLevel }
      description = $definition.RegistrationInfo.Description
      securityDescriptor = $definition.RegistrationInfo.SecurityDescriptor
      securityAces = @(foreach ($ace in $security.DiscretionaryAcl) {
        @{ sid = $ace.SecurityIdentifier.Value; accessMask = $ace.AccessMask; type = [int]$ace.AceType; flags = [int]$ace.AceFlags }
      })
      trigger = @{ type = $trigger.Type; currentAccount = Test-CurrentAccount $trigger.UserId; delay = $trigger.Delay }
      settings = @{
        enabled = $definition.Settings.Enabled
        hidden = $definition.Settings.Hidden
        restartCount = $definition.Settings.RestartCount
        restartInterval = $definition.Settings.RestartInterval
        executionTimeLimit = $definition.Settings.ExecutionTimeLimit
        multipleInstances = $definition.Settings.MultipleInstances
        disallowStartIfOnBatteries = $definition.Settings.DisallowStartIfOnBatteries
        stopIfGoingOnBatteries = $definition.Settings.StopIfGoingOnBatteries
      }
    }
  }
  @{
    stdout = [string]$fixtureResult
    calls = @($fixtureCalls.ToArray())
    stored = $stored
    prompt = @{ count = [DreamuxCredentialNative]::PromptCount; flags = [DreamuxCredentialNative]::PromptFlags; message = [DreamuxCredentialNative]::PromptMessage; errorCode = $fixtureErrorCode }
  } | ConvertTo-Json -Depth 12 -Compress
}
`;
      const scriptRoot = await mkdtemp(join(tmpdir(), 'dreamux-task-script-'));
      const childOptions = {
        ...(options?.env ? { env: options.env, extendEnv: false } : {}),
        ...(options?.input !== undefined ? { input: options.input } : {}),
        windowsHide: true,
        reject: false as const,
      };
      let child: import('execa').ResultPromise<typeof childOptions> | undefined;
      onTestFinished(async () => {
        try {
          if (child) {
            child.kill();
            await child;
          }
        } finally {
          await rm(scriptRoot, { recursive: true, force: true });
        }
      });
      const scriptPath = join(scriptRoot, 'task.ps1');
      await writeFile(scriptPath, '\uFEFF' + shadowed, 'utf8');
      child = execa(
        command,
        [...args.slice(0, -2), '-File', scriptPath],
        childOptions,
      );
      const result = await child;
      const output = JSON.parse(result.stdout) as typeof observed & {
        stdout: string;
      };
      Object.assign(observed, output);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return output.stdout;
    },
  );
  const run = vi.fn<CommandRunner['run']>(async () => {
    throw new Error('Unexpected scheduler run');
  });
  const check = vi.fn<CommandRunner['check']>(async () => {
    throw new Error('Unexpected scheduler check');
  });
  return { runner: { capture, run, check }, observed };
}

describe('Windows task data', () => {
  const data = {
    environment: { PATH: 'native-bin' },
    execStart: ['node', 'dreamux', 'serve'],
  };
  const task: WindowsTaskRegistration = {
    name: 'Dreamux-fixture',
    path: '\\Dreamux-fixture',
    state: 4,
    enabled: true,
    lastResult: 0,
    workingDirectory: resolve('fixture-root', 'state'),
    data: JSON.stringify(data),
  };

  it('uses the registered working directory and native task data', () => {
    expect(windowsTaskRoot(task)).toBe(resolve('fixture-root'));
    expect(windowsTaskData(task)).toEqual(data);
  });

  it.each([
    '',
    'invalid JSON',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...data, environment: { DREAMUX_ROOT: 'old-root' } }),
    JSON.stringify({ ...data, environment: { PATH: 4 } }),
    JSON.stringify({ ...data, execStart: [] }),
    JSON.stringify({ ...data, execStart: [null] }),
  ])('rejects absent, legacy or malformed data: %s', (invalid) => {
    expect(() => windowsTaskData({ ...task, data: invalid })).toThrow(
      'use the old version under the original Windows account and DREAMUX_ROOT',
    );
    expect(() => windowsTaskData({ ...task, data: invalid })).toThrow(
      'dreamux daemon uninstall',
    );
  });

  it('does not infer a root from an absent working directory', () => {
    expect(() => windowsTaskRoot({ ...task, workingDirectory: '' })).toThrow(
      'dreamux daemon uninstall',
    );
  });

  it('quotes Unicode task identities and removes inherited PSModulePath', () => {
    const args = windowsPowerShellArgs("'read-only'", "Dreamux-'測試");
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("$taskName = 'Dreamux-''測試'");
    expect(args).toContain('-NonInteractive');
    expect(
      windowsPowerShellEnvironment({
        PSModulePath: 'wrong',
        pSmOdUlEpAtH: 'wrong',
        HOME: 'fixture',
      }),
    ).toEqual({ HOME: 'fixture' });
  });
});

describe.skipIf(process.platform !== 'win32')(
  'Windows task registration and query',
  () => {
    let root: string;
    let previousRoot: string | undefined;
    let answers: ServiceInstallAnswers;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'dreamux-windows-task-'));
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
    function expectedData() {
      const environment = managedServiceEnvironment(answers);
      delete environment['DREAMUX_ROOT'];
      return {
        environment,
        execStart: managedServiceCommand(answers, 'serve'),
      };
    }
    function expectNoStart(runner: CommandRunner) {
      expect(runner.capture).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
      expect(runner.check).not.toHaveBeenCalled();
    }
    function expectPreserved(stored: Record<string, unknown> | null) {
      expect(stored).toMatchObject({
        description: 'operator-description',
        // This is the round-tripped in-memory definition, not a registered ACL.
        securityDescriptor: CUSTOM_TASK_SECURITY_DESCRIPTOR,
        principal: { runLevel: 1 },
        trigger: { type: 9, delay: 'PT2M' },
        settings: {
          enabled: false,
          hidden: true,
          restartCount: 7,
          restartInterval: 'PT7M',
          executionTimeLimit: 'PT2H',
          multipleInstances: 2,
          disallowStartIfOnBatteries: true,
          stopIfGoingOnBatteries: true,
        },
      });
    }

    it('returns the dry-run task path without launching a process', async () => {
      const { runner } = scheduledTaskScriptRunner(null, join(root, 'state'));
      expect(
        await registerWindowsTask(runner, { ...answers, dryRun: true }),
      ).toBe('\\Dreamux-<current-user-SID>');
      expect(runner.capture).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(runner.check).not.toHaveBeenCalled();
    });

    it(
      'queries status, Data and working directory from the same registered definition',
      async () => {
        const data = JSON.stringify(expectedData());
        const { runner, observed } = scheduledTaskScriptRunner(
          'Password',
          join(root, 'registered', 'state'),
          { data },
        );
        const task = await readWindowsTask(runner);
        expect(task).toEqual({
          name: expect.stringMatching(/^Dreamux-S-1-/),
          path: expect.stringMatching(/^\\Dreamux-S-1-/),
          state: 4,
          enabled: false,
          lastResult: 42,
          workingDirectory: join(root, 'registered', 'state'),
          data,
        });
        expect(windowsTaskRoot(task!)).toBe(join(root, 'registered'));
        expect(windowsTaskData(task!)).toEqual(expectedData());
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
        ]);
        expect(observed.prompt.count).toBe(0);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'returns null when the named task is absent',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          'Password',
          join(root, 'state'),
        );
        expect(await readWindowsTask(runner, 'Dreamux-absent')).toBeNull();
        expect(observed.prompt.count).toBe(0);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'updates only the action of an existing Password task with identical Data',
      async () => {
        const data = JSON.stringify(expectedData());
        const { runner, observed } = scheduledTaskScriptRunner(
          'Password',
          join(root, 'old-state'),
          { data },
        );
        const path = await registerWindowsTask(runner, answers);
        expect(path).toMatch(/^\\Dreamux-S-1-/);
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
          'New-ScheduledTaskAction',
          'Set-ScheduledTask',
          'GetTask',
        ]);
        expect(
          observed.calls.find((call) => call.command === 'Set-ScheduledTask')
            ?.parameters,
        ).toEqual({
          TaskName: path.slice(1),
          TaskPath: '\\',
          Action: {
            Execute: answers.nodeBin,
            Argument: `"${windowsServiceEntryPath}" "${path.slice(1)}"`,
            WorkingDirectory: join(root, 'state'),
          },
        });
        expect(observed.prompt.count).toBe(0);
        expect(observed.stored?.data).toBe(data);
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'registers a missing task with native XML containing both its action and Data',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          null,
          join(root, 'state'),
        );
        const path = await registerWindowsTask(runner, answers);
        const registration = observed.calls.find(
          (call) => call.command === 'Register-ScheduledTask',
        )?.parameters;
        expect(registration).toEqual({
          Xml: expect.stringContaining('<Data>'),
          TaskName: path.slice(1),
          TaskPath: '\\',
          User: expect.any(String),
          Password: true,
          Force: { IsPresent: true },
        });
        expect(observed.prompt).toMatchObject({
          count: 1,
          flags: 1,
          message: expect.stringContaining(
            'Windows account password (not PIN)',
          ),
          errorCode: null,
        });
        expect(JSON.parse(observed.stored?.data as string)).toEqual(
          expectedData(),
        );
        expect(observed.stored).toMatchObject({
          action: {
            path: answers.nodeBin,
            arguments: `"${windowsServiceEntryPath}" "${path.slice(1)}"`,
            workingDirectory: join(root, 'state'),
          },
          principal: {
            currentAccount: true,
            logonType: 1,
            runLevel: 0,
          },
          trigger: { type: 9, currentAccount: true },
          settings: {
            executionTimeLimit: 'PT0S',
            restartCount: 999,
            restartInterval: 'PT1M',
            multipleInstances: 2,
            disallowStartIfOnBatteries: false,
            stopIfGoingOnBatteries: false,
          },
        });
        expect(observed.stored?.securityAces).toHaveLength(3);
        expect(observed.stored?.securityAces).toEqual(
          expect.arrayContaining([
            { sid: 'S-1-5-18', accessMask: 0x10000000, type: 0, flags: 0 },
            { sid: 'S-1-5-32-544', accessMask: 0x10000000, type: 0, flags: 0 },
            {
              sid: path.slice('\\Dreamux-'.length),
              accessMask: 0x10000000,
              type: 0,
              flags: 0,
            },
          ]),
        );
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'persists a long Unicode PATH without putting it on the Windows command line',
      async () => {
        answers.env = {
          ...answers.env,
          PATH: Array.from(
            { length: 500 },
            (_, i) => `C:\\工具\\package-${i}\\bin`,
          ).join(';'),
        };
        const { runner, observed } = scheduledTaskScriptRunner(
          null,
          join(root, 'state'),
        );
        await registerWindowsTask(runner, answers);
        expect(JSON.parse(observed.stored?.data as string)).toEqual(
          expectedData(),
        );
        const [command, args] = runner.capture.mock.calls[0]!;
        expect([command, ...args].join(' ').length).toBeLessThan(32767);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it.each(['Interactive', 'Password'] as const)(
      'preserves the existing %s definition while saving changed Data and credentials once',
      async (logonType) => {
        const data = JSON.stringify(expectedData()).replace(
          'session-bin',
          'SESSION-BIN',
        );
        expect(data).not.toBe(JSON.stringify(expectedData()));
        const { runner, observed } = scheduledTaskScriptRunner(
          logonType,
          join(root, 'old-state'),
          { data },
        );
        await registerWindowsTask(runner, answers);
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
          'Register-ScheduledTask',
          'GetTask',
        ]);
        expect(observed.prompt.count).toBe(1);
        expect(
          observed.calls.find(
            (call) => call.command === 'Register-ScheduledTask',
          )?.parameters.Password,
        ).toBe(true);
        expect(observed.stored?.data).toBe(JSON.stringify(expectedData()));
        expect(observed.stored?.principal).toMatchObject({ logonType: 1 });
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'requests credentials for an existing Password task without Data',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          'Password',
          join(root, 'state'),
        );
        await registerWindowsTask(runner, answers);
        expect(observed.prompt.count).toBe(1);
        expect(
          observed.calls.filter(
            (call) => call.command === 'Register-ScheduledTask',
          ),
        ).toHaveLength(1);
        expect(observed.stored?.data).toBe(JSON.stringify(expectedData()));
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it.each([1223, 5])(
      'propagates native credential error %s before persisting or continuing',
      async (promptError) => {
        const { runner, observed } = scheduledTaskScriptRunner(
          null,
          join(root, 'state'),
          { promptError },
        );
        await expect(registerWindowsTask(runner, answers)).rejects.toThrow();
        expect(observed.prompt).toMatchObject({
          count: 1,
          errorCode: promptError,
        });
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
        ]);
        expect(observed.stored).toBeNull();
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'rejects a different account without changing the existing definition',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          'Interactive',
          join(root, 'state'),
          { wrongAccount: true, data: 'old-data' },
        );
        await expect(registerWindowsTask(runner, answers)).rejects.toThrow(
          'must use the current Windows account',
        );
        expect(observed.prompt.count).toBe(1);
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
        ]);
        expect(observed.stored?.data).toBe('old-data');
        expect(observed.stored?.principal).toMatchObject({ logonType: 3 });
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'rejects an action-only update failure without requesting credentials or continuing',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          'Password',
          join(root, 'old-state'),
          { data: JSON.stringify(expectedData()), failSet: true },
        );
        await expect(registerWindowsTask(runner, answers)).rejects.toThrow(
          'fixture Set-ScheduledTask failed',
        );
        expect(observed.prompt.count).toBe(0);
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
          'New-ScheduledTaskAction',
          'Set-ScheduledTask',
        ]);
        expect(observed.stored?.action).toMatchObject({
          path: 'old-action.exe',
          workingDirectory: join(root, 'old-state'),
        });
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );

    it(
      'rejects a credentialed XML registration failure without committing either change or continuing',
      async () => {
        const { runner, observed } = scheduledTaskScriptRunner(
          'Interactive',
          join(root, 'old-state'),
          { data: 'old-data', failRegister: true },
        );
        await expect(registerWindowsTask(runner, answers)).rejects.toThrow(
          'fixture Register-ScheduledTask failed',
        );
        expect(observed.prompt.count).toBe(1);
        expect(observed.calls.map((call) => call.command)).toEqual([
          'Connect',
          'GetFolder',
          'GetTasks',
          'Register-ScheduledTask',
        ]);
        expect(observed.stored?.data).toBe('old-data');
        expect(observed.stored?.action).toMatchObject({
          path: 'old-action.exe',
          workingDirectory: join(root, 'old-state'),
        });
        expect(observed.stored?.principal).toMatchObject({ logonType: 3 });
        expectPreserved(observed.stored);
        expectNoStart(runner);
      },
      SCHEDULED_TASK_FIXTURE_TIMEOUT_MS,
    );
  },
);
