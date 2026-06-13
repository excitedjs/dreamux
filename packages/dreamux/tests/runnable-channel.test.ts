/**
 * Dispatcher runtime-boundary guard (issue #209 multi-channel config review).
 *
 * `assertRunnableChannelShape` is the single intended place where a config that
 * is *accepted* (multi-channel shape) but *not yet runnable* (live routing is a
 * follow-up slice) fails loud. These tests pin all four shapes so the boundary
 * cannot regress: state seeding stays fail-soft, this guard does the rejecting.
 */
import { describe, expect, it } from 'vitest';

import type { DispatcherChannelConfig } from '../src/config/config.js';
import { assertRunnableChannelShape } from '../src/dispatcher-service/dispatcher/runnable-channel.js';

function feishu(id: string, appId: string): DispatcherChannelConfig {
  return {
    id,
    provider: 'builtin:feishu',
    config: { app_id: appId, app_secret: 'secret' } as never,
  };
}

function nonFeishu(id: string): DispatcherChannelConfig {
  return { id, provider: 'npm:@example/dreamux-other#channel', config: {} };
}

describe('assertRunnableChannelShape', () => {
  it('accepts a single builtin:feishu channel', () => {
    expect(() =>
      assertRunnableChannelShape({ id: 'flow', channels: [feishu('primary', 'app-flow')] }),
    ).not.toThrow();
  });

  it('rejects more than one channel (two feishu)', () => {
    expect(() =>
      assertRunnableChannelShape({
        id: 'flow',
        channels: [feishu('primary', 'app-a'), feishu('secondary', 'app-b')],
      }),
    ).toThrow(/declares 2 channels; live multi-channel routing is a follow-up/);
  });

  it('rejects a mixed multi-channel dispatcher (one feishu + one non-feishu)', () => {
    // The store's feishu-only filter would pass this (exactly one feishu), so the
    // runtime boundary is the only thing that catches it. The >1-channel branch
    // fires first, before per-channel wiring.
    expect(() =>
      assertRunnableChannelShape({
        id: 'flow',
        channels: [feishu('primary', 'app-flow'), nonFeishu('secondary')],
      }),
    ).toThrow(/declares 2 channels; live multi-channel routing is a follow-up/);
  });

  it('rejects a single non-feishu channel as not wired', () => {
    expect(() =>
      assertRunnableChannelShape({ id: 'flow', channels: [nonFeishu('primary')] }),
    ).toThrow(/is not wired; only builtin:feishu is built in this phase/);
  });
});
