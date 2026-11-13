import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import koffi, { type KoffiFunc } from 'koffi';
import { describe, expect, it, vi } from 'vitest';

import { launchWindowsChild } from '../src/windows-child.js';
import { WindowsJob } from '../src/windows-job.js';

// Keep the real bootstrap, IPC, and native Job. The mock only captures the
// ChildProcess so faults can be scheduled after the real openRoot succeeds.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: vi.fn(actual.fork) };
});

function observeWrapper(pid: number, name: string) {
  const kernel = koffi.load('kernel32.dll');
  const openProcess = kernel.func(
    'void * __stdcall OpenProcess(uint32_t, int, uint32_t)',
  ) as KoffiFunc<
    (access: number, inherit: number, pid: number) => bigint | null
  >;
  const openJob = kernel.func(
    'void * __stdcall OpenJobObjectW(uint32_t, int, const char16_t *)',
  ) as KoffiFunc<
    (access: number, inherit: number, name: string) => bigint | null
  >;
  const member = kernel.func(
    'int __stdcall IsProcessInJob(void *, void *, _Out_ int *)',
  ) as KoffiFunc<(process: bigint, job: bigint, result: number[]) => number>;
  const wait = kernel.func(
    'uint32_t __stdcall WaitForSingleObject(void *, uint32_t)',
  ) as KoffiFunc<(handle: bigint, timeout: number) => number>;
  const close = kernel.func('int __stdcall CloseHandle(void *)') as KoffiFunc<
    (handle: bigint) => number
  >;
  const processHandle = openProcess(0x00100000 | 0x1000, 0, pid);
  if (processHandle === null) throw new Error('Cannot retain fixture wrapper');
  const jobHandle = openJob(0x0004, 0, name);
  if (jobHandle === null) {
    close(processHandle);
    throw new Error('Cannot observe fixture Job');
  }
  return {
    state: () => wait(processHandle, 0),
    inJob: () => {
      const result = [0];
      if (member(processHandle, jobHandle, result) === 0)
        throw new Error('Cannot query fixture Job membership');
      return result[0] !== 0;
    },
    waitForExit: () => promisify(wait.async)(processHandle, 5_000),
    close: () => {
      close(processHandle);
      close(jobHandle);
    },
  };
}

describe.skipIf(process.platform !== 'win32')(
  'native Windows bootstrap failure',
  () => {
    it.each(['crash', 'wrong challenge'] as const)(
      'rejects launch and releases the reserved Job after %s',
      async (fault) => {
        const root = await mkdtemp(join(tmpdir(), 'dreamux-bootstrap-fault-'));
        const marker = join(root, 'target-started');
        const name = `Local\\Dreamux-bootstrap-${randomUUID()}`;
        const actual =
          await vi.importActual<typeof import('node:child_process')>(
            'node:child_process',
          );
        const create = WindowsJob.create;
        const openRoot = WindowsJob.prototype.openRoot;
        let job: WindowsJob | undefined;
        let wrapper: ChildProcess | undefined;
        let closed: Promise<unknown> | undefined;
        let observed: ReturnType<typeof observeWrapper> | undefined;
        let before: { state: number; inJob: boolean } | undefined;
        let killed: boolean | undefined;
        let crashExit: number | undefined;
        let response:
          Promise<{ message: unknown[] } | { error: unknown }> | undefined;
        let launching: ReturnType<typeof launchWindowsChild> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        vi.spyOn(WindowsJob, 'create').mockImplementationOnce(async () => {
          job = await create(name);
          return job;
        });
        vi.mocked(fork).mockImplementationOnce((modulePath, args, options) => {
          wrapper = actual.fork(modulePath, args, options);
          // A spawn/IPC error must not reject the cleanup fence before close.
          closed = new Promise<void>((resolve) => {
            wrapper!.once('close', () => resolve());
          });
          return wrapper;
        });
        vi.spyOn(WindowsJob.prototype, 'openRoot').mockImplementationOnce(
          async function (this: WindowsJob, pid: number) {
            await openRoot.call(this, pid);
            observed = observeWrapper(pid, name);
            before = { state: observed.state(), inJob: observed.inJob() };
            if (fault === 'crash') {
              killed = wrapper!.kill();
              crashExit = await observed.waitForExit();
            } else {
              const send = wrapper!.send.bind(wrapper!);
              vi.spyOn(wrapper!, 'send').mockImplementationOnce(
                (message, ...args) => {
                  const challenge = (message as { challenge: string })
                    .challenge;
                  response = once(wrapper!, 'message', {
                    signal: AbortSignal.timeout(2_000),
                  }).then(
                    (message) => ({ message }),
                    (error: unknown) => ({ error }),
                  );
                  return send({ challenge: `${challenge}-wrong` }, ...args);
                },
              );
            }
          },
        );
        try {
          launching = launchWindowsChild({
            kind: 'spawn',
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
            ],
          });
          // Record failure without accepting a test assertion thrown in a hook.
          const failure = launching.then(
            () => undefined,
            (error: unknown) => error,
          );
          if (fault === 'wrong challenge') {
            await vi.waitFor(() => expect(response).toBeDefined());
            const echo = await response!;
            if ('error' in echo) throw echo.error;
            const [message] = echo.message as [{ challenge: string }];
            expect(message.challenge).toMatch(/-wrong$/);
            const outcome = await Promise.race([
              launching.then(
                () => 'started',
                () => 'rejected',
              ),
              new Promise<string>((resolve) => {
                deadline = setTimeout(() => resolve('pending'), 500);
              }),
            ]);
            expect(outcome).toBe('pending');
            expect(observed!.state()).toBe(258);
            expect(observed!.inJob()).toBe(false);
            await expect(readFile(marker)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            // A wrong response is ignored. Process exit supplies the real failure.
            killed = wrapper!.kill();
          }
          expect(await failure).toBeInstanceOf(Error);
          expect(before).toEqual({ state: 258, inJob: false });
          expect(killed).toBe(true);
          if (fault === 'crash') expect(crashExit).toBe(0);
          await closed;
          expect(observed!.state()).toBe(0);
          expect(observed!.inJob()).toBe(false);
          await expect(readFile(marker)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          observed!.close();
          observed = undefined;
          const remaining = await WindowsJob.open(name);
          try {
            expect(remaining).toBeNull();
          } finally {
            remaining?.close();
          }
        } finally {
          clearTimeout(deadline);
          if (wrapper?.exitCode === null && wrapper.signalCode === null)
            wrapper.kill();
          await closed;
          const launched = await launching?.catch(() => undefined);
          launched?.job.close();
          job?.close();
          observed?.close();
          vi.restoreAllMocks();
          await rm(root, { recursive: true, force: true });
        }
      },
      10_000,
    );
  },
);
