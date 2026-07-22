import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeishuInboundWork,
  FeishuEnrichmentDeadlineError,
  FeishuSessionRevokedError,
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

    await expect(result).rejects.toBeInstanceOf(FeishuSessionRevokedError);
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
    const assertion = expect(result).rejects.toBeInstanceOf(
      FeishuEnrichmentDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});
