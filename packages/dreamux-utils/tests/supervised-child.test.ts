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

import { SupervisedChild, type SupervisedChildExit } from '../src/supervised-child.js';
import { isProcessGroupAlive, killProcessGroup } from '../src/os.js';

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
          killProcessGroup(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  function makeChild(script: string, options?: ConstructorParameters<typeof SupervisedChild>[1]) {
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

  it('calling start() twice on the same instance throws', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await child.start();
    await expect(child.start()).rejects.toThrow('SupervisedChild.start: already started');
  });

  it('calling start() after stop() throws', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await child.start();
    await child.stop();
    await expect(child.start()).rejects.toThrow('SupervisedChild.start: already stopped');
  });

  it('stop() before start() resolves without throwing', async () => {
    const child = makeChild('setInterval(() => {}, 1000)');
    await expect(child.stop()).resolves.toBeUndefined();
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

  it('stop() escalates from SIGTERM to SIGKILL when the child ignores SIGTERM', async () => {
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
  }, 10_000);

  it('stop() converges quickly for a child that honors SIGTERM', async () => {
    const child = makeChild("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)");
    await child.start();
    const start = Date.now();
    await child.stop();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
