import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelTaskHostEventSinkResult,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { TaskHostEventPump } from '../src/service/channel-task-host/event-pump.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';

describe('task host event delivery fencing', () => {
  let root: string;
  let store: TaskHostStore;
  let pump: TaskHostEventPump;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-host-events-'));
    store = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/dreamux-task-channel',
      rootDir: root,
    });
    pump = new TaskHostEventPump(store, noopLog(), 1);
    await store.appendHostStatus('ready');
  });

  afterEach(async () => {
    pump.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('ignores a delayed acknowledgement from a replaced sink', async () => {
    let settleOld: ((value: ChannelTaskHostEventSinkResult) => void) | null = null;
    const oldSink = vi.fn(async () => new Promise<ChannelTaskHostEventSinkResult>(
      (resolve) => { settleOld = resolve; },
    ));
    const replacement = vi.fn(async (batch) => ({
      acknowledged_through: batch.last_sequence ?? 0,
    }));
    pump.attach({ acceptHostEvents: oldSink });
    await waitFor(() => oldSink.mock.calls.length === 1);

    pump.attach({ acceptHostEvents: replacement });
    settleOld!({ acknowledged_through: store.watermark });
    await waitFor(() => store.acknowledgedThrough === store.watermark);

    expect(replacement).toHaveBeenCalledOnce();
    expect(replacement.mock.calls[0]![0].events).toHaveLength(1);
  });

  it('retries a zero-progress consecutive prefix without losing events', async () => {
    const sink = vi.fn(async (batch) => ({
      acknowledged_through: sink.mock.calls.length === 1
        ? store.acknowledgedThrough
        : batch.last_sequence ?? 0,
    }));
    pump.attach({ acceptHostEvents: sink });
    await waitFor(() => store.acknowledgedThrough === store.watermark);

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]![0].events[0]?.event_id)
      .toBe(sink.mock.calls[1]![0].events[0]?.event_id);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for event delivery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function noopLog(): DreamuxLogger {
  const sink = () => {};
  return { error: sink, warn: sink, info: sink, debug: sink, trace: sink };
}
