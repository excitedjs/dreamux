import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';
import { describe, expect, it, vi } from 'vitest';

import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';

function testLogger(): DreamuxLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const log = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: () => log,
  };
  return log as unknown as DreamuxLogger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function teamEvent(teamName: string): ChannelCoreEvent {
  return {
    schema_version: 1,
    kind: 'team.state',
    occurred_at: 42,
    team_name: teamName,
    leader_name: 'leader-a',
    status: 'running',
  };
}

describe('DispatcherCoreEventBus', () => {
  it('exposes only owned subscriptions and revokes a session generation', () => {
    const log = testLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const first: ChannelCoreEvent[] = [];
    const second: ChannelCoreEvent[] = [];
    const firstSubscription = lease.source.on('team.state', (event) => {
      first.push(event);
    });
    const secondSubscription = lease.source.on('team.state', (event) => {
      second.push(event);
    });

    expect(Object.keys(lease.source)).toEqual(['on']);
    expect('emit' in lease.source).toBe(false);
    expect('removeAllListeners' in lease.source).toBe(false);

    bus.publisher.publish('dispatcher-a', teamEvent('team-a'));
    firstSubscription.unsubscribe();
    firstSubscription.unsubscribe();
    bus.publisher.publish('dispatcher-a', teamEvent('team-b'));

    expect(first.map((event) => event.kind === 'team.state' && event.team_name))
      .toEqual(['team-a']);
    expect(second.map((event) => event.kind === 'team.state' && event.team_name))
      .toEqual(['team-a', 'team-b']);

    lease.revoke();
    lease.revoke();
    bus.publisher.publish('dispatcher-a', teamEvent('team-c'));
    secondSubscription.unsubscribe();

    expect(second).toHaveLength(2);
    expect(() => lease.source.on('team.state', () => undefined)).toThrow(
      'no longer active',
    );
  });

  it('isolates synchronous throws and asynchronous listener rejection', async () => {
    const log = testLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const observed: string[] = [];
    lease.source.on('team.state', () => {
      throw new Error('sync listener failure');
    });
    lease.source.on('team.state', async () => {
      throw new Error('async listener failure');
    });
    lease.source.on('team.state', (event) => {
      observed.push(event.team_name);
    });

    expect(() => {
      bus.publisher.publish('dispatcher-a', teamEvent('team-a'));
    }).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(observed).toEqual(['team-a']);
    expect(log.warn).toHaveBeenCalledTimes(2);
    lease.revoke();
  });

  it('keeps publishers and sources inside their dispatcher scope', () => {
    const logA = testLogger();
    const logB = testLogger();
    const busA = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log: logA,
      maxSources: 1,
    });
    const busB = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-b',
      log: logB,
      maxSources: 1,
    });
    const sourceA = busA.createSource('channel-a');
    const sourceB = busB.createSource('channel-b');
    const observedA: string[] = [];
    const observedB: string[] = [];
    sourceA.source.on('team.state', (event) => {
      observedA.push(event.team_name);
    });
    sourceB.source.on('team.state', (event) => {
      observedB.push(event.team_name);
    });

    busA.publisher.publish('dispatcher-a', teamEvent('team-a'));
    busB.publisher.publish('dispatcher-b', teamEvent('team-b'));
    busA.publisher.publish('dispatcher-b', teamEvent('wrong-scope'));

    expect(observedA).toEqual(['team-a']);
    expect(observedB).toEqual(['team-b']);
    expect(logA.error).toHaveBeenCalledOnce();
    sourceA.revoke();
    sourceB.revoke();
  });
});
