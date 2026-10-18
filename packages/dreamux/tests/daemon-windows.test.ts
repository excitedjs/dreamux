import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { windowsPowerShellEnvironment } from '@excitedjs/dreamux-utils';

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
import { renderWindowsService } from '../src/daemon/windows.js';
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
    if (script.includes('$task.GetInstances(0)')) {
      return JSON.stringify(
        this.installed ? { enabled: true, pids: [] } : null,
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
    expect(runner.calls).toHaveLength(4);
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
      execStart: [answers.nodeBin, answers.dreamuxBin, 'serve'],
      environment: managedServiceEnvironment(answers),
    });
    runner.state = 'Ready';
    expect(
      (await getServiceStatus({ runner, platform: 'win32' })).running,
    ).toBe(false);
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
      const script = join(fixtureDir, 'daemon.ps1');
      await writeFile(
        script,
        renderWindowsService(
          { ...answers, dreamuxBin: kind === 'cmd' ? shim : launcher },
          stdout,
          stderr,
        ),
      );
      const result = await execa(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        {
          reject: false,
          windowsHide: true,
          env: windowsPowerShellEnvironment(),
          extendEnv: false,
        },
      );
      expect(result.exitCode).toBe(7);
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
    'repeatedly starts, stops, restarts and unregisters an isolated task without surviving children',
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
      const launcher = join(root, 'launcher.cjs');
      await writeFile(
        launcher,
        `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {windowsHide:true, stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);`,
      );
      const readPids = async () =>
        JSON.parse(await readFile(pidFile, 'utf8')) as {
          parent: number;
          child: number;
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
          answers: { ...answers, dreamuxBin: launcher },
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
    60000,
  );
});
