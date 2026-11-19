import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/platform/logger.js';
import { installServerShutdown } from '../src/server/shutdown.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('serving process shutdown', () => {
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const previous = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

  beforeEach(() => {
    for (const signal of signals)
      previous.set(signal, process.listeners(signal));
    vi.useFakeTimers();
    // Exit is the process boundary under test; no test terminates its worker.
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.get(signal)?.includes(listener))
          process.removeListener(signal, listener);
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const logger = createLogger({ destination: { write() {} } });

  function signal(name: 'SIGTERM' | 'SIGINT'): void {
    // Deliver only to this serving process owner's handlers, not Vitest's own
    // process-control listeners in the same worker.
    const listeners = process
      .listeners(name)
      .filter((listener) => !previous.get(name)?.includes(listener));
    expect(listeners).toHaveLength(1);
    for (const listener of listeners) listener(name);
  }

  it.each(['admin', 'SIGTERM', 'SIGINT'] as const)(
    '%s waits for cleanup and exits successfully only once',
    async (source) => {
      const requested = deferred();
      const cleanup = deferred();
      const shutdown = vi.fn(() => cleanup.promise);
      installServerShutdown(
        { shutdownRequested: requested.promise, shutdown },
        Promise.resolve(),
        logger,
      );
      if (source === 'admin') requested.resolve();
      else signal(source);
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(process.exit).not.toHaveBeenCalled();
      // A signal and an accepted command share the same in-progress owner.
      requested.resolve();
      signal('SIGTERM');
      signal('SIGINT');
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(process.exit).toHaveBeenCalledTimes(1);
    },
  );

  it('does not close owners while startup can still create them', async () => {
    const requested = deferred();
    const startup = deferred();
    const shutdown = vi.fn(async () => {});
    installServerShutdown(
      { shutdownRequested: requested.promise, shutdown },
      startup.promise,
      logger,
    );
    requested.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shutdown).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    startup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it.each(['startup', 'cleanup'] as const)(
    'exits unsuccessfully if %s rejects after a shutdown request',
    async (stage) => {
      const requested = deferred();
      const startup = deferred();
      const cleanup = deferred();
      const shutdown = vi.fn(() => cleanup.promise);
      installServerShutdown(
        { shutdownRequested: requested.promise, shutdown },
        startup.promise,
        logger,
      );
      requested.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (stage === 'startup') startup.reject(new Error('startup failed'));
      else {
        startup.resolve();
        await vi.advanceTimersByTimeAsync(0);
        cleanup.reject(new Error('cleanup failed'));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdown).toHaveBeenCalledTimes(stage === 'startup' ? 0 : 1);
      expect(process.exit).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(process.exit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['startup', 'cleanup'] as const)(
    'bounds a stuck %s by 15 seconds from the request',
    async (stage) => {
      const requested = deferred();
      const pending = deferred();
      const shutdown = vi.fn(() => pending.promise);
      installServerShutdown(
        { shutdownRequested: requested.promise, shutdown },
        stage === 'startup' ? pending.promise : Promise.resolve(),
        logger,
      );
      requested.resolve();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(process.exit).not.toHaveBeenCalled();
      expect(shutdown).toHaveBeenCalledTimes(stage === 'startup' ? 0 : 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(process.exit).toHaveBeenCalledTimes(1);
      expect(process.exit).toHaveBeenCalledWith(1);
    },
  );
});
