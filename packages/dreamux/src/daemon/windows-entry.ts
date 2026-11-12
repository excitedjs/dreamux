/** Published Task Action and external controller; never generated at install. */
import { appendFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SupervisedChild, WindowsJob } from '@excitedjs/dreamux-utils';

import {
  ExecaCommandRunner,
  type CommandRunner,
} from '../platform/command-runner.js';
import { logsRoot, windowsServiceJobName } from '../platform/paths.js';
import { controlWindowsService } from './windows.js';
import {
  readWindowsTask,
  windowsTaskData,
  windowsTaskRoot,
} from './windows-task.js';

export async function runWindowsService(
  taskName: string,
  runner: CommandRunner,
): Promise<void> {
  // Task Action.WorkingDirectory is <root>/state. Resolve logs and ownership
  // before the first child process that reads the task-owned launch data.
  const root = dirname(process.cwd());
  const stderr = await open(join(logsRoot(root), 'daemon.stderr.log'), 'a');
  try {
    const serviceJob = await WindowsJob.create(windowsServiceJobName(root));
    await serviceJob.assignCurrentProcess();
    // The entry owns this handle until process exit. Closing it early would
    // terminate this same process before its exit status and logs are complete.
    const task = await readWindowsTask(runner, taskName);
    if (task === null)
      throw new Error('Windows service task is not registered');
    if (
      resolve(windowsTaskRoot(task)).toLowerCase() !==
      resolve(root).toLowerCase()
    ) {
      throw new Error(
        'Windows service working directory differs from the registered task',
      );
    }
    const data = windowsTaskData(task);
    const stdout = await open(join(logsRoot(root), 'daemon.stdout.log'), 'a');
    try {
      const child = new SupervisedChild({
        kind: 'spawn',
        command: data.execStart[0],
        args: data.execStart.slice(1),
        options: {
          cwd: task.workingDirectory,
          env: { ...process.env, ...data.environment, DREAMUX_ROOT: root },
          stdio: ['ignore', stdout.fd, stderr.fd],
        },
      });
      const exited = new Promise<{ code: number | null }>(
        (resolveExit, reject) => {
          child.onExit(resolveExit);
          child.onError(reject);
        },
      );
      // start() can throw after also notifying onError. Observe that rejection
      // immediately, including when startup never reaches the await below.
      void exited.catch(() => {});
      try {
        await child.start();
        process.exitCode = (await exited).code ?? 1;
      } finally {
        await child.stop();
      }
    } finally {
      await stdout.close();
    }
  } catch (error) {
    await stderr.write(
      `${new Date().toISOString()} Windows daemon start failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await stderr.close();
  }
}

async function main(): Promise<void> {
  const taskName = process.argv[2];
  const verb = process.argv[3];
  if (
    !taskName ||
    (verb !== undefined && verb !== 'stop' && verb !== 'restart')
  ) {
    throw new Error(
      'This private entry is invoked by Windows service management',
    );
  }
  const runner = new ExecaCommandRunner();
  // Branch before service Job creation: this controller must survive the old
  // service. WMI supplies its registered WorkingDirectory, not the CLI's cwd.
  if (verb !== undefined) {
    runner.run = async (...args) => {
      await runner.capture(...args);
    };
    try {
      await controlWindowsService(verb, runner, false, taskName);
    } catch (error) {
      await appendFile(
        join(logsRoot(dirname(process.cwd())), 'daemon.stderr.log'),
        `${new Date().toISOString()} Windows daemon ${verb} failed: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  } else {
    await runWindowsService(taskName, runner);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
