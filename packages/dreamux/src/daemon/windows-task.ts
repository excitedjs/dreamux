/** Task Scheduler registration and queries share one PowerShell boundary. */
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandRunner } from '../platform/command-runner.js';
import { stateRoot } from '../platform/paths.js';
import {
  managedServiceCommand,
  managedServiceEnvironment,
  type ServiceInstallAnswers,
} from './environment.js';
import { windowsCredentialScript } from './windows-credentials.js';

export interface WindowsTaskRegistration {
  name: string;
  path: string;
  state: number;
  enabled: boolean;
  lastResult: number;
  workingDirectory: string;
  data: string;
}

export interface WindowsServiceData {
  environment: Record<string, string>;
  execStart: string[];
}

export const windowsServiceEntryPath = fileURLToPath(
  new URL('./windows-entry.js', import.meta.url),
);

const TASK_IDENTITY = `
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskName = 'Dreamux-' + $user
`;

const QUERY_TASK = `
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$registered = $folder.GetTasks(1) | Where-Object Name -EQ $taskName
$definition = if ($null -ne $registered) { $registered.Definition } else { $null }
`;

export function windowsPowerShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
  );
}

export function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Encode Unicode scripts without invoking an intermediate shell. */
export function windowsPowerShellArgs(
  script: string,
  taskName?: string,
): string[] {
  const identity =
    taskName === undefined
      ? TASK_IDENTITY
      : `$taskName = ${psString(taskName)}\n`;
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    Buffer.from(
      `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n${identity}${script}`,
      'utf16le',
    ).toString('base64'),
  ];
}

export async function readWindowsTask(
  runner: CommandRunner,
  taskName?: string,
): Promise<WindowsTaskRegistration | null> {
  return JSON.parse(
    await runner.capture(
      'powershell.exe',
      windowsPowerShellArgs(
        `
${QUERY_TASK}
if ($null -eq $registered) { 'null' } else {
  @{
    name = [string]$registered.Name
    path = [string]$registered.Path
    state = [int]$registered.State
    enabled = [bool]$registered.Enabled
    lastResult = [int]$registered.LastTaskResult
    workingDirectory = [string]$definition.Actions.Item(1).WorkingDirectory
    data = [string]$definition.Data
  } | ConvertTo-Json -Compress
}
`,
        taskName,
      ),
      { env: windowsPowerShellEnvironment() },
    ),
  ) as WindowsTaskRegistration | null;
}

function invalidTaskData(): Error {
  return new Error(
    'The Windows service has missing or invalid task data. From a terminal outside the service, use the old version under the original Windows account and DREAMUX_ROOT to run "dreamux daemon uninstall", then upgrade and run "dreamux daemon install".',
  );
}

export function windowsTaskRoot(task: WindowsTaskRegistration): string {
  if (!isAbsolute(task.workingDirectory)) throw invalidTaskData();
  return dirname(task.workingDirectory);
}

export function windowsTaskData(
  task: WindowsTaskRegistration,
): WindowsServiceData {
  let value: unknown;
  try {
    value = JSON.parse(task.data);
  } catch {
    throw invalidTaskData();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidTaskData();
  const { environment, execStart } = value as Record<string, unknown>;
  if (
    typeof environment !== 'object' ||
    environment === null ||
    Array.isArray(environment) ||
    !Object.entries(environment).every(
      ([key, entry]) =>
        key.toUpperCase() !== 'DREAMUX_ROOT' && typeof entry === 'string',
    ) ||
    !Array.isArray(execStart) ||
    execStart.length === 0 ||
    !execStart.every((arg: unknown) => typeof arg === 'string') ||
    execStart[0] === ''
  ) {
    throw invalidTaskData();
  }
  return { environment, execStart } as WindowsServiceData;
}

/** Persist the action and its launch data together; starting belongs to control. */
export async function registerWindowsTask(
  runner: CommandRunner,
  answers: ServiceInstallAnswers,
): Promise<string> {
  if (answers.dryRun) return '\\Dreamux-<current-user-SID>';
  const environment = managedServiceEnvironment(answers);
  delete environment['DREAMUX_ROOT'];
  const data: WindowsServiceData = {
    environment,
    execStart: managedServiceCommand(answers, 'serve'),
  };
  return (
    await runner.capture(
      'powershell.exe',
      windowsPowerShellArgs(`
${QUERY_TASK}
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$installation = [Console]::In.ReadToEnd() | ConvertFrom-Json
$data = [string]$installation.data
$node = [string]$installation.node
$arguments = '"' + $installation.entry + '" "' + $taskName + '"'
$workingDirectory = [string]$installation.workingDirectory
if ($null -ne $definition -and $definition.Principal.LogonType -eq 1 -and [string]::Equals($definition.Data, $data, [StringComparison]::Ordinal)) {
  $action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $workingDirectory
  Set-ScheduledTask -TaskName $taskName -TaskPath '\\' -Action $action | Out-Null
} else {
${windowsCredentialScript}
  try {
    if ($null -eq $definition) {
      $definition = $scheduler.NewTask(0)
      $definition.RegistrationInfo.SecurityDescriptor = 'D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;' + $user + ')'
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
    }
    $definition.Actions.Clear()
    $action = $definition.Actions.Create(0)
    $action.Path = $node
    $action.Arguments = $arguments
    $action.WorkingDirectory = $workingDirectory
    $definition.Data = $data
    $definition.Principal.UserId = $user
    $definition.Principal.LogonType = 1
    Register-ScheduledTask -Xml $definition.XmlText -TaskName $taskName -TaskPath '\\' -User $credential.UserName -Password $credential.GetNetworkCredential().Password -Force | Out-Null
  } finally {
    $credential.Password.Dispose()
  }
}
[string]$folder.GetTask($taskName).Path
`),
      {
        env: windowsPowerShellEnvironment(),
        input: JSON.stringify({
          data: JSON.stringify(data),
          node: answers.nodeBin,
          entry: windowsServiceEntryPath,
          workingDirectory: resolve(stateRoot()),
        }),
      },
    )
  ).trim();
}
