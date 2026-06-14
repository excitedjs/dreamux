/**
 * Dispatcher runtime-boundary guard (issue #209 live multi-channel routing).
 *
 * `assertRunnableChannelShape` is the single intended place where a config that
 * is *accepted* but *not yet runnable* fails loud. Live routing now runs one
 * Feishu session per channel, so MORE THAN ONE Feishu channel is runnable; only
 * a channel naming an unwired (non-feishu) provider is rejected. These tests pin
 * the boundary so it cannot regress: state seeding stays fail-soft, this guard
 * does the rejecting.
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

  it('accepts more than one builtin:feishu channel (live multi-channel routing)', () => {
    expect(() =>
      assertRunnableChannelShape({
        id: 'flow',
        channels: [feishu('primary', 'app-a'), feishu('secondary', 'app-b')],
      }),
    ).not.toThrow();
  });

  it('rejects a mixed multi-channel dispatcher (an unwired non-feishu channel)', () => {
    // A feishu channel runs fine, but the non-feishu channel names a provider the
    // dispatcher service does not wire in this phase, so the whole shape fails loud.
    expect(() =>
      assertRunnableChannelShape({
        id: 'flow',
        channels: [feishu('primary', 'app-flow'), nonFeishu('secondary')],
      }),
    ).toThrow(/is not wired; only builtin:feishu is built in this phase/);
  });

  it('rejects a single non-feishu channel as not wired', () => {
    expect(() =>
      assertRunnableChannelShape({ id: 'flow', channels: [nonFeishu('primary')] }),
    ).toThrow(/is not wired; only builtin:feishu is built in this phase/);
  });
});
