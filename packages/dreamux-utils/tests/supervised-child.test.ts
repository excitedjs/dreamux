/**
 * Supervised child-process lifecycle (supervised-child.ts): start, unexpected
 * exit, launch failure, and two-stage (SIGTERM then SIGKILL) stop convergence.
 *
 * Hermetic: every child is `node -e '...'`, never a real Codex/Claude binary.
 * Real timers are used for the SIGTERM->SIGKILL escalation because it exercises
 * a real detached process group, not application-level scheduling; the timeout
 * is kept small (~150ms) so the test stays fast. Every started child is force
 * -killed in afterEach even on assertion failure, so a leftover ignore-SIGTERM
 * child can never survive the test process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SupervisedChild,
  type SupervisedChildExit,
} from '../src/supervised-child.js';
import {
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
} from '../src/os.js';

describe('SupervisedChild', () => {
  const started: SupervisedChild[] = [];

  afterEach(async () => {
    for (const child of started.splice(0)) {
      try {
        await child.stop();
      } catch {
        /* best-effort cleanup even if the test already exercised stop() */
      }
      // Belt-and-suspenders: force-kill by pid if stop() somehow didn't land,
      // so a runaway child can never outlive the test.
      if (child.pid !== null && isProcessGroupAlive(child.pid)) {
        try {
          await killProcessGroup(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  function makeChild(
    script: string,
    options?: ConstructorParameters<typeof SupervisedChild>[1],
  ) {
    const child = new SupervisedChild(
      { kind: 'spawn', command: process.execPath, args: ['-e', script] },
      options,
    );
    started.push(child);
    return child;
  }

  it('start() resolves with a live child and publishes its pid', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    const proc = await child.start();
    expect(child.pid).toBe(proc.pid);
    expect(child.pid).not.toBeNull();
  });

  it('forks a module in a path with spaces and preserves IPC and arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dreamux fork spaces '));
    const modulePath = join(root, 'child.cjs');
    await writeFile(
      modulePath,
      'process.send(process.argv.slice(2)); setInterval(() => {}, 1000)',
    );
    const args = ['path with spaces', '{"value":"a b"}'];
    const child = new SupervisedChild({
      kind: 'fork',
      modulePath,
      args,
      options: { silent: true },
    });
    started.push(child);
    try {
      const proc = await child.start();
      const [message] = await once(proc, 'message');
      expect(message).toEqual(args);
    } finally {
      await child.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('calling start() twice on the same instance throws', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await child.start();
    await expect(child.start()).rejects.toThrow(
      'SupervisedChild.start: already started',
    );
  });

  it('calling start() after stop() throws', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await child.start();
    await child.stop();
    await expect(child.start()).rejects.toThrow(
      'SupervisedChild.start: already stopped',
    );
  });

  it('stop() before start() resolves without throwing', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await expect(child.stop()).resolves.toBeUndefined();
  });

  it('stop() joins a pending launch and reaps the child before returning', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    const start = child.start();
    const rejection = expect(start).rejects.toThrow('stopped during start');
    await child.stop();
    await rejection;
    expect(child.pid).toBeNull();
  });

  it('stop() is idempotent: a second concurrent call returns the same in-flight promise', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await child.start();
    const first = child.stop();
    const second = child.stop();
    expect(second).toBe(first);
    await first;
  });

  it('a bogus command rejects start() and also notifies onError', async () => {
    const child = new SupervisedChild({
      kind: 'spawn',
      command: '/definitely/not/a/real/binary/dreamux-utils-test',
    });
    started.push(child);
    const errors: Error[] = [];
    child.onError((error) => errors.push(error));
    await expect(child.start()).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('onExit fires with the exit code when the child exits on its own', async () => {
    const child = makeChild('process.exit(7)');
    const exits: SupervisedChildExit[] = [];
    child.onExit((exit) => exits.push(exit));
    await child.start();
    await new Promise<void>((resolve) => {
      const unsubscribe = child.onExit((exit) => {
        exits.push(exit);
        unsubscribe();
        resolve();
      });
    });
    const observed = exits.find((exit) => exit.code === 7);
    expect(observed).toBeDefined();
  });

  it('onExit does NOT fire when the exit was caused by stop()', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    const exits: SupervisedChildExit[] = [];
    child.onExit((exit) => exits.push(exit));
    await child.start();
    await child.stop();
    // Give the event loop a turn in case a (wrongly) suppressed exit handler
    // were about to fire asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toEqual([]);
  });

  it('an unsubscribed onExit handler is not called again', async () => {
    const child = makeChild('process.exit(0)');
    const calls: SupervisedChildExit[] = [];
    const unsubscribe = child.onExit((exit) => calls.push(exit));
    unsubscribe();
    await child.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'stop() escalates from SIGTERM to SIGKILL when the child ignores SIGTERM',
    async () => {
      // This child installs a SIGTERM handler that does nothing, forcing the
      // escalation path. Small timeouts keep the test fast.
      const child = makeChild(
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        { stopTimeoutMs: 150, pollIntervalMs: 10 },
      );
      await child.start();
      const pgid = child.pid!;
      expect(isProcessGroupAlive(pgid)).toBe(true);

      await child.stop();

      expect(isProcessGroupAlive(pgid)).toBe(false);
      expect(child.pid).toBeNull();
    },
    10_000,
  );

  it.each([false, true])(
    'stop() terminates the grandchild when parent exited = %s',
    async (exitParent) => {
      const child = makeChild(`
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
      grandchild.once('spawn', () => {
        console.log(JSON.stringify({ pid: grandchild.pid }));
        ${exitParent ? 'process.exit(0);' : ''}
      });
      setInterval(() => {}, 1000);
    `);
      const proc = await child.start();
      const parentPid = child.pid!;
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        let stdout = '';
        proc.stdout!.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n'))
            resolve((JSON.parse(stdout) as { pid: number }).pid);
        });
        proc.once('error', reject);
      });
      try {
        expect(isProcessAlive(grandchildPid)).toBe(true);
        if (exitParent) {
          await new Promise<void>((resolve) => {
            if (!isProcessAlive(parentPid)) resolve();
            else proc.once('exit', () => resolve());
          });
        }
        await child.stop();
        expect(isProcessAlive(parentPid)).toBe(false);
        expect(isProcessAlive(grandchildPid)).toBe(false);
      } finally {
        if (isProcessAlive(grandchildPid))
          process.kill(grandchildPid, 'SIGKILL');
      }
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'stop() converges quickly for a child that honors SIGTERM',
    async () => {
      const child = makeChild(
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
      );
      await child.start();
      const start = Date.now();
      await child.stop();
      expect(Date.now() - start).toBeLessThan(1_000);
    },
  );
});
