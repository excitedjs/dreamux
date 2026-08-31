import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeishuInboundWork,
  runFeishuInboundWork,
  type FeishuInboundWorkContext,
} from '../src/feishu-inbound-work.js';

const works: FeishuInboundWorkContext[] = [];

afterEach(() => {
  for (const work of works.splice(0)) work.dispose();
  vi.useRealTimers();
});

function session(controller: AbortController): {
  signal: AbortSignal;
  isCurrent(): boolean;
} {
  return {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  };
}

describe('Feishu inbound work fencing', () => {
  it('does not start a queued operation after the session is revoked', async () => {
    const controller = new AbortController();
    const work = createFeishuInboundWork(session(controller));
    works.push(work);
    let calls = 0;

    const result = runFeishuInboundWork(work, async () => {
      calls += 1;
      return 'unexpected';
    });
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(Error);
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  it('classifies an operation bounded by the message deadline deterministically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const controller = new AbortController();
    const work = createFeishuInboundWork(session(controller), { timeoutMs: 25 });
    works.push(work);

    const result = runFeishuInboundWork(
      work,
      () => new Promise<never>(() => undefined),
      work.deadlineAt,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it('classifies an already-expired operation-local deadline as a resource timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const controller = new AbortController();
    const work = createFeishuInboundWork(session(controller), { timeoutMs: 100 });
    works.push(work);
    let calls = 0;

    await expect(runFeishuInboundWork(
      work,
      async () => {
        calls += 1;
        return 'unexpected';
      },
      Date.now(),
    )).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });

  /**
   * Input-lifecycle unit slice: `runFeishuBoundedOperation` settles the
   * caller's promise exactly once (deadline wins the race), and a value that
   * only resolves afterward is never silently dropped nor allowed to become
   * a second settlement — it is routed through `onLateValue` so the caller
   * can dispose of it (e.g. release a stream) instead of leaking it.
   */
  it('disposes a value that resolves after the deadline through onLateValue, exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const controller = new AbortController();
    const work = createFeishuInboundWork(session(controller), { timeoutMs: 10 });
    works.push(work);

    let releaseOperation: (value: string) => void = () => undefined;
    const operation = new Promise<string>((resolve) => {
      releaseOperation = resolve;
    });
    const lateValues: string[] = [];

    const outcome = runFeishuInboundWork(
      work,
      () => operation,
      work.deadlineAt,
      (value) => {
        lateValues.push(value);
      },
    );
    const assertion = expect(outcome).rejects.toBeInstanceOf(Error);

    // The deadline fires first and settles the caller's promise with a
    // rejection...
    await vi.advanceTimersByTimeAsync(10);
    await assertion;

    // ...and only afterward does the slow operation resolve. Its value must
    // reach onLateValue rather than resolving (or re-rejecting) the already
    // settled outer promise a second time.
    releaseOperation('arrived-too-late');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(lateValues).toEqual(['arrived-too-late']);
  });

  it('never calls onLateValue when the operation settles before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const controller = new AbortController();
    const work = createFeishuInboundWork(session(controller), { timeoutMs: 1_000 });
    works.push(work);
    const lateValues: string[] = [];

    const outcome = runFeishuInboundWork(
      work,
      async () => 'on-time',
      work.deadlineAt,
      (value) => {
        lateValues.push(value);
      },
    );

    await expect(outcome).resolves.toBe('on-time');
    expect(lateValues).toEqual([]);
  });
});
