/** Windows managed-service control and completion, separate from registration. */
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsJob } from '@excitedjs/dreamux-utils';

import { AdminClientError, adminJsonInvoker } from '../admin/client.js';
import type { CommandRunner } from '../platform/command-runner.js';
import { TransportError } from '../platform/errors.js';
import { adminSocketPath, windowsServiceJobName } from '../platform/paths.js';
import { SERVER_SHUTDOWN_DEADLINE_MS } from '../server/shutdown.js';
import type { ServiceInstallAnswers } from './environment.js';
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
} from './windows-task.js';

const STARTUP_TIMEOUT_MS = 30_000;

export async function assertWindowsServiceInstallable(
  runner: CommandRunner,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const task = await readWindowsTask(runner);
  if (task === null) return;
  // Old launchers carry their actual Local/Global ownership in generated code.
  // Refuse that format rather than guessing an identity from its working dir.
  windowsTaskData(task);
  if (
    [2, 4].includes(task.state) &&
    windowsServiceJobName(windowsTaskRoot(task)) !== windowsServiceJobName()
  ) {
    throw new Error(
      'Stop the existing Windows service from a terminal outside the service before installing with a different root. Run "dreamux daemon stop", then run "dreamux daemon install" again.',
    );
  }
}

export async function registerWindowsService(
  runner: CommandRunner,
  answers: ServiceInstallAnswers,
): Promise<{ path: string; handedOff: boolean }> {
  const path = await registerWindowsTask(runner, answers);
  const control = answers.startService
    ? await controlWindowsService('restart', runner, answers.dryRun)
    : undefined;
  return { path, handedOff: control?.handedOff ?? false };
}

export async function windowsServiceRoot(
  runner: CommandRunner,
): Promise<string> {
  const task = await readWindowsTask(runner);
  if (task === null) throw new Error('Windows service is not installed');
  windowsTaskData(task);
  return windowsTaskRoot(task);
}

export async function controlWindowsService(
  verb: 'start' | 'stop' | 'restart',
  runner: CommandRunner,
  dryRun: boolean,
  taskName?: string,
): Promise<{
  commands: Array<{ command: string; args: string[] }>;
  handedOff: boolean;
}> {
  const commands: Array<{ command: string; args: string[] }> = [];
  if (dryRun) return { commands, handedOff: false };
  const task = await readWindowsTask(runner, taskName);
  if (task === null) {
    if (verb === 'stop') return { commands, handedOff: false };
    throw new Error(
      'Windows service is not installed; run dreamux daemon install',
    );
  }
  windowsTaskData(task);
  const root = windowsTaskRoot(task);
  if (verb !== 'start') {
    const job = await WindowsJob.open(windowsServiceJobName(root), 'query');
    let self = false;
    try {
      self = (await job?.containsCurrentProcess()) ?? false;
    } finally {
      job?.close();
    }
    if (self) {
      commands.push(await handOffWindowsControl(verb, task, runner));
      return { commands, handedOff: true };
    }
    commands.push(...(await stopWindowsService(task, runner)));
  }
  if (verb !== 'stop') {
    const command = {
      command: 'powershell.exe',
      args: windowsPowerShellArgs(
        `
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\\').GetTask($taskName)
$task.Enabled = $true
$instance = $task.Run($null)
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($instance.State -eq 2 -and $clock.ElapsedMilliseconds -lt ${STARTUP_TIMEOUT_MS}) {
  Start-Sleep -Milliseconds 100
}
if ($instance.State -ne 4) { throw 'Windows service task did not enter Running state' }
`,
        task.name,
      ),
    };
    await runner.run(command.command, command.args, {
      env: windowsPowerShellEnvironment(),
    });
    commands.push(command);
    await waitForWindowsService(task);
  }
  return { commands, handedOff: false };
}

async function queryServerPid(
  socketPath: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const response = (await adminJsonInvoker({ socketPath, timeoutMs }).invoke(
      'server.status',
      {},
    )) as { pid?: number };
    if (typeof response.pid !== 'number') {
      throw new Error('server.status did not report a numeric process ID');
    }
    return response.pid;
  } catch (error) {
    if (error instanceof TransportError) return null;
    throw error;
  }
}

async function waitForWindowsService(
  task: WindowsTaskRegistration,
): Promise<void> {
  const root = windowsTaskRoot(task);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Observation must not reserve the name that the new entry needs to create.
    const job = await WindowsJob.open(windowsServiceJobName(root), 'query');
    try {
      if (job !== null) {
        const pid = await queryServerPid(
          adminSocketPath(root),
          Math.max(1, Math.min(1000, deadline - Date.now())),
        );
        if (pid !== null) {
          if (!(await job.containsProcess(pid))) {
            throw new Error(
              'The responding server does not belong to the Windows service Job',
            );
          }
          return;
        }
      }
    } finally {
      job?.close();
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `Windows service did not respond within ${STARTUP_TIMEOUT_MS}ms (${adminSocketPath(root)})`,
  );
}

async function handOffWindowsControl(
  verb: 'stop' | 'restart',
  task: WindowsTaskRegistration,
  runner: CommandRunner,
): Promise<{ command: string; args: string[] }> {
  // WMI starts outside the caller's Job. Only the published control branch runs;
  // it must never join the service Job that it is about to terminate.
  const commandLine = `"${process.execPath}" "${windowsServiceEntryPath}" "${task.name}" ${verb}`;
  const command = {
    command: 'powershell.exe',
    args: windowsPowerShellArgs(`
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$created = ([wmiclass]'Win32_Process').Create(${psString(commandLine)}, ${psString(task.workingDirectory)}, $startup)
if ($created.ReturnValue -ne 0) { throw "Windows service controller creation failed ($($created.ReturnValue))" }
`),
  };
  await runner.run(command.command, command.args, {
    env: windowsPowerShellEnvironment(),
  });
  return command;
}

async function requestWindowsServiceShutdown(
  task: WindowsTaskRegistration,
  job: WindowsJob,
): Promise<void> {
  const socketPath = adminSocketPath(windowsTaskRoot(task));
  const pid = await queryServerPid(socketPath, 1000);
  if (pid === null) return;
  const member = await job.retainMember(pid);
  if (member === null) return; // It exited after replying to status.
  try {
    const deadline = Date.now() + SERVER_SHUTDOWN_DEADLINE_MS;
    try {
      await adminJsonInvoker({
        socketPath,
        timeoutMs: SERVER_SHUTDOWN_DEADLINE_MS,
      }).invoke('server.shutdown', { expectedPid: pid });
    } catch (error) {
      // An older installed server cannot cooperate. A lost response, however,
      // may follow an accepted request, so still grant the remaining time.
      if (error instanceof AdminClientError && error.code === 'UNKNOWN_METHOD')
        return;
      if (!(error instanceof TransportError)) throw error;
    }
    await member.waitForExit(Math.max(0, deadline - Date.now()));
  } finally {
    member.close();
  }
}

async function stopWindowsService(
  task: WindowsTaskRegistration,
  runner: CommandRunner,
): Promise<Array<{ command: string; args: string[] }>> {
  const disable = {
    command: 'powershell.exe',
    args: windowsPowerShellArgs(
      `
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\\').GetTask($taskName)
$enabled = $task.Enabled
$task.Enabled = $false
$enabled | ConvertTo-Json -Compress
`,
      task.name,
    ),
  };
  const enabled = JSON.parse(
    await runner.capture(disable.command, disable.args, {
      env: windowsPowerShellEnvironment(),
    }),
  ) as boolean;
  const stop = {
    command: 'powershell.exe',
    args: windowsPowerShellArgs(
      `
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = $scheduler.GetFolder('\\').GetTask($taskName)
$task.Stop(0)
$clock = [Diagnostics.Stopwatch]::StartNew()
while (($task.State -eq 2 -or $task.State -eq 4 -or $task.GetInstances(0).Count -ne 0) -and $clock.ElapsedMilliseconds -lt 30000) {
  Start-Sleep -Milliseconds 100
}
if ($task.State -eq 2 -or $task.State -eq 4 -or $task.GetInstances(0).Count -ne 0) {
  throw 'Windows service task still has running instances after Stop'
}
`,
      task.name,
    ),
  };
  const restore = {
    command: 'powershell.exe',
    args: windowsPowerShellArgs(
      `
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$scheduler.GetFolder('\\').GetTask($taskName).Enabled = $${enabled ? 'true' : 'false'}
`,
      task.name,
    ),
  };
  let job: WindowsJob | null = null;
  try {
    // Reserve the name even when the entry has not created it yet. The disabled
    // task and reservation fence late startup until the task instance is stopped.
    job = await WindowsJob.acquire(
      windowsServiceJobName(windowsTaskRoot(task)),
    );
    try {
      try {
        await requestWindowsServiceShutdown(task, job);
      } finally {
        // Cooperative exit does not prove that every provider child is gone.
        await job.terminate();
      }
    } finally {
      await runner.run(stop.command, stop.args, {
        env: windowsPowerShellEnvironment(),
      });
    }
  } finally {
    job?.close();
    await runner.run(restore.command, restore.args, {
      env: windowsPowerShellEnvironment(),
    });
  }
  return [disable, stop, restore];
}

export async function unregisterWindowsService(
  runner: CommandRunner,
  dryRun: boolean,
): Promise<{ unitPath: string; removed: boolean }> {
  if (dryRun)
    return { unitPath: '\\Dreamux-<current-user-SID>', removed: false };
  const task = await readWindowsTask(runner);
  if (task === null)
    return { unitPath: '\\Dreamux-<current-user-SID>', removed: false };
  windowsTaskData(task);
  const job = await WindowsJob.open(
    windowsServiceJobName(windowsTaskRoot(task)),
    'query',
  );
  try {
    if (await job?.containsCurrentProcess()) {
      throw new Error(
        'Uninstall the Windows service from a terminal outside the service',
      );
    }
  } finally {
    job?.close();
  }
  await stopWindowsService(task, runner);
  await runner.run(
    'powershell.exe',
    windowsPowerShellArgs(
      `
Unregister-ScheduledTask -TaskName $taskName -TaskPath '\\' -Confirm:$false
`,
      task.name,
    ),
    { env: windowsPowerShellEnvironment() },
  );
  return { unitPath: task.path, removed: true };
}

export async function windowsServiceStatus(runner: CommandRunner) {
  const task = await readWindowsTask(runner);
  const data = task === null ? null : windowsTaskData(task);
  return {
    platform: 'windows' as const,
    unitPath: task?.path ?? '\\Dreamux-<current-user-SID>',
    installed: task !== null,
    loaded: task !== null,
    running: task?.state === 4,
    enabled: task?.enabled ?? false,
    pid: null,
    detail:
      task === null
        ? 'task not registered'
        : `${['Unknown', 'Disabled', 'Queued', 'Ready', 'Running'][task.state] ?? task.state}, last result=${task.lastResult}`,
    environment:
      data === null || task === null
        ? null
        : { ...data.environment, DREAMUX_ROOT: resolve(windowsTaskRoot(task)) },
    execStart: data?.execStart ?? null,
  };
}
