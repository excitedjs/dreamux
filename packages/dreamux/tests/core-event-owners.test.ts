import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ChannelCoreEvent, TeammateRole } from '@excitedjs/dreamux-types';
import {
  agentIdentityPath,
  collectionEntityDir,
  dispatcherDir,
  teamMateCollectionDir,
} from '../src/platform/paths.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { AgentRuntimeStateStore } from '../src/service/agent/runtime-state.js';
import { UnbuiltAgent } from '../src/service/agent/factory.js';
import {
  makeIdentityCreateInput,
  makeIdentityStore,
  makeTempDir,
  removeTempDir,
} from './helpers/event-harness.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());
type StateEvent = Extract<ChannelCoreEvent, { kind: 'teammate.state' }>;
type TeamEvent = Extract<ChannelCoreEvent, { kind: 'team.state' }>;
const states = (events: readonly ChannelCoreEvent[]) =>
  events.filter((e): e is StateEvent => e.kind === 'teammate.state');
const teams = (events: readonly ChannelCoreEvent[]) =>
  events.filter((e): e is TeamEvent => e.kind === 'team.state');
async function liveFixture() {
  const f = await dispatcherFixture({ channel: true });
  await f.host.start();
  const session = f.channel.sessions.get('fixture-channel');
  if (!session?.port) throw new Error('missing initialized Channel');
  return { ...f, session, events: session.receivedEvents };
}
function identityFile(
  f: Awaited<ReturnType<typeof liveFixture>>,
  event: StateEvent,
) {
  const owner =
    event.teamName === null
      ? dispatcherDir('test')
      : join(f.teamRoot, event.teamName);
  return agentIdentityPath(
    event.role === 'teammate'
      ? collectionEntityDir(teamMateCollectionDir(owner), event.teammateName)
      : owner,
  );
}
describe('durable identity observations', () => {
  it('publishes the first committed observation only after its identity file exists with the committed value', async () => {
    const dir = await makeTempDir('identity-first-fact');
    try {
      const store = makeIdentityStore({ dir });
      const atPublish: unknown[] = [];
      store.committed.on('committed', (identity) =>
        atPublish.push({
          identity,
          disk: JSON.parse(readFileSync(agentIdentityPath(dir), 'utf8')),
        }),
      );
      const created = await store.create(
        makeIdentityCreateInput({ name: 'scout' }),
      );
      expect(atPublish).toEqual([{ identity: created, disk: created }]);
    } finally {
      await removeTempDir(dir);
    }
  });
  it('publishes later status transitions but no same-status field update', async () => {
    const dir = await makeTempDir('identity-transition');
    try {
      const store = makeIdentityStore({ dir });
      const seen: string[] = [];
      store.committed.on('committed', (identity) => seen.push(identity.status));
      await store.create(
        makeIdentityCreateInput({ name: 'scout', status: 'starting' }),
      );
      await store.update({ status: 'running' });
      await store.update({ intent: 'new intent' });
      expect(seen).toEqual(['starting', 'running']);
      expect((await store.read())?.intent).toBe('new intent');
    } finally {
      await removeTempDir(dir);
    }
  });
  it('keeps role out of committed and persisted identity facts', async () => {
    const dir = await makeTempDir('identity-no-role');
    try {
      const store = makeIdentityStore({ dir });
      const seen: unknown[] = [];
      store.committed.on('committed', (identity) => seen.push(identity));
      await store.create(makeIdentityCreateInput());
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toHaveProperty('role');
      expect(
        JSON.parse(await readFile(agentIdentityPath(dir), 'utf8')),
      ).not.toHaveProperty('role');
    } finally {
      await removeTempDir(dir);
    }
  });
  it('a failed identity write emits no committed observation', async () => {
    const dir = await makeTempDir('identity-failed-write');
    try {
      await mkdir(agentIdentityPath(dir));
      const store = makeIdentityStore({ dir });
      const seen: unknown[] = [];
      store.committed.on('committed', (identity) => seen.push(identity));
      await expect(store.create(makeIdentityCreateInput())).rejects.toThrow();
      expect(seen).toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });
  it('opening a new runtime generation revokes the old lease permanently', async () => {
    const dir = await makeTempDir('runtime-generation');
    try {
      const store = makeIdentityStore({ dir });
      const identity = await store.create(makeIdentityCreateInput());
      const state = new AgentRuntimeStateStore(store, identity);
      const first = state.leaseRuntimeGeneration();
      expect(first.isCurrent()).toBe(true);
      const second = state.leaseRuntimeGeneration();
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(true);
      state.revokeRuntimeGeneration();
      expect(first.isCurrent()).toBe(false);
      expect(second.isCurrent()).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });
});
it('publishes Dispatcher, standalone TeamMate, TeamLeader, and member roles through the actual factory and bus', async () => {
  const f = await liveFixture();
  const root = states(f.events).find((event) => event.role === 'dispatcher');
  expect(root).toMatchObject({ teamName: null });
  const observed: Array<{ event: StateEvent; disk: unknown }> = [];
  f.session.port!.events.subscribe((event) => {
    if (event.kind === 'teammate.state')
      observed.push({
        event,
        disk: JSON.parse(readFileSync(identityFile(f, event), 'utf8')),
      });
  });
  const standalone = await f.host.teammates.spawn({
    name: 'standalone',
    intent: 'Observe roles',
    prompt: 'go',
    agentRuntime: 'controlled',
  });
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  const member = await team.teammates.spawn({
    name: 'member',
    intent: 'Observe roles',
    prompt: 'go',
    agentRuntime: 'controlled',
  });
  expect(states(f.events)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        teammateName: standalone.teammate.name,
        role: 'teammate',
        teamName: null,
      }),
      expect.objectContaining({
        teammateName: created.leader_name,
        role: 'team_leader',
        teamName: created.team_name,
      }),
      expect.objectContaining({
        teammateName: member.teammate.name,
        role: 'teammate',
        teamName: created.team_name,
      }),
    ]),
  );
  expect(observed.length).toBeGreaterThanOrEqual(3);
  for (const { event, disk } of observed) {
    expect(disk).toMatchObject({
      name: event.teammateName,
      status: event.status,
      team_id: event.teamName,
    });
    expect(disk).not.toHaveProperty('role');
  }
  expectTypeOf<TeammateRole>().toEqualTypeOf<
    'dispatcher' | 'teammate' | 'team_leader'
  >();
});
it('publishes creation and running transitions once despite the initial prompt repeated running write', async () => {
  const f = await liveFixture();
  f.events.length = 0;
  const created = await f.teams.createFromRequest(
    teamRequest('creation-events', 'Initial work'),
  );
  const aggregates = teams(f.events).filter(
    (event) => event.teamName === created.team_name,
  );
  expect(
    aggregates.map((event) => ({
      status: event.status,
      teammates: event.teammates,
    })),
  ).toEqual([
    { status: 'starting', teammates: [] },
    {
      status: 'starting',
      teammates: [
        {
          teammateName: created.leader_name,
          role: 'team_leader',
          status: 'starting',
        },
      ],
    },
    {
      status: 'running',
      teammates: [
        {
          teammateName: created.leader_name,
          role: 'team_leader',
          status: 'starting',
        },
      ],
    },
  ]);
  const leaderIndex = f.events.findIndex(
    (event) =>
      event.kind === 'teammate.state' &&
      event.teammateName === created.leader_name,
  );
  expect(f.events[leaderIndex + 1]).toBe(aggregates[1]);
});
it('publishes a new member before launch hooks and republishes status changes after teammate.state', async () => {
  const f = await liveFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  f.events.length = 0;
  let atLaunch: ChannelCoreEvent[] = [];
  f.host.hooks.teammateLaunch.tapPromise('observe-roster', async () => {
    atLaunch = f.events.slice();
  });
  const result = await team.teammates.spawn({
    name: 'member',
    intent: 'Observe roster',
    prompt: 'go',
    agentRuntime: 'controlled',
  });
  const memberName = result.teammate.name;
  expect(atLaunch[0]).toMatchObject({
    kind: 'teammate.state',
    teammateName: memberName,
    role: 'teammate',
    status: 'stopped',
  });
  expect(atLaunch[1]).toMatchObject({
    kind: 'team.state',
    teammates: expect.arrayContaining([
      { teammateName: memberName, role: 'teammate', status: 'stopped' },
    ]),
  });
  f.events.length = 0;
  const runtime = f.provider.runtimes[0]!;
  await runtime.context.state.publish({ kind: 'status', status: 'ready' });
  expect(f.events.map((event) => event.kind)).toEqual([
    'teammate.state',
    'team.state',
  ]);
  expect(f.events[0]).toMatchObject({
    teammateName: memberName,
    status: 'running',
  });
  const aggregate = teams(f.events)[0]!;
  expect(aggregate.teammates).toContainEqual({
    teammateName: memberName,
    role: 'teammate',
    status: 'running',
  });
  expect(
    aggregate.teammates.every(
      (row) => row.role === 'team_leader' || row.role === 'teammate',
    ),
  ).toBe(true);
  f.events.length = 0;
  await runtime.context.state.publish({
    kind: 'session',
    sessionId: 'session-one',
  });
  expect(f.events).toEqual([]);
});
it('publishes the durable Team closed fact and leaves that aggregate closed throughout child teardown', async () => {
  const f = await liveFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  f.events.length = 0;
  const diskAtClosed: unknown[] = [];
  f.session.port!.events.subscribe((event) => {
    if (event.kind === 'team.state' && event.status === 'closed')
      diskAtClosed.push(
        JSON.parse(
          readFileSync(
            join(f.teamRoot, created.team_name, 'record.json'),
            'utf8',
          ),
        ),
      );
  });
  await f.teams.dissolve(created.team_name, { note: 'Finish', force: true });
  await team.closed;
  expect(diskAtClosed.length).toBeGreaterThan(0);
  for (const disk of diskAtClosed)
    expect(disk).toMatchObject({ status: 'closed' });
  expect(teams(f.events).every((event) => event.status === 'closed')).toBe(
    true,
  );
  expect(teams(f.events).at(-1)?.teammates).toContainEqual({
    teammateName: created.leader_name,
    role: 'team_leader',
    status: 'closed',
  });
});
it('drops revoked runtime activity and state while a replacement generation still publishes', async () => {
  const f = await liveFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  const spawned = await team.teammates.spawn({
    name: 'member',
    intent: 'Lease lifetime',
    prompt: 'go',
    agentRuntime: 'controlled',
  });
  const old = f.provider.runtimes[0]!;
  f.events.length = 0;
  old.context.activity({
    kind: 'assistant.message',
    id: 'first',
    occurredAt: Date.now(),
    text: 'before close',
  });
  expect(f.events).toEqual([
    expect.objectContaining({
      kind: 'teammate.activity',
      activity: expect.objectContaining({ text: 'before close' }),
    }),
  ]);
  await team.teammates.close({
    name: spawned.teammate.name,
    note: 'Retire generation',
  });
  await team.teammates.send({ name: spawned.teammate.name, prompt: 'Reopen' });
  const current = f.provider.runtimes[1]!;
  f.events.length = 0;
  expect(() =>
    old.context.activity({
      kind: 'assistant.message',
      id: 'late',
      occurredAt: Date.now(),
      text: 'stale',
    }),
  ).not.toThrow();
  await expect(
    Promise.resolve().then(() =>
      old.context.state.publish({ kind: 'status', status: 'ready' }),
    ),
  ).rejects.toMatchObject({ name: 'AgentRuntimeStateLeaseRevokedError' });
  expect(f.events).toEqual([]);
  current.context.activity({
    kind: 'assistant.message',
    id: 'current',
    occurredAt: Date.now(),
    text: 'replacement',
  });
  expect(f.events).toEqual([
    expect.objectContaining({
      kind: 'teammate.activity',
      activity: expect.objectContaining({ text: 'replacement' }),
    }),
  ]);
});
it('closes an unmaterialized member from its record and publishes identity before the final aggregate', async () => {
  const f = await liveFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const originalTeam = await f.teams.open(created.team_name);
  const spawned = await originalTeam.teammates.spawn({
    name: 'record-only',
    intent: 'Restore close facts',
    prompt: 'work',
    agentRuntime: 'controlled',
  });
  await f.host.close();
  const runtimeCount = f.provider.runtimes.length;
  const built: string[] = [];
  const build = UnbuiltAgent.prototype.build;
  vi.spyOn(UnbuiltAgent.prototype, 'build').mockImplementation(function (
    this: UnbuiltAgent,
    ...args: Parameters<UnbuiltAgent['build']>
  ) {
    built.push(this.identity.name);
    return build.apply(this, args);
  });
  const next = f.build();
  await next.host.start();
  const session = f.channel.sessions.get('fixture-channel');
  if (!session) throw new Error('missing replacement channel');
  expect(
    states(session.receivedEvents).some(
      (event) => event.teammateName === spawned.teammate.name,
    ),
  ).toBe(false);
  const team = await next.teams.open(created.team_name);
  session.receivedEvents.length = 0;
  await next.teams.dissolve(created.team_name, {
    note: 'Close at rest',
    force: true,
  });
  await team.closed;
  expect(built).not.toContain(spawned.teammate.name);
  expect(f.provider.runtimes).toHaveLength(runtimeCount);
  const index = session.receivedEvents.findIndex(
    (event) =>
      event.kind === 'teammate.state' &&
      event.teammateName === spawned.teammate.name &&
      event.status === 'closed',
  );
  expect(index).toBeGreaterThanOrEqual(0);
  expect(session.receivedEvents[index + 1]).toMatchObject({
    kind: 'team.state',
    status: 'closed',
    teammates: expect.arrayContaining([
      {
        teammateName: spawned.teammate.name,
        role: 'teammate',
        status: 'closed',
      },
    ]),
  });
  const memberPath = agentIdentityPath(
    collectionEntityDir(
      teamMateCollectionDir(join(f.teamRoot, created.team_name)),
      spawned.teammate.name,
    ),
  );
  expect(JSON.parse(await readFile(memberPath, 'utf8'))).toMatchObject({
    status: 'closed',
    close_note: 'Close at rest',
  });
});

it('publishes no Team aggregate without a source and resumes publication for later subscribers', async () => {
  const f = await dispatcherFixture({ channel: true });
  const published = vi.spyOn(DispatcherCoreEventBus.prototype, 'publish');
  const created = await f.teams.createFromRequest(teamRequest('no-listener'));
  expect(
    published.mock.calls.filter(([event]) => event.kind === 'team.state'),
  ).toEqual([]);
  await f.host.start();
  const channel = f.channel.sessions.get('fixture-channel')!;
  expect(
    channel.receivedEvents.filter((event) => event.kind === 'team.state'),
  ).toEqual([]);
  await f.teams.submitToLeader(created.team_name, {
    source: 'channel',
    text: 'Now observed',
    deliverCompletionToDispatcher: false,
  });
  await f.provider.runtimes[0]!.context.state.publish({
    kind: 'status',
    status: 'ready',
  });
  expect(channel.receivedEvents).toContainEqual(
    expect.objectContaining({
      kind: 'team.state',
      teamName: created.team_name,
      teammates: expect.arrayContaining([
        expect.objectContaining({ role: 'team_leader', status: 'running' }),
      ]),
    }),
  );
  expect(
    published.mock.calls.some(([event]) => event.kind === 'team.state'),
  ).toBe(true);
});

it('skips identity publication without sources while preserving durable observations and the roster for later subscribers', async () => {
  const f = await dispatcherFixture({ channel: true });
  const published = vi.spyOn(DispatcherCoreEventBus.prototype, 'publish');
  const created = await f.teams.createFromRequest(
    teamRequest('identity-without-audience'),
  );
  const team = await f.teams.open(created.team_name);
  const spawned = await team.teammates.spawn({
    name: 'unobserved-member',
    intent: 'Keep identity and roster facts without an audience',
    prompt: 'Begin work',
    agentRuntime: 'controlled',
  });
  const member = f.provider.runtimes[0]!;
  await member.context.state.publish({ kind: 'status', status: 'ready' });
  const memberPath = agentIdentityPath(
    collectionEntityDir(
      teamMateCollectionDir(join(f.teamRoot, created.team_name)),
      spawned.teammate.name,
    ),
  );
  expect(JSON.parse(await readFile(memberPath, 'utf8'))).toMatchObject({
    name: spawned.teammate.name,
    status: 'running',
    team_id: created.team_name,
    intent: 'Keep identity and roster facts without an audience',
  });
  expect(
    published.mock.calls.filter(
      ([event]) =>
        event.kind === 'teammate.state' || event.kind === 'team.state',
    ),
  ).toEqual([]);

  await f.host.start();
  const session = f.channel.sessions.get('fixture-channel');
  if (!session?.port) throw new Error('missing initialized Channel');
  // Starting a source does not replay identities or aggregate facts committed
  // before it existed. The Dispatcher may publish its own new identity here.
  expect(
    states(session.receivedEvents).filter(
      (event) => event.teamName === created.team_name,
    ),
  ).toEqual([]);
  expect(teams(session.receivedEvents)).toEqual([]);

  await f.teams.submitToLeader(created.team_name, {
    source: 'channel',
    text: 'Now observe the leader',
    deliverCompletionToDispatcher: false,
  });
  const leader = f.provider.runtimes[1]!;
  const diskAtPublication: unknown[] = [];
  session.port.events.subscribe((event) => {
    if (
      event.kind === 'teammate.state' &&
      event.teammateName === created.leader_name
    ) {
      diskAtPublication.push(
        JSON.parse(
          readFileSync(
            agentIdentityPath(join(f.teamRoot, created.team_name)),
            'utf8',
          ),
        ),
      );
    }
  });
  session.receivedEvents.length = 0;
  await leader.context.state.publish({ kind: 'status', status: 'ready' });
  expect(session.receivedEvents.map((event) => event.kind)).toEqual([
    'teammate.state',
    'team.state',
  ]);
  expect(states(session.receivedEvents)).toEqual([
    expect.objectContaining({
      teammateName: created.leader_name,
      teamName: created.team_name,
      role: 'team_leader',
      status: 'running',
    }),
  ]);
  expect(diskAtPublication).toEqual([
    expect.objectContaining({ name: created.leader_name, status: 'running' }),
  ]);
  expect(teams(session.receivedEvents)[0]).toMatchObject({
    teamName: created.team_name,
    teammates: expect.arrayContaining([
      {
        teammateName: created.leader_name,
        role: 'team_leader',
        status: 'running',
      },
      {
        teammateName: spawned.teammate.name,
        role: 'teammate',
        status: 'running',
      },
    ]),
  });
});
