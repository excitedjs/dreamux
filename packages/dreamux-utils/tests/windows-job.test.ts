import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import koffi, { type KoffiFunc } from 'koffi';
import { describe, expect, it, vi } from 'vitest';

import { WindowsJob } from '../src/windows-job.js';
import { launchWindowsChild } from '../src/windows-child.js';
import { SupervisedChild } from '../src/supervised-child.js';
import { isProcessAlive, killProcessGroup } from '../src/os.js';

const jobModule = new URL('../dist/windows-job.js', import.meta.url).href;
const supervisorModule = new URL('../dist/supervised-child.js', import.meta.url)
  .href;

async function fixtureHost(
  name?: string,
  cwd = process.cwd(),
): Promise<{ host: ChildProcess; pids: number[] }> {
  const host = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { WindowsJob } from ${JSON.stringify(jobModule)};
    import { SupervisedChild } from ${JSON.stringify(supervisorModule)};
    ${name === undefined ? '' : `const job = await WindowsJob.create(${JSON.stringify(name)}); await job.assignCurrentProcess();`}
    const child = new SupervisedChild({ kind: 'spawn', command: process.execPath, args: ['-e', ${JSON.stringify(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      grandchild.once('spawn', () => console.log(JSON.stringify([process.pid, grandchild.pid])));
      setInterval(() => {}, 1000);
    `)}] });
    const proc = await child.start();
    proc.stdout.once('data', data => process.stdout.write(data));
  `,
    ],
    { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  host.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const pids = await new Promise<number[]>((resolve, reject) => {
    host.stdout!.once('data', (data) =>
      resolve(JSON.parse(String(data)) as number[]),
    );
    host.once('error', reject);
    host.once('exit', (code) =>
      reject(new Error(`fixture host exited ${code}: ${stderr}`)),
    );
  });
  return { host, pids };
}

// A PID can already fail kill(0) while its terminating process still holds cwd.
// Retain each exact native object before shutdown and check its completion signal.
function retainProcesses(pids: number[]) {
  const kernel = koffi.load('kernel32.dll');
  const open = kernel.func(
    'void * __stdcall OpenProcess(uint32_t, int, uint32_t)',
  ) as KoffiFunc<
    (access: number, inherit: number, pid: number) => bigint | null
  >;
  const wait = kernel.func(
    'uint32_t __stdcall WaitForSingleObject(void *, uint32_t)',
  ) as KoffiFunc<(handle: bigint, timeout: number) => number>;
  const close = kernel.func('int __stdcall CloseHandle(void *)') as KoffiFunc<
    (handle: bigint) => number
  >;
  const handles: bigint[] = [];
  try {
    for (const pid of pids) {
      const handle = open(0x00100000, 0, pid);
      if (handle === null)
        throw new Error('Fixture process handle unavailable');
      handles.push(handle);
    }
  } catch (error) {
    for (const handle of handles) close(handle);
    throw error;
  }
  return {
    states: () => handles.map((handle) => wait(handle, 0)),
    dispose: async () => {
      try {
        for (const handle of handles)
          await promisify(wait.async)(handle, 0xffffffff);
      } finally {
        for (const handle of handles) close(handle);
      }
    },
  };
}

describe.skipIf(process.platform !== 'win32')(
  'native Windows Job ownership',
  () => {
    it('waits for all 256 native members without overflowing the async call queue', async () => {
      const { child, job } = await launchWindowsChild({
        kind: 'spawn',
        command: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          `
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const children = [];
for (let index = 0; index < 254; index++) {
  const child = spawn(process.env.ComSpec, ['/d', '/c', 'set /p input='], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  children.push(child);
  await once(child, 'spawn');
}
console.log(JSON.stringify([process.pid, ...children.map(child => child.pid)]));
setInterval(() => {}, 1000);
`,
        ],
      });
      const closed = once(child, 'close');
      let held: ReturnType<typeof retainProcesses> | undefined;
      try {
        const [output] = await once(child.stdout!, 'data', {
          signal: AbortSignal.timeout(20_000),
        });
        const pids = [child.pid!, ...(JSON.parse(String(output)) as number[])];
        expect(pids).toHaveLength(256);
        held = retainProcesses(pids);
        expect(held.states()).toEqual(Array<number>(256).fill(258));
        await job.terminate();
        // Check exact retained objects immediately, before any extra event wait.
        expect(held.states()).toEqual(Array<number>(256).fill(0));
      } finally {
        // Closing this isolated Job also kills the tree if readiness or stop fails.
        job.close();
        await closed;
        await held?.dispose();
      }
    }, 30_000);

    it('distinguishes the current process from a child assigned to the exact Job', async () => {
      const name = `Local\\Dreamux-membership-${randomUUID()}`;
      const job = await WindowsJob.create(name);
      try {
        expect(await job.containsCurrentProcess()).toBe(false);
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
import { WindowsJob } from ${JSON.stringify(jobModule)};
const job = await WindowsJob.acquire(${JSON.stringify(name)});
await job.assignCurrentProcess();
console.log(await job.containsCurrentProcess());
`,
          ],
          { windowsHide: true },
        );
        expect(stdout.trim()).toBe('true');
        expect(await job.containsCurrentProcess()).toBe(false);
      } finally {
        await job.terminate();
        job.close();
      }
    });

    it('refuses PID-only Windows tree termination without touching the process', async () => {
      await expect(killProcessGroup(process.pid, 'SIGKILL')).rejects.toThrow(
        'launch-owned Job',
      );
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('does not attach to or alter an existing named Job', async () => {
      const name = `Local\\Dreamux-test-${randomUUID()}`;
      const job = await WindowsJob.create(name);
      try {
        await expect(WindowsJob.create(name)).rejects.toThrow('already exists');
        const opened = await WindowsJob.open(name);
        expect(opened).not.toBeNull();
        await opened!.terminate();
        opened!.close();
      } finally {
        job.close();
      }
      expect(await WindowsJob.open(name)).toBeNull();
    });

    it('reserves a missing service Job so a late startup cannot launch target work', async () => {
      const name = `Local\\Dreamux-test-${randomUUID()}`;
      const reserved = await WindowsJob.acquire(name);
      const host = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { WindowsJob } from ${JSON.stringify(jobModule)};
      const job = await WindowsJob.create(${JSON.stringify(name)});
      await job.assignCurrentProcess();
      console.log('target work started');
    `,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      host.stdout!.on('data', (chunk) => {
        stdout += String(chunk);
      });
      host.stderr!.on('data', (chunk) => {
        stderr += String(chunk);
      });
      try {
        const [code] = await once(host, 'close');
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('Windows Job already exists');
        await reserved.terminate();
        reserved.close();
        expect(await WindowsJob.open(name)).toBeNull();
      } finally {
        reserved.close();
        if (host.exitCode === null && host.signalCode === null) host.kill();
      }
    });

    it('kernel cleanup terminates descendants when their owning host dies', async () => {
      const { host, pids } = await fixtureHost();
      try {
        const closed = once(host, 'close');
        host.kill(); // ChildProcess retains the handle of this exact fixture host.
        await closed;
        await vi.waitFor(() =>
          expect(pids.map(isProcessAlive)).toEqual([false, false]),
        );
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill();
      }
    });

    it('a separately opened service Job waits for the entire nested tree to exit', async () => {
      const name = `Local\\Dreamux-test-${randomUUID()}`;
      const root = await mkdtemp(join(tmpdir(), 'dreamux-job-completion-'));
      const { host, pids } = await fixtureHost(name, root);
      const job = await WindowsJob.acquire(name);
      const held = retainProcesses([host.pid!, ...pids]);
      const closed = once(host, 'close');
      try {
        expect(job).not.toBeNull();
        await job!.terminate();
        // No extra close event or polling may make an early terminate() pass.
        expect(held.states()).toEqual([0, 0, 0]);
        await rm(root, { recursive: true, force: true });
        expect(pids.map(isProcessAlive)).toEqual([false, false]);
      } finally {
        job?.close();
        if (host.exitCode === null && host.signalCode === null) host.kill();
        await closed;
        await held.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('supervised stop releases its process objects and cwd before returning', async () => {
      const root = await mkdtemp(
        join(tmpdir(), 'dreamux-supervised-completion-'),
      );
      const owner = new SupervisedChild({
        kind: 'spawn',
        command: process.execPath,
        args: ['-e', 'console.log(process.pid); process.stdin.resume();'],
        options: { cwd: root },
      });
      const child = await owner.start();
      const closed = once(child, 'close');
      const [output] = await once(child.stdout!, 'data');
      const held = retainProcesses([child.pid!, Number(String(output))]);
      try {
        await owner.stop();
        expect(held.states()).toEqual([0, 0]);
        await rm(root, { recursive: true, force: true });
      } finally {
        await owner.stop();
        await closed;
        await held.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
