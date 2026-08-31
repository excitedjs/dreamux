/**
 * The provider-local fatal path for authoritative state writes
 * (runtime-state-fence.ts): a write failure must close the fence exactly once,
 * classify lease-revocation vs. any other persist failure, start native
 * teardown, and reject an awaited caller that reaches the fence after it
 * closed — while a fire-and-forget `publishDetached` call must never surface
 * as an unhandled rejection and must skip the write entirely once fenced.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  STATE_LEASE_REVOKED_ERROR_NAME,
  RuntimeStateFence,
  RuntimeStateFencedError,
  isStateLeaseRevoked,
} from '../src/runtime-state-fence.js';

function makeLeaseRevokedError(): Error {
  return Object.assign(new Error('lease revoked'), {
    name: STATE_LEASE_REVOKED_ERROR_NAME,
  });
}

describe('isStateLeaseRevoked', () => {
  it('recognizes an error carrying the lease-revoked name', () => {
    expect(isStateLeaseRevoked(makeLeaseRevokedError())).toBe(true);
  });

  it('rejects a plain error and non-object values', () => {
    expect(isStateLeaseRevoked(new Error('other'))).toBe(false);
    expect(isStateLeaseRevoked(null)).toBe(false);
    expect(isStateLeaseRevoked(undefined)).toBe(false);
    expect(isStateLeaseRevoked('x')).toBe(false);
  });
});

function makeFence(terminate: () => Promise<void> = () => Promise.resolve()) {
  const logs: Array<{ level: string; message: string; error?: unknown }> = [];
  const fence = new RuntimeStateFence({
    terminate,
    log: (level, message, error) => logs.push({ level, message, error }),
  });
  return { fence, logs };
}

describe('RuntimeStateFence.assertOpen / isFenced', () => {
  it('is open and does not throw before any close', () => {
    const { fence } = makeFence();
    expect(fence.isFenced).toBe(false);
    expect(() => fence.assertOpen()).not.toThrow();
  });

  it('throws RuntimeStateFencedError with the closing reason once closed', () => {
    const { fence } = makeFence();
    fence.close('persist_failed');
    expect(fence.isFenced).toBe(true);
    expect(() => fence.assertOpen()).toThrow(RuntimeStateFencedError);
    try {
      fence.assertOpen();
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStateFencedError);
      expect((error as RuntimeStateFencedError).reason).toBe('persist_failed');
      expect((error as RuntimeStateFencedError).name).toBe('RuntimeStateFencedError');
    }
  });
});

describe('RuntimeStateFence.publish', () => {
  it('resolves and leaves the fence open on a successful write', async () => {
    const { fence } = makeFence();
    await expect(fence.publish(() => Promise.resolve())).resolves.toBeUndefined();
    expect(fence.isFenced).toBe(false);
  });

  it('rethrows the original error and closes with persist_failed for a non-lease failure', async () => {
    const { fence, logs } = makeFence();
    const boom = new Error('disk full');
    await expect(fence.publish(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(fence.isFenced).toBe(true);
    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.error).toBe(boom);
  });

  it('closes with lease_revoked when the write rejects with a lease-revoked error', async () => {
    const { fence } = makeFence();
    const revoked = makeLeaseRevokedError();
    await expect(fence.publish(() => Promise.reject(revoked))).rejects.toBe(revoked);
    try {
      fence.assertOpen();
      throw new Error('unreachable');
    } catch (error) {
      expect((error as RuntimeStateFencedError).reason).toBe('lease_revoked');
    }
  });

  it('rejects immediately with RuntimeStateFencedError when called after the fence already closed', async () => {
    const { fence } = makeFence();
    fence.close('persist_failed');
    await expect(fence.publish(() => Promise.resolve())).rejects.toBeInstanceOf(
      RuntimeStateFencedError,
    );
  });

  it('starts native teardown exactly once even under a rapid double failure', async () => {
    const terminate = vi.fn(() => Promise.resolve());
    const { fence } = makeFence(terminate);
    await expect(fence.publish(() => Promise.reject(new Error('first')))).rejects.toThrow(
      'first',
    );
    // A second publish call after the fence is already closed must reject with
    // the fence error, not attempt another write or another teardown.
    await expect(fence.publish(() => Promise.reject(new Error('second')))).rejects.toBeInstanceOf(
      RuntimeStateFencedError,
    );
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeStateFence.publishDetached', () => {
  it('never rejects even when the write throws', async () => {
    const { fence } = makeFence();
    expect(() => fence.publishDetached(() => Promise.reject(new Error('boom')))).not.toThrow();
    // Give the fire-and-forget write's microtask a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fence.isFenced).toBe(true);
  });

  it('closes the fence on a detached failure the same as an awaited one', async () => {
    const { fence } = makeFence();
    fence.publishDetached(() => Promise.reject(new Error('boom')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fence.isFenced).toBe(true);
  });

  it('skips the write entirely once already fenced (no retry noise)', async () => {
    const { fence } = makeFence();
    fence.close('persist_failed');
    const write = vi.fn(() => Promise.resolve());
    fence.publishDetached(write);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(write).not.toHaveBeenCalled();
  });
});

describe('RuntimeStateFence.close', () => {
  it('is idempotent: the first reason wins and terminate() runs only once', async () => {
    const terminate = vi.fn(() => Promise.resolve());
    const { fence } = makeFence(terminate);
    fence.close('lease_revoked');
    fence.close('persist_failed');
    try {
      fence.assertOpen();
      throw new Error('unreachable');
    } catch (error) {
      expect((error as RuntimeStateFencedError).reason).toBe('lease_revoked');
    }
    expect(terminate).toHaveBeenCalledTimes(1);
    await fence.terminated();
  });
});

describe('RuntimeStateFence.terminated', () => {
  it('resolves immediately when the fence was never closed', async () => {
    const { fence } = makeFence();
    await expect(fence.terminated()).resolves.toBeUndefined();
  });

  it('resolves once the terminate() teardown succeeds', async () => {
    const { fence } = makeFence(() => Promise.resolve());
    fence.close('persist_failed');
    await expect(fence.terminated()).resolves.toBeUndefined();
  });

  it('rejects with the teardown failure so a caller like stop() can discover non-termination', async () => {
    const teardownError = new Error('teardown failed');
    const { fence, logs } = makeFence(() => Promise.reject(teardownError));
    fence.close('persist_failed');
    await expect(fence.terminated()).rejects.toBe(teardownError);
    // The teardown failure itself must also be logged (separately from the
    // original close() log), so an operator sees the runtime is unproven-dead.
    const teardownLog = logs.find((entry) => entry.error === teardownError);
    expect(teardownLog?.level).toBe('error');
  });
});
