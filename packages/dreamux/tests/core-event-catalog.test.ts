import { describe, expect, it, vi } from 'vitest';
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { sealChannelCoreEvent } from '../src/service/dispatcher-core-events/seal.js';
import { createLogger } from '../src/platform/logger.js';
function createCapturingLogger() {
  const warnCalls: Array<{ message: string }> = [];
  const errorCalls: Array<{ message: string }> = [];
  const logger = createLogger({
    destination: {
      write(line) {
        const item = JSON.parse(line) as { level: number; msg: string };
        if (item.level === 40) warnCalls.push({ message: item.msg });
        if (item.level >= 50) errorCalls.push({ message: item.msg });
      },
    },
  });
  return { logger, warnCalls, errorCalls };
}
const DISPATCHER_ID = 'dispatcher-fixture';

function baseScope(
  overrides: Partial<{
    teammateName: string;
    role: 'dispatcher' | 'teammate' | 'team_leader';
    teamName: string | null;
    turn_id: string;
  }> = {},
) {
  return {
    schemaVersion: 1 as const,
    occurredAt: Date.now(),
    teammateName: 'scout',
    role: 'teammate' as const,
    teamName: 'alpha',
    ...overrides,
  };
}

/** One minimal, schema-valid fixture for every kind the catalog union admits. */
function catalogFixtures(): Record<ChannelCoreEvent['kind'], ChannelCoreEvent> {
  return {
    'team.state': {
      schemaVersion: 1,
      kind: 'team.state',
      occurredAt: Date.now(),
      teamName: 'alpha',
      leaderName: 'alpha-leader',
      status: 'running',
      teammates: [],
    },
    'teammate.state': {
      schemaVersion: 1,
      kind: 'teammate.state',
      occurredAt: Date.now(),
      teammateName: 'alpha-leader',
      role: 'team_leader',
      teamName: 'alpha',
      status: 'running',
    },
    // Both display facts are actor-scoped: a provider folds any number of
    // logical submissions into one native turn, so neither carries a `turn_id`
    // — only whose conversation it belongs to.
    'teammate.input': {
      ...baseScope(),
      kind: 'teammate.input',
      source: 'feishu',
      sourceId: null,
      content: 'hi',
      notice: null,
    },
    'teammate.activity': {
      ...baseScope(),
      kind: 'teammate.activity',
      activity: {
        kind: 'tool.call',
        occurredAt: 1,
        id: 'call-1',
        toolName: 'read_file',
        action: 'read',
        summary: null,
        invocation: null,
        items: [],
        status: 'completed',
        arguments: {},
        result: {},
        error: null,
      },
    },
  };
}

describe('the published Core event catalog is exactly four kinds', () => {
  it('accepts a schema-valid fixture of every catalog kind', () => {
    const fixtures = catalogFixtures();
    for (const [kind, event] of Object.entries(fixtures)) {
      const sealed = sealChannelCoreEvent(event);
      expect(sealed, `kind ${kind} should seal`).not.toBeNull();
      expect(sealed?.kind).toBe(kind);
    }
  });

  it('deep-freezes a sealed event so no listener can rewrite a broadcast fact', () => {
    const sealed = sealChannelCoreEvent(catalogFixtures()['teammate.activity']);
    expect(sealed).not.toBeNull();
    expect(Object.isFrozen(sealed)).toBe(true);
    if (sealed.kind !== 'teammate.activity')
      throw new Error('expected activity');
    expect(Object.isFrozen(sealed.activity)).toBe(true);
    expect(() => Object.assign(sealed.activity, { kind: 'mutated' })).toThrow(
      TypeError,
    );
  });
});

describe('DispatcherCoreEventBus: live, best-effort delivery', () => {
  function makeBus() {
    const { logger, warnCalls, errorCalls } = createCapturingLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: DISPATCHER_ID,
      log: logger,
    });
    return { bus, warnCalls, errorCalls };
  }

  it('publish() is a void call: no listener promise can ever be awaited to gate a Core operation', () => {
    const { bus } = makeBus();
    bus.createSource('channel-a');
    // If this returned a Promise, a caller could `await` it and let a
    // listener's own timing decide when a Core operation is considered done —
    // exactly the coupling "notifications after the durable fact" forbids.
    const result = bus.publish(catalogFixtures()['teammate.state']);
    expect(result).toBeUndefined();
  });

  it('invokes every listener on one source in subscription order, without waiting for a slow one', async () => {
    const { bus } = makeBus();
    const source = bus.createSource('channel-a');
    const order: string[] = [];
    let releaseSlow!: () => void;
    const slowResolved = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    source.source.subscribe(() => {
      order.push('first');
    });
    source.source.subscribe(async () => {
      order.push('second-start');
      await slowResolved;
      order.push('second-end');
    });

    bus.publish(catalogFixtures()['teammate.state']);

    // Both listeners have already been invoked synchronously, in the order
    // they subscribed, even though the second is still awaiting its own
    // promise — proving delivery is not awaited by the publisher.
    expect(order).toEqual(['first', 'second-start']);
    releaseSlow();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first', 'second-start', 'second-end']);
  });

  it('a synchronous throw from one listener never prevents another listener, on the same or a different source, from receiving the fact', () => {
    const { bus, warnCalls } = makeBus();
    const sourceA = bus.createSource('channel-a');
    const sourceB = bus.createSource('channel-b');
    const received: string[] = [];

    sourceA.source.subscribe(() => {
      received.push('a-1');
      throw new Error('a-1 is hostile');
    });
    sourceA.source.subscribe(() => {
      received.push('a-2');
    });
    sourceB.source.subscribe(() => {
      received.push('b-1');
    });

    expect(() =>
      bus.publish(catalogFixtures()['teammate.state']),
    ).not.toThrow();

    expect(received).toEqual(['a-1', 'a-2', 'b-1']);
    expect(
      warnCalls.some((c) => c.message === 'channel core event listener failed'),
    ).toBe(true);
  });

  it('a rejected listener promise is caught and logged, never surfacing as an unhandled rejection or a publish() failure', async () => {
    const { bus, warnCalls } = makeBus();
    const source = bus.createSource('channel-a');
    let settled = false;
    source.source.subscribe(async () => {
      throw new Error('async hostile listener');
    });
    source.source.subscribe(() => {
      settled = true;
    });

    expect(() =>
      bus.publish(catalogFixtures()['teammate.state']),
    ).not.toThrow();
    expect(settled).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(
      warnCalls.some((c) => c.message === 'channel core event listener failed'),
    ).toBe(true);
  });
});

describe('DispatcherCoreEventBus: subscription lifecycle', () => {
  function makeBus() {
    const { logger } = createCapturingLogger();
    return new DispatcherCoreEventBus({
      dispatcherId: DISPATCHER_ID,
      log: logger,
    });
  }

  it('never delivers a fact published before the source existed (no subscribe-time snapshot, no replay)', () => {
    const bus = makeBus();
    // Publish before anyone has subscribed at all.
    bus.publish(catalogFixtures()['teammate.state']);

    const source = bus.createSource('channel-a');
    const received: ChannelCoreEvent[] = [];
    source.source.subscribe((event) => {
      received.push(event);
    });

    bus.publish(catalogFixtures()['teammate.input']);

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('teammate.input');
  });

  it('revoking one source stops its delivery without touching a sibling source', () => {
    const bus = makeBus();
    const sourceA = bus.createSource('channel-a');
    const sourceB = bus.createSource('channel-b');
    const receivedA: ChannelCoreEvent[] = [];
    const receivedB: ChannelCoreEvent[] = [];
    sourceA.source.subscribe((event) => {
      receivedA.push(event);
    });
    sourceB.source.subscribe((event) => {
      receivedB.push(event);
    });

    sourceA.revoke();
    bus.publish(catalogFixtures()['teammate.state']);

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
  });

  it('revokeSources() fences every live source at once, and no callback runs after that final close', () => {
    const bus = makeBus();
    const sourceA = bus.createSource('channel-a');
    const sourceB = bus.createSource('channel-b');
    const received: ChannelCoreEvent[] = [];
    sourceA.source.subscribe((event) => {
      received.push(event);
    });
    sourceB.source.subscribe((event) => {
      received.push(event);
    });

    bus.revokeSources();
    bus.publish(catalogFixtures()['teammate.state']);

    expect(received).toHaveLength(0);
  });

  it('a revoked source refuses a new subscription rather than silently accepting one', () => {
    const bus = makeBus();
    const source = bus.createSource('channel-a');
    source.revoke();
    expect(() => source.source.subscribe(() => {})).toThrow();
  });

  it('unsubscribe() removes exactly one registration and leaves siblings on the same source delivering', () => {
    const bus = makeBus();
    const source = bus.createSource('channel-a');
    const received: string[] = [];
    const subA = source.source.subscribe(() => {
      received.push('a');
    });
    source.source.subscribe(() => {
      received.push('b');
    });

    subA.unsubscribe();
    bus.publish(catalogFixtures()['teammate.state']);

    expect(received).toEqual(['b']);
  });

  it('hasSources() is true only while at least one non-revoked source exists', () => {
    const bus = makeBus();
    expect(bus.hasSources()).toBe(false);
    const sourceA = bus.createSource('channel-a');
    expect(bus.hasSources()).toBe(true);
    const sourceB = bus.createSource('channel-b');
    sourceA.revoke();
    expect(bus.hasSources()).toBe(true);
    sourceB.revoke();
    expect(bus.hasSources()).toBe(false);
  });

  it('exposes no FIFO, replay, snapshot, or history surface a caller could read the past from', () => {
    const bus = makeBus();
    const untyped = bus as unknown as Record<string, unknown>;
    for (const forbidden of [
      'replay',
      'getHistory',
      'history',
      'snapshot',
      'ack',
      'acknowledge',
      'retry',
    ]) {
      expect(
        untyped[forbidden],
        `DispatcherCoreEventBus must not expose '${forbidden}'`,
      ).toBeUndefined();
    }
  });
});

it('duplicate listener registrations unsubscribe independently and idempotently', () => {
  const bus = new DispatcherCoreEventBus({
    dispatcherId: 'test',
    log: createCapturingLogger().logger,
  });
  const lease = bus.createSource('channel');
  const listener = vi.fn();
  const first = lease.source.subscribe(listener);
  const second = lease.source.subscribe(listener);
  bus.publish(catalogFixtures()['teammate.state']);
  expect(listener).toHaveBeenCalledTimes(2);
  first.unsubscribe();
  first.unsubscribe();
  bus.publish(catalogFixtures()['teammate.state']);
  expect(listener).toHaveBeenCalledTimes(3);
  second.unsubscribe();
  bus.publish(catalogFixtures()['teammate.state']);
  expect(listener).toHaveBeenCalledTimes(3);
});
