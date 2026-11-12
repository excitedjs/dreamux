import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsJob } from '@excitedjs/dreamux-utils';
import { describe, expect, it, vi } from 'vitest';

import { adminJsonInvoker } from '../src/admin/client.js';
import { createAdminSocketServer } from '../src/admin/socket.js';
import { controlWindowsService } from '../src/daemon/windows.js';
import type { WindowsTaskRegistration } from '../src/daemon/windows-task.js';
import type { CommandRunner } from '../src/platform/command-runner.js';
import { createLogger } from '../src/platform/logger.js';
import {
  adminSocketPath,
  windowsServiceJobName,
} from '../src/platform/paths.js';
import { deferred } from './helpers/controlled-runtime-provider.js';

// The product keeps its 30s startup deadline; allow additional fixture startup
// and native process cleanup without turning that deadline into a test timeout.
const NATIVE_CONTROL_TIMEOUT_MS = 45_000;
const entryModule = new URL('../dist/daemon/windows-entry.js', import.meta.url)
  .href;
const socketModule = new URL('../dist/admin/socket.js', import.meta.url).href;
const loggerModule = new URL('../dist/platform/logger.js', import.meta.url)
  .href;
const pathsModule = new URL('../dist/platform/paths.js', import.meta.url).href;

type ServiceEvent = {
  kind: 'ready' | 'status';
  generation: number;
  pid: number;
  childPid: number;
};

async function nativeServiceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-control-'));
  const serviceRoot = join(root, 'registered');
  const cliRoot = join(root, 'cli');
  const previousRoot = process.env['DREAMUX_ROOT'];
  const processes: { child: ChildProcess; closed: Promise<void> }[] = [];
  const timeline: string[] = [];
  let cleaning = false;
  const jobName = windowsServiceJobName(serviceRoot);
  const gatePath = (generation: number) =>
    join(root, `status-${generation}.ready`);
  const task: WindowsTaskRegistration = {
    name: 'Dreamux-owned-control-fixture',
    path: '\\Dreamux-owned-control-fixture',
    state: 4,
    enabled: true,
    lastResult: 0,
    workingDirectory: join(serviceRoot, 'state'),
    data: JSON.stringify({ environment: {}, execStart: [process.execPath] }),
  };
  try {
    await mkdir(task.workingDirectory, { recursive: true });
    await mkdir(join(serviceRoot, 'logs'));
    await mkdir(cliRoot);
    process.env['DREAMUX_ROOT'] = cliRoot;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  async function start(generation: number) {
    if (cleaning) throw new Error('Fixture is closing');
    const serverScript = `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdminSocketServer } from ${JSON.stringify(socketModule)};
import { createLogger } from ${JSON.stringify(loggerModule)};
import { adminSocketPath } from ${JSON.stringify(pathsModule)};
const descendant = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
  windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
});
await once(descendant, 'spawn');
const event = kind => console.log(JSON.stringify({
  kind, generation: ${generation}, pid: process.pid, childPid: descendant.pid,
}));
const admin = createAdminSocketServer({
  logger: createLogger({ destination: { write() {} } }),
  commands: {
    async invoke(_context, method) {
      if (method !== 'server.status') throw new Error('Unexpected fixture command');
      event('status');
      // Test-only release of a genuine response; its PID always comes from
      // the process owning this real admin endpoint.
      for (;;) {
        try { await access(${JSON.stringify(gatePath(generation))}); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(20);
      }
      return { pid: process.pid };
    },
  },
}, adminSocketPath());
await admin.start();
event('ready');
`;
    const registered = {
      ...task,
      data: JSON.stringify({
        environment: {},
        execStart: [
          process.execPath,
          '--input-type=module',
          '-e',
          serverScript,
        ],
      }),
    };
    const wrapper = `
import { runWindowsService } from ${JSON.stringify(entryModule)};
await runWindowsService(${JSON.stringify(task.name)}, {
  capture: async () => ${JSON.stringify(JSON.stringify(registered))},
  run: async () => { throw new Error('Unexpected service runner.run'); },
  check: async () => { throw new Error('Unexpected service runner.check'); },
});
`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', wrapper],
      {
        cwd: task.workingDirectory,
        env: { ...process.env },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    // A close fence still resolves after a spawn error; never close a handle
    // or remove the fixture directory merely because an error event fired.
    const closed = new Promise<void>((resolveClose) => {
      child.once('close', () => {
        timeline.push(`closed:${generation}`);
        resolveClose();
      });
    });
    processes.push({ child, closed });
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await once(child, 'spawn');
    const ready = await waitForEvent(generation, 'ready', () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Service fixture exited before readiness: ${stderr}`);
    });
    return { child, closed, ready };
  }

  async function waitForEvent(
    generation: number,
    kind: ServiceEvent['kind'],
    check?: () => void,
  ): Promise<ServiceEvent> {
    return vi.waitFor(
      async () => {
        check?.();
        let contents = '';
        try {
          contents = await readFile(
            join(serviceRoot, 'logs', 'daemon.stdout.log'),
            'utf8',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const lines = contents.split('\n');
        // Ignore the final, potentially incomplete write while the child is alive.
        const events = lines
          .slice(0, -1)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ServiceEvent);
        const event = events.find(
          (entry) => entry.generation === generation && entry.kind === kind,
        );
        if (!event)
          throw new Error(`Waiting for ${kind} from generation ${generation}`);
        return event;
      },
      { timeout: 10_000, interval: 25 },
    );
  }

  async function releaseStatus(generation: number) {
    await writeFile(gatePath(generation), '');
  }

  async function cleanup() {
    cleaning = true;
    try {
      try {
        const job = await WindowsJob.open(jobName);
        try {
          await job?.terminate();
        } finally {
          job?.close();
        }
      } finally {
        for (const { child } of processes) {
          if (child.exitCode === null && child.signalCode === null)
            child.kill();
        }
        await Promise.all(processes.map(({ closed }) => closed));
      }
      await rm(root, { recursive: true, force: true });
    } finally {
      if (previousRoot === undefined) delete process.env['DREAMUX_ROOT'];
      else process.env['DREAMUX_ROOT'] = previousRoot;
    }
  }
  return {
    root,
    serviceRoot,
    cliRoot,
    task,
    jobName,
    timeline,
    start,
    waitForEvent,
    releaseStatus,
    cleanup,
  };
}

function schedulerRunner(
  task: WindowsTaskRegistration,
  hooks: { stop(): Promise<void>; run(): Promise<void> },
) {
  const calls: string[] = [];
  let enabled = task.enabled;
  function script(command: string, args: string[]) {
    expect(command).toBe('powershell.exe');
    return Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  }
  // Observe only the native operations passed over the CommandRunner boundary.
  // No PowerShell runs here, and no production function is read or replaced.
  const capture = vi.fn<CommandRunner['capture']>(async (command, args) => {
    const code = script(command, args);
    if (code.includes('$task.Enabled = $false')) {
      calls.push('disable');
      const previous = enabled;
      enabled = false;
      return JSON.stringify(previous);
    }
    calls.push('read');
    return JSON.stringify(task);
  });
  const run = vi.fn<CommandRunner['run']>(async (command, args) => {
    const code = script(command, args);
    if (code.includes('$task.Stop(0)')) {
      calls.push('stop');
      await hooks.stop();
    } else if (code.includes('$task.Run($null)')) {
      calls.push('run');
      enabled = true;
      await hooks.run();
    } else {
      expect(code).toContain(`.Enabled = $${task.enabled ? 'true' : 'false'}`);
      calls.push('restore');
      enabled = task.enabled;
    }
  });
  const check = vi.fn<CommandRunner['check']>(async () => {
    throw new Error('Unexpected scheduler check');
  });
  return { runner: { capture, run, check }, calls, enabled: () => enabled };
}

describe.skipIf(process.platform !== 'win32')(
  'Windows service control ownership',
  () => {
    it(
      'waits for old exit and Scheduler Stop before Run, then requires the new owned admin response',
      async () => {
        const f = await nativeServiceFixture();
        const stopEntered = deferred<void>();
        const releaseStop = deferred<void>();
        let result:
          | Promise<{
              value?: Awaited<ReturnType<typeof controlWindowsService>>;
              error?: unknown;
            }>
          | undefined;
        let completed = false;
        try {
          await f.releaseStatus(1);
          const old = await f.start(1);
          const oldStatus = await adminJsonInvoker({
            socketPath: adminSocketPath(f.serviceRoot),
          }).invoke('server.status', {});
          expect(oldStatus).toEqual({ pid: old.ready.pid });
          const oldJob = await WindowsJob.open(f.jobName);
          try {
            expect(oldJob).not.toBeNull();
            expect(await oldJob!.containsProcess(old.ready.pid)).toBe(true);
            expect(await oldJob!.containsProcess(old.ready.childPid)).toBe(
              true,
            );
          } finally {
            oldJob?.close();
          }
          const scheduler = schedulerRunner(f.task, {
            async stop() {
              stopEntered.resolve();
              await releaseStop.promise;
            },
            async run() {
              f.timeline.push('run');
              await f.start(2);
            },
          });
          result = controlWindowsService(
            'restart',
            scheduler.runner,
            false,
          ).then(
            (value) => {
              completed = true;
              return { value };
            },
            (error) => {
              completed = true;
              return { error };
            },
          );
          await vi.waitFor(() => expect(scheduler.calls).toContain('stop'), {
            timeout: 10_000,
          });
          await stopEntered.promise;
          await vi.waitFor(() => expect(f.timeline).toContain('closed:1'), {
            timeout: 10_000,
          });
          await old.closed;
          expect(f.timeline).toContain('closed:1');
          expect(scheduler.calls).toEqual(['read', 'disable', 'stop']);
          expect(scheduler.enabled()).toBe(false);
          expect(completed).toBe(false);
          const reserved = await WindowsJob.open(f.jobName);
          try {
            expect(reserved).not.toBeNull();
            expect(await reserved!.containsProcess(old.ready.pid)).toBe(false);
            expect(await reserved!.containsProcess(old.ready.childPid)).toBe(
              false,
            );
          } finally {
            reserved?.close();
          }
          releaseStop.resolve();
          const statusRequest = await f.waitForEvent(2, 'status');
          expect(f.timeline.indexOf('closed:1')).toBeLessThan(
            f.timeline.indexOf('run'),
          );
          expect(scheduler.calls).toEqual([
            'read',
            'disable',
            'stop',
            'restore',
            'run',
          ]);
          expect(completed).toBe(false);
          expect(statusRequest.pid).not.toBe(old.ready.pid);
          await f.releaseStatus(2);
          const outcome = await result;
          expect(outcome.error).toBeUndefined();
          expect(outcome.value?.handedOff).toBe(false);
          const status = await adminJsonInvoker({
            socketPath: adminSocketPath(f.serviceRoot),
          }).invoke('server.status', {});
          expect(status).toEqual({ pid: statusRequest.pid });
          const newJob = await WindowsJob.open(f.jobName);
          try {
            expect(newJob).not.toBeNull();
            expect(await newJob!.containsProcess(statusRequest.pid)).toBe(true);
            expect(await newJob!.containsProcess(statusRequest.childPid)).toBe(
              true,
            );
          } finally {
            newJob?.close();
          }
          expect(f.cliRoot).not.toBe(f.serviceRoot);
          expect(process.env['DREAMUX_ROOT']).toBe(f.cliRoot);
          await expect(
            adminJsonInvoker({ socketPath: adminSocketPath(f.cliRoot) }).invoke(
              'server.status',
              {},
            ),
          ).rejects.toThrow();
        } finally {
          releaseStop.resolve();
          try {
            try {
              await f.releaseStatus(2);
            } finally {
              await result;
            }
          } finally {
            await f.cleanup();
          }
        }
      },
      NATIVE_CONTROL_TIMEOUT_MS,
    );

    it(
      'does not Run after Scheduler Stop fails and restores the previous disabled state',
      async () => {
        const f = await nativeServiceFixture();
        try {
          f.task.enabled = false;
          await f.releaseStatus(1);
          const old = await f.start(1);
          const failure = new Error('fixture Scheduler Stop failed');
          const scheduler = schedulerRunner(f.task, {
            async stop() {
              throw failure;
            },
            async run() {
              throw new Error('Run must not follow a failed Stop');
            },
          });
          await expect(
            controlWindowsService('restart', scheduler.runner, false),
          ).rejects.toBe(failure);
          await vi.waitFor(() => expect(f.timeline).toContain('closed:1'), {
            timeout: 10_000,
          });
          await old.closed;
          expect(scheduler.calls).toEqual([
            'read',
            'disable',
            'stop',
            'restore',
          ]);
          expect(scheduler.enabled()).toBe(false);
          expect(f.timeline).toEqual(['closed:1']);
          const job = await WindowsJob.open(f.jobName);
          try {
            expect(job).toBeNull();
          } finally {
            job?.close();
          }
        } finally {
          await f.cleanup();
        }
      },
      NATIVE_CONTROL_TIMEOUT_MS,
    );

    it(
      'rejects a real standalone admin server whose PID is outside the task Job',
      async () => {
        const f = await nativeServiceFixture();
        let job: WindowsJob | undefined;
        const admin = createAdminSocketServer(
          {
            logger: createLogger({ destination: { write() {} } }),
            commands: {
              async invoke(_context, method) {
                if (method !== 'server.status')
                  throw new Error('Unexpected fixture command');
                return { pid: process.pid };
              },
            },
          },
          adminSocketPath(f.serviceRoot),
        );
        try {
          job = await WindowsJob.create(f.jobName);
          await admin.start();
          expect(await job.containsProcess(process.pid)).toBe(false);
          const scheduler = schedulerRunner(f.task, {
            async stop() {
              throw new Error('Start must not Stop');
            },
            async run() {},
          });
          await expect(
            controlWindowsService('start', scheduler.runner, false),
          ).rejects.toThrow(
            'The responding server does not belong to the Windows service Job',
          );
          expect(scheduler.calls).toEqual(['read', 'run']);
          expect(
            await adminJsonInvoker({
              socketPath: adminSocketPath(f.serviceRoot),
            }).invoke('server.status', {}),
          ).toEqual({ pid: process.pid });
        } finally {
          try {
            await admin.close();
          } finally {
            try {
              await job?.terminate();
            } finally {
              job?.close();
              await f.cleanup();
            }
          }
        }
      },
      NATIVE_CONTROL_TIMEOUT_MS,
    );
  },
);
