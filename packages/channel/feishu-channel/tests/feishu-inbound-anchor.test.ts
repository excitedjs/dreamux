import { describe, expect, it } from 'vitest';

import { FeishuInboundCorrelations } from '../src/feishu-inbound-anchor.js';

describe('FeishuInboundCorrelations', () => {
  it('recognizes a caller id this session issued, exactly once', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');

    expect(correlations.consume('message-own')).toBe(true);
    expect(correlations.consume('message-own')).toBe(false);
    release();
  });

  it('does not recognize another producer\'s caller id', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');

    // A cron fire, a task push-back, and a restart notice all carry a
    // source_id: recognition is a comparison, never a presence check.
    expect(correlations.consume('message-other')).toBe(false);
    release();
  });

  it('recognizes no id at all when the input carries none', () => {
    const correlations = new FeishuInboundCorrelations();
    correlations.begin('message-own');

    expect(correlations.consume(null)).toBe(false);
  });

  it('releases an in-flight id when team.submit returns without its fact', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');
    release();

    expect(correlations.consume('message-own')).toBe(false);
  });

  it('lets the caller release an id the input fact already consumed', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');
    expect(correlations.consume('message-own')).toBe(true);

    // The release the caller holds and the consumed body are the same token,
    // so the `finally` release must not free a concurrent repeat's token.
    const releaseSecond = correlations.begin('message-own');
    release();
    expect(correlations.consume('message-own')).toBe(true);
    releaseSecond();
  });

  it('supports concurrent repeats of one source id without stale release', () => {
    const correlations = new FeishuInboundCorrelations();
    const releaseFirst = correlations.begin('message-shared');
    const releaseSecond = correlations.begin('message-shared');

    expect(correlations.consume('message-shared')).toBe(true);
    releaseFirst();
    expect(correlations.consume('message-shared')).toBe(true);
    releaseSecond();
  });

  it('bounds in-flight ids and fails open beyond the limit', () => {
    const correlations = new FeishuInboundCorrelations();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 256; index += 1) {
      releases.push(correlations.begin(`message-${index}`));
    }
    const overflowRelease = correlations.begin('message-overflow');

    expect(correlations.consume('message-overflow')).toBe(false);

    for (const release of releases) release();
    overflowRelease();
  });

  it('clear releases every pending id', () => {
    const correlations = new FeishuInboundCorrelations();
    correlations.begin('message-own');
    correlations.clear();

    expect(correlations.consume('message-own')).toBe(false);
  });
});
