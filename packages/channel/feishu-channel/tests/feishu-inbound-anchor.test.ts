import { describe, expect, it } from 'vitest';

import { FeishuInboundCorrelations } from '../src/feishu-inbound-anchor.js';

describe('FeishuInboundCorrelations', () => {
  it('recognizes a pending caller id and hides its exact turn once', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');

    correlations.submitted('message-own', 'leader:alpha', 'turn-own');
    expect(correlations.consumeTurn('leader:alpha', 'turn-own')).toBe(true);
    expect(correlations.consumeTurn('leader:alpha', 'turn-own')).toBe(false);
    release();
  });

  it('does not hide a turn carrying another producer\'s caller id', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');

    correlations.submitted('message-other', 'leader:alpha', 'turn-other');

    expect(correlations.consumeTurn('leader:alpha', 'turn-other')).toBe(false);
    release();
  });

  it('releases an in-flight id when team.submit returns without its fact', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');
    release();

    correlations.submitted('message-own', 'leader:alpha', 'turn-late');
    expect(correlations.consumeTurn('leader:alpha', 'turn-late')).toBe(false);
  });

  it('releases a recognized turn when its projected body never arrives', () => {
    const correlations = new FeishuInboundCorrelations();
    const release = correlations.begin('message-own');
    correlations.submitted('message-own', 'dispatcher', 'turn-own');
    release();

    expect(correlations.consumeTurn('dispatcher', 'turn-own')).toBe(false);
  });

  it('keeps recipients distinct even if a turn id is reused', () => {
    const correlations = new FeishuInboundCorrelations();
    correlations.begin('message-own');
    correlations.submitted('message-own', 'leader:alpha', 'turn-shared');

    expect(correlations.consumeTurn('dispatcher', 'turn-shared')).toBe(false);
    expect(correlations.consumeTurn('leader:alpha', 'turn-shared')).toBe(true);
  });

  it('supports concurrent repeats of one source id without stale release', () => {
    const correlations = new FeishuInboundCorrelations();
    const releaseFirst = correlations.begin('message-shared');
    const releaseSecond = correlations.begin('message-shared');

    correlations.submitted('message-shared', 'dispatcher', 'turn-own');
    expect(correlations.consumeTurn('dispatcher', 'turn-own')).toBe(true);
    releaseFirst();
    correlations.submitted('message-shared', 'dispatcher', 'turn-repeat');
    expect(correlations.consumeTurn('dispatcher', 'turn-repeat')).toBe(true);
    releaseSecond();
  });

  it('bounds in-flight ids and fails open beyond the limit', () => {
    const correlations = new FeishuInboundCorrelations();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 256; index += 1) {
      releases.push(correlations.begin(`message-${index}`));
    }
    const overflowRelease = correlations.begin('message-overflow');

    correlations.submitted(
      'message-overflow',
      'dispatcher',
      'turn-overflow',
    );
    expect(correlations.consumeTurn('dispatcher', 'turn-overflow')).toBe(false);

    for (const release of releases) release();
    overflowRelease();
  });

  it('clear releases pending ids and remembered turns', () => {
    const correlations = new FeishuInboundCorrelations();
    correlations.begin('message-own');
    correlations.submitted('message-own', 'dispatcher', 'turn-own');
    correlations.clear();

    expect(correlations.consumeTurn('dispatcher', 'turn-own')).toBe(false);
  });
});
