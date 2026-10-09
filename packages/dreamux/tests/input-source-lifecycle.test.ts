import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';
import { CoreCommands } from '../src/command/registry.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { WorkflowService } from '../src/service/workflow-service/index.js';
import { SchedulerService } from '../src/service/scheduler/index.js';
import { AgentService } from '../src/service/agent/service.js';
import { UnbuiltAgent } from '../src/service/agent/factory.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());
const actor = {
  schemaVersion: 1 as const,
  occurredAt: 1,
  teammateName: 'dispatcher',
  role: 'dispatcher' as const,
  teamName: null,
};
function catalogEvents(): ChannelCoreEvent[] {
  return [
    {
      schemaVersion: 1,
      occurredAt: 1,
      kind: 'team.state',
      teamName: 'alpha',
      leaderName: 'leader-alpha',
      status: 'running',
      teammates: [],
    },
    { ...actor, kind: 'teammate.state', status: 'running' },
    {
      ...actor,
      kind: 'teammate.input',
      source: 'channel',
      sourceId: null,
      content: 'hello',
      notice: null,
    },
    {
      ...actor,
      kind: 'teammate.activity',
      activity: {
        kind: 'assistant.message',
        id: 'message-a',
        occurredAt: 1,
        text: 'answer',
      },
    },
  ];
}
function observeBus() {
  let observed: DispatcherCoreEventBus | null = null;
  const create = DispatcherCoreEventBus.prototype.createSource;
  vi.spyOn(DispatcherCoreEventBus.prototype, 'createSource').mockImplementation(
    function (this: DispatcherCoreEventBus, id) {
      observed = this;
      return create.call(this, id);
    },
  );
  return () => {
    if (observed === null)
      throw new Error('the actual channel source was not created');
    return observed;
  };
}

it('initializes and subscribes the Channel before recovering Core operations, then starts the Channel before ordinary admission opens', async () => {
  const order: string[] = [];
  const bus = observeBus();
  const f = await dispatcherFixture({
    channel: true,
    channelOptions: { record: (step) => order.push(step) },
  });
  const workflows = f.host.workflows,
    scheduler = f.host.scheduler;
  if (
    !(workflows instanceof WorkflowService) ||
    !(scheduler instanceof SchedulerService)
  )
    throw new Error('expected real owners');
  const recover = workflows.recover.bind(workflows),
    workflowStart = workflows.start.bind(workflows),
    schedulerStart = scheduler.start.bind(scheduler),
    teamStart = f.teams.startAdmissions.bind(f.teams);
  vi.spyOn(workflows, 'recover').mockImplementation(async () => {
    order.push('workflows.recover');
    expect(
      f.channel.sessions.get('fixture-channel')!.subscription,
    ).not.toBeNull();
    bus().publish(catalogEvents()[0]!);
    await recover();
  });
  vi.spyOn(workflows, 'start').mockImplementation(async () => {
    order.push('workflows.start');
    await workflowStart();
  });
  vi.spyOn(scheduler, 'start').mockImplementation(async () => {
    order.push('scheduler.start');
    await schedulerStart();
  });
  vi.spyOn(f.teams, 'startAdmissions').mockImplementation(async () => {
    order.push('teams.startAdmissions');
    await teamStart();
  });
  await f.host.start();
  expect(order.indexOf('channel:fixture-channel:initialize')).toBeLessThan(
    order.indexOf('workflows.recover'),
  );
  expect(order.indexOf('workflows.recover')).toBeLessThan(
    order.indexOf('channel:fixture-channel:start'),
  );
  expect(order.indexOf('channel:fixture-channel:start')).toBeLessThan(
    order.indexOf('workflows.start'),
  );
  expect(order.indexOf('workflows.start')).toBeLessThan(
    order.indexOf('scheduler.start'),
  );
  expect(order.indexOf('scheduler.start')).toBeLessThan(
    order.indexOf('teams.startAdmissions'),
  );
  expect(
    f.channel.sessions.get('fixture-channel')!.receivedEvents,
  ).toContainEqual(catalogEvents()[0]);
});

it('delivers each of the four catalog event kinds to a subscribed Channel', async () => {
  const bus = observeBus();
  const f = await dispatcherFixture({ channel: true });
  await f.host.channels.build();
  await f.host.channels.initialize(f.host.fence);
  const handle = f.channel.sessions.get('fixture-channel')!;
  for (const event of catalogEvents()) bus().publish(event);
  expect(handle.receivedEvents.map((event) => event.kind)).toEqual([
    'team.state',
    'teammate.state',
    'teammate.input',
    'teammate.activity',
  ]);
});

it('a Channel that needs no events never subscribes', async () => {
  const bus = observeBus();
  const f = await dispatcherFixture({
    channel: true,
    channelOptions: { subscribe: false },
  });
  await f.host.channels.build();
  await f.host.channels.initialize(f.host.fence);
  for (const event of catalogEvents()) bus().publish(event);
  const handle = f.channel.sessions.get('fixture-channel')!;
  expect(handle.subscription).toBeNull();
  expect(handle.receivedEvents).toEqual([]);
});

it('closeChannelPortAdmission() synchronously fences the Channel port: a post-fence Command rejects with ServerShuttingDownError, never a partial mutation', async () => {
  const f = await dispatcherFixture({ channel: true });
  await f.host.channels.build();
  await f.host.channels.initialize(f.host.fence);
  const invoke = vi.spyOn(CoreCommands.prototype, 'invoke');
  f.host.channels.closeAdmission();
  await expect(
    f.channel.sessions
      .get('fixture-channel')!
      .port!.invoke.invoke('team.submit', { text: 'late' }),
  ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
  expect(invoke).not.toHaveBeenCalled();
});

it('closePreparedChannels() closes built-but-unstarted sessions, clears the Channel service, and revokes Core event delivery — without materializing a dormant entity or persisting a close', async () => {
  const bus = observeBus();
  const f = await dispatcherFixture({ channel: true });
  await f.host.channels.build();
  await f.host.channels.initialize(f.host.fence);
  const build = vi.spyOn(UnbuiltAgent.prototype, 'build'),
    close = vi.spyOn(AgentService.prototype, 'close'),
    cleanup = vi.spyOn(WorktreeManager.prototype, 'cleanup');
  await f.host.channels.closeAll();
  for (const event of catalogEvents()) bus().publish(event);
  const handle = f.channel.sessions.get('fixture-channel')!;
  expect(handle.closeCalled).toBe(true);
  expect(handle.startCalled).toBe(false);
  expect(handle.receivedEvents).toEqual([]);
  expect(f.host.channels.list().every((channel) => !channel.live)).toBe(true);
  expect(f.host.dispatcherAgent.current).toBeNull();
  expect(f.provider.runtimes).toHaveLength(0);
  expect(build).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
});

it('rolls back a failed start in reverse-acquisition order, keeps Channel subscriptions live through runtime stop, and never rematerializes/closes durable entities', async () => {
  const order: string[] = [];
  const bus = observeBus();
  const f = await dispatcherFixture({
    channel: true,
    channelOptions: {
      record: (step) => order.push(step),
      failStart: () => new Error('channel start failed'),
    },
  });
  const originalStart = f.host.channels.start.bind(f.host.channels);
  const create = f.provider.createRuntime.bind(f.provider);
  vi.spyOn(f.provider, 'createRuntime').mockImplementation(async (context) => {
    const runtime = await create(context),
      stop = runtime.stop.bind(runtime);
    vi.spyOn(runtime, 'stop').mockImplementation(async () => {
      order.push('runtime.stop');
      context.activity({
        kind: 'assistant.message',
        id: 'last-word',
        occurredAt: Date.now(),
        text: 'stopping runtime still visible',
      });
      await stop();
    });
    return runtime;
  });
  let before = '',
    recordPath = '';
  let buildCallsAtFailure = 0;
  const build = vi.spyOn(UnbuiltAgent.prototype, 'build'),
    close = vi.spyOn(AgentService.prototype, 'close'),
    cleanup = vi.spyOn(WorktreeManager.prototype, 'cleanup');
  const drain = f.host.fence.drain.bind(f.host.fence);
  vi.spyOn(f.host.fence, 'drain').mockImplementation(async () => {
    order.push('admitted.drain');
    await drain();
  });
  const sweep = f.teams.stopForHost.bind(f.teams);
  vi.spyOn(f.teams, 'stopForHost').mockImplementation(async () => {
    order.push('teams.stopForHost');
    await sweep();
  });
  vi.spyOn(f.host.channels, 'start').mockImplementation(async (fence) => {
    await f.host.submitToAgent({
      source: 'channel',
      text: 'work accepted during channel startup',
    });
    const team = await f.teams.createFromRequest(
      teamRequest('dormant-during-start'),
    );
    recordPath = join(f.teamRoot, team.team_name, 'record.json');
    before = await readFile(recordPath, 'utf8');
    buildCallsAtFailure = build.mock.calls.length;
    await originalStart(fence);
  });
  await expect(f.host.start()).rejects.toThrow('channel start failed');
  const handle = f.channel.sessions.get('fixture-channel')!;
  expect(handle.closeCalled).toBe(true);
  expect(handle.receivedEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'teammate.activity',
        activity: expect.objectContaining({
          text: 'stopping runtime still visible',
        }),
      }),
    ]),
  );
  const seen = [...handle.receivedEvents];
  for (const event of catalogEvents()) bus().publish(event);
  expect(handle.receivedEvents).toEqual(seen);
  expect(order.indexOf('runtime.stop')).toBeLessThan(
    order.indexOf('channel:fixture-channel:close:begin'),
  );
  expect(order.filter((step) => step === 'teams.stopForHost')).toHaveLength(2);
  const sweepPositions = order.flatMap((step, index) =>
    step === 'teams.stopForHost' ? [index] : [],
  );
  expect(sweepPositions[0]).toBeLessThan(order.indexOf('admitted.drain'));
  expect(sweepPositions[1]).toBeGreaterThan(order.indexOf('admitted.drain'));
  expect(await readFile(recordPath, 'utf8')).toBe(before);
  expect(build.mock.calls).toHaveLength(buildCallsAtFailure);
  expect(close).not.toHaveBeenCalled();
  expect(cleanup).not.toHaveBeenCalled();
  expect(f.host.dispatcherAgent.current?.current().status).not.toBe('closed');
  expect(f.host.fence.isClosing()).toBe(true);
});

// R11 removed same-process reopen; startup after the terminal fence is refused.
it('the terminal close keeps the Channel port fenced and refuses a same-process restart', async () => {
  const f = await dispatcherFixture({ channel: true });
  await f.host.start();
  const handle = f.channel.sessions.get('fixture-channel')!;
  await f.host.close();
  await expect(
    handle.port!.invoke.invoke('team.list', {}),
  ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
  await expect(f.host.start()).rejects.toMatchObject({
    code: 'SERVER_SHUTTING_DOWN',
  });
  expect(f.channel.sessions.get('fixture-channel')).toBe(handle);
  expect(f.provider.runtimes).toHaveLength(0);
});
