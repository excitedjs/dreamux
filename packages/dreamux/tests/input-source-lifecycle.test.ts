/**
 * Coverage cell F: startup/shutdown ordering owned by
 * `DispatcherInputSourceLifecycle` (input-source-lifecycle.ts,
 * input-source-start-rollback.ts, runnable-channel.ts, team-runtime-stop.ts,
 * restart-notice.ts, inbound-task-drain.ts — see final.md section 4.1/4.2 and
 * the "Startup tests"/"Shutdown tests" bullets of section 7).
 *
 * Every non-Channel collaborator (`teams`, `teammates`, `workflows`,
 * `scheduler`) is a narrow hand-built fake that implements exactly the methods
 * this lifecycle calls on it, cast to its real type the way the repo's own
 * `team-leader-handle.test.ts` does. That is deliberate: if the class under
 * test ever calls a method these fakes do not implement, the test fails with a
 * "not a function" error instead of silently passing — which is how the
 * README "failure ledger" item 14 absence checks below actually work (a
 * dormant-entity materialization, a persisted `closed`, a retirement fact, or
 * worktree cleanup would all have to reach a method no fake here provides).
 *
 * The Channel side is the real `ChannelService` + real `createChannelCorePort`
 * + real `DispatcherCoreEventBus`, driving the hand-built fake `ChannelProvider`
 * from `helpers/fake-channel-provider.ts`. The dispatcher's own Agent is a real
 * `TeammateService` (via `createDispatcherAgent`/`ensureDispatcherRootIdentity`)
 * backed by a temp-dir `AgentIdentityStore`: its runtime is never activated in
 * these tests (no prior session, no restart-intent target), so construction and
 * `stopForHost()` are cheap and side-effect-free beyond the identity file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  ChannelCoreEvent,
  CoreCommandContext,
  DreamuxLogger,
  JsonValue,
} from '@excitedjs/dreamux-types';

import type { DispatcherChannelConfig, DreamuxConfig } from '../src/config/config.js';
import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createConversationProjection } from '../src/channel/conversation-projection.js';
import { ServerShuttingDownError } from '../src/platform/errors.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import type { TeammateAgentMcp } from '../src/service/teammate-service/types.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { DispatcherTaskDrain } from '../src/service/dispatcher-service/inbound-task-drain.js';
import { DispatcherInputSourceLifecycle } from '../src/service/dispatcher-service/input-source-lifecycle.js';
import type { DispatcherWorkflows } from '../src/service/dispatcher-service/dispatcher-workflows.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import type { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { SchedulerService } from '../src/service/scheduler/service.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  createFakeChannelProvider,
  type FakeChannelProviderResult,
} from './helpers/fake-channel-provider.js';

function silentLogger(): DreamuxLogger {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function channelCatalog(
  registrations: ReadonlyArray<{ ref: string; result: FakeChannelProviderResult }>,
): ChannelProviderCatalog {
  const registry = new ProviderRegistry();
  for (const { ref, result } of registrations) {
    const descriptor = { id: ref, kind: 'channel' as const, ref: parseProviderRef(ref) };
    registry.register(descriptor);
    registry.registerImplementation(descriptor.id, result.provider);
  }
  return new ChannelProviderCatalog({ registry });
}

/** A single fake TeamMate carrying only the surface rollback/stop reaches. */
function fakeTeammate(record: (label: string) => void, name: string): TeammateService {
  return {
    async stopForHost() {
      record(`teammate:${name}:stopForHost`);
    },
  } as unknown as TeammateService;
}

interface Harness {
  dreamuxRoot: string;
  cwd: string;
  recorder: string[];
  record: (label: string) => void;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  channelProviders: ChannelProviderCatalog;
  channels: ChannelService;
  coreEvents: DispatcherCoreEventBus;
  admittedTasks: DispatcherTaskDrain;
  commands: { context: CoreCommandContext; name: string; payload: JsonValue }[];
  fakeChannel: FakeChannelProviderResult;
  extraChannel: FakeChannelProviderResult | null;
  teams: TeamCollection;
  teammates: TeammateCollection;
  workflows: DispatcherWorkflows;
  scheduler: SchedulerService;
  materialized: TeammateService[];
  lifecycle: DispatcherInputSourceLifecycle;
}

/** Build a lifecycle with one configured channel and record-tracking fakes. */
async function buildHarness(options: {
  channelOptions?: Parameters<typeof createFakeChannelProvider>[0];
  /** A second channel, built here (not by the caller) so it shares `record`. */
  extraChannel?: {
    id: string;
    ref: string;
    options?: Parameters<typeof createFakeChannelProvider>[0];
  };
} = {}): Promise<Harness> {
  const dreamuxRoot = await mkdtemp(join(tmpdir(), 'dreamux-ils-root-'));
  const cwd = await mkdtemp(join(tmpdir(), 'dreamux-ils-cwd-'));
  process.env['DREAMUX_ROOT'] = dreamuxRoot;

  const recorder: string[] = [];
  const record = (label: string) => recorder.push(label);

  const fakeChannel = createFakeChannelProvider({
    record,
    ...(options.channelOptions ?? {}),
  });
  const channelRefs: { id: string; provider: DispatcherChannelConfig } = {
    id: 'primary',
    provider: { id: 'primary', provider: 'npm:@example/chan#create', config: {} },
  };
  const channels: DispatcherChannelConfig[] = [channelRefs.provider];
  const catalogRegistrations = [{ ref: 'npm:@example/chan#create', result: fakeChannel }];
  let extraChannelResult: FakeChannelProviderResult | null = null;
  if (options.extraChannel) {
    extraChannelResult = createFakeChannelProvider({
      record,
      ...(options.extraChannel.options ?? {}),
    });
    channels.push({ id: options.extraChannel.id, provider: options.extraChannel.ref, config: {} });
    catalogRegistrations.push({ ref: options.extraChannel.ref, result: extraChannelResult });
  }

  const config: DreamuxConfig = {
    agents: { flow: { provider: 'builtin:codex', config: {} } },
    dispatchers: [
      {
        id: 'flow',
        cwd,
        enabled: true,
        workspace: { enabled: true },
        channels,
        agentRuntime: 'flow',
        runtime: { provider: 'builtin:codex', config: {} },
      },
    ],
  };

  const dispatchers = new DispatcherStore(config);
  const channelProviders = channelCatalog(catalogRegistrations);
  const channelService = new ChannelService({
    dispatcherId: 'flow',
    config,
    channelProviders,
    channelLoggerFactory: () => silentLogger(),
  });
  const coreEvents = new DispatcherCoreEventBus({
    dispatcherId: 'flow',
    log: silentLogger(),
    maxSources: channels.length,
  });
  const admittedTasks = new DispatcherTaskDrain(() => "dispatcher 'flow' is shutting down");
  const originalDrain = admittedTasks.drain.bind(admittedTasks);
  admittedTasks.drain = async () => {
    record('admittedTasks.drain');
    return originalDrain();
  };

  const commands: { context: CoreCommandContext; name: string; payload: JsonValue }[] = [];
  const commandRegistry = {
    async invoke(context: CoreCommandContext, name: string, payload: JsonValue) {
      commands.push({ context, name, payload });
      return { ok: true } as JsonValue;
    },
  };

  const teams = {
    async recoverWorktreeCleanup() {
      record('teams.recoverWorktreeCleanup');
    },
    async startSchedulers() {
      record('teams.startSchedulers');
    },
    stopSchedulers() {
      record('teams.stopSchedulers');
    },
    async stopForHost() {
      record('teams.stopForHost');
    },
  } as unknown as TeamCollection;

  const materialized: TeammateService[] = [];
  const teammates = {
    materializedEntities: () => materialized,
  } as unknown as TeammateCollection;

  const workflows = {
    async recover() {
      record('workflows.recover');
    },
    async start() {
      record('workflows.start');
    },
    closeAdmission() {
      record('workflows.closeAdmission');
    },
    async rollbackStart() {
      record('workflows.rollbackStart');
    },
    async stopAll() {
      record('workflows.stopAll');
    },
  } as unknown as DispatcherWorkflows;

  const scheduler = {
    async start() {
      record('scheduler.start');
    },
    stop() {
      record('scheduler.stop');
    },
  } as unknown as SchedulerService;

  const identities = new (
    await import('../src/service/agent-entity/identity-store.js')
  ).AgentIdentityStore({
    dir: cwd,
    dispatcherId: 'flow',
    expectedName: null,
    log: silentLogger(),
    onPersisted: () => {},
  });
  const admissions = new AdmissionLedger();
  const conversationProjection = createConversationProjection({
    coreEvents: coreEvents.publisher,
    log: silentLogger(),
    homePathPrefixes: [],
  });
  const agentRuntimeProviders = new AgentRuntimeProviderCatalog({
    registry: new ProviderRegistry(),
  });

  const lifecycle = new DispatcherInputSourceLifecycle({
    dispatcherId: 'flow',
    config,
    dispatchers,
    channelProviders,
    agentRuntimeProviders,
    identities,
    admissions,
    conversationProjection,
    log: silentLogger(),
    channels: channelService,
    agentMcp: () =>
      ({ leases: {}, delegates: [], adminSocketPath: '' }) as unknown as TeammateAgentMcp,
    commands: commandRegistry,
    coreEvents,
    scheduler,
    teams,
    teammates,
    admittedTasks,
    workflows,
    isUnavailable: () => false,
    restartIntent: () => null,
  });

  return {
    dreamuxRoot,
    cwd,
    recorder,
    record,
    config,
    dispatchers,
    channelProviders,
    channels: channelService,
    coreEvents,
    admittedTasks,
    commands,
    fakeChannel,
    extraChannel: extraChannelResult,
    teams,
    teammates,
    workflows,
    scheduler,
    materialized,
    lifecycle,
  };
}

async function teardown(harness: Harness): Promise<void> {
  delete process.env['DREAMUX_ROOT'];
  await rm(harness.dreamuxRoot, { recursive: true, force: true });
  await rm(harness.cwd, { recursive: true, force: true });
}

function teamStateEvent(): ChannelCoreEvent {
  return {
    schema_version: 1,
    kind: 'team.state',
    occurred_at: Date.now(),
    team_name: 'alpha',
    leader_name: 'leader-alpha',
    status: 'running',
    teammates: [],
  };
}

function teammateStateEvent(): ChannelCoreEvent {
  return {
    schema_version: 1,
    kind: 'teammate.state',
    occurred_at: Date.now(),
    teammate_name: 'flow',
    role: 'dispatcher',
    team_name: null,
    status: 'running',
  };
}

function actorScope() {
  return {
    schema_version: 1 as const,
    occurred_at: Date.now(),
    teammate_name: 'flow',
    role: 'dispatcher' as const,
    team_name: null,
  };
}

function allCatalogEvents(): ChannelCoreEvent[] {
  return [
    teamStateEvent(),
    teammateStateEvent(),
    {
      ...actorScope(),
      kind: 'teammate.input',
      source: 'channel',
      source_id: null,
      content: 'hi',
      redacted: false,
    },
    {
      ...actorScope(),
      kind: 'teammate.activity',
      activity: {
        kind: 'assistant.message',
        event_id: 'evt-1',
        content: 'hi back',
        redacted: false,
      },
    },
  ];
}

describe('DispatcherInputSourceLifecycle: startup ordering', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await teardown(harness);
  });

  it('initializes and subscribes the Channel before recovering Core operations, then starts the Channel before ordinary admission opens', async () => {
    harness = await buildHarness({
      channelOptions: {
        invokeOnStart: [
          { command: 'team.submit', payload: { turn: 'x' } },
          { command: 'team.create', payload: { name: 'alpha' } },
        ],
      },
    });
    // Publish a fact from inside "recovery" (workflows.recover): it must be
    // observed by the primary channel's subscription, which the contract
    // requires be attached during `initialize`, strictly before recovery runs.
    const originalRecover = (harness.workflows as unknown as { recover: () => Promise<void> })
      .recover;
    (harness.workflows as unknown as { recover: () => Promise<void> }).recover = async () => {
      harness.coreEvents.publisher.publish('flow', teamStateEvent());
      await originalRecover.call(harness.workflows);
    };

    await harness.lifecycle.start();

    expect(harness.recorder).toEqual([
      'channel:primary:create',
      'channel:primary:initialize',
      'teams.recoverWorktreeCleanup',
      'workflows.recover',
      'channel:primary:start',
      'workflows.start',
      'scheduler.start',
      'teams.startSchedulers',
    ]);

    // Subscribe-before-admission: the event published mid-recovery reached the
    // session's own subscription, attached back at `initialize`.
    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.receivedEvents).toHaveLength(1);
    expect(handle?.receivedEvents[0]?.kind).toBe('team.state');

    // The Channel invoked `team.submit`/`team.create` through the exact same
    // admitted Command port an admin-socket caller uses, scoped to this
    // dispatcher/channel.
    expect(harness.commands).toEqual([
      {
        context: { source: 'channel', dispatcher_id: 'flow', channel_id: 'primary' },
        name: 'team.submit',
        payload: { turn: 'x' },
      },
      {
        context: { source: 'channel', dispatcher_id: 'flow', channel_id: 'primary' },
        name: 'team.create',
        payload: { name: 'alpha' },
      },
    ]);
  });

  it('delivers each of the four catalog event kinds to a subscribed Channel', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();

    for (const event of allCatalogEvents()) {
      harness.coreEvents.publisher.publish('flow', event);
    }

    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.receivedEvents.map((event) => event.kind)).toEqual([
      'team.state',
      'teammate.state',
      'teammate.input',
      'teammate.activity',
    ]);
  });

  it('a Channel that needs no events never subscribes', async () => {
    harness = await buildHarness({ channelOptions: { subscribe: false } });
    await harness.lifecycle.prepareChannels();

    harness.coreEvents.publisher.publish('flow', teamStateEvent());

    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.subscription).toBeNull();
    expect(handle?.receivedEvents).toEqual([]);
  });
});

describe('DispatcherInputSourceLifecycle: shutdown/rollback ordering and fencing', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await teardown(harness);
  });

  it('closeChannelPortAdmission() synchronously fences the Channel port: a post-fence Command rejects with ServerShuttingDownError, never a partial mutation', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();
    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.port).not.toBeNull();

    harness.lifecycle.closeChannelPortAdmission();

    await expect(
      handle!.port!.invoke.invoke('team.submit', { turn: 'late' }),
    ).rejects.toBeInstanceOf(ServerShuttingDownError);
    // The registry itself was never reached: the fence is synchronous and
    // pre-admission, so this is never an ambiguous partial mutation.
    expect(harness.commands).toEqual([]);
  });

  it('closePreparedChannels() closes built-but-unstarted sessions, clears the Channel service, and revokes Core event delivery — without materializing a dormant entity or persisting a close', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();

    await harness.lifecycle.closePreparedChannels();

    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.closeCalled).toBe(true);
    expect(harness.channels.live().size).toBe(0);
    expect(harness.channels.sessionMcp('primary')).toBeNull();

    // Revoked: a fact published after teardown reaches no one.
    harness.coreEvents.publisher.publish('flow', teamStateEvent());
    expect(handle?.receivedEvents).toEqual([]);

    // Item 14: the fakes above expose only `stopForHost`/scheduler/recover
    // methods. Nothing in this path called into `teams`/`teammates` at all —
    // discarding built-but-unstarted Channels never touches Team/TeamMate
    // lifecycle, so there is no route by which this path could materialize a
    // dormant entity, persist `closed`, or run worktree cleanup.
    expect(harness.recorder.filter((label) => label.startsWith('teams.'))).toEqual([]);
    expect(harness.recorder.filter((label) => label.startsWith('teammate:'))).toEqual([]);
  });

  it('rolls back a failed start in reverse-acquisition order, keeps Channel subscriptions live through runtime stop, and never rematerializes/closes durable entities', async () => {
    harness = await buildHarness({
      extraChannel: {
        id: 'secondary',
        ref: 'npm:@example/second#create',
        options: { failStart: () => new Error('secondary channel start failed') },
      },
    });
    const second = harness.extraChannel!;
    harness.materialized.push(fakeTeammate(harness.record, 'member-a'));

    // Publish one fact from inside the runtime-stop step (still-attached
    // subscription must observe it), and one right after rollback settles
    // (subscription must be revoked by then, so it must NOT be observed).
    const originalStopForHost = (harness.teams as unknown as { stopForHost: () => Promise<void> })
      .stopForHost;
    (harness.teams as unknown as { stopForHost: () => Promise<void> }).stopForHost = async () => {
      harness.coreEvents.publisher.publish('flow', teamStateEvent());
      await originalStopForHost.call(harness.teams);
    };

    await expect(harness.lifecycle.start()).rejects.toThrow(
      /secondary channel start failed/,
    );

    const primaryHandle = harness.fakeChannel.sessions.get('primary');
    const secondaryHandle = second.sessions.get('secondary');

    // The settlement fact published while runtimes were stopping reached the
    // still-live primary subscription.
    expect(primaryHandle?.receivedEvents.map((event) => event.kind)).toEqual(['team.state']);

    // Both sessions were closed as part of unwinding what this failed start
    // built; the secondary's own `start()` attempt (which failed) is recorded.
    expect(harness.recorder).toContain('channel:secondary:start:fail');
    expect(primaryHandle?.closeCalled).toBe(true);
    expect(secondaryHandle?.closeCalled).toBe(true);

    // A fact published after rollback fully settled reaches no one: the
    // subscription was revoked before this test's assertions run.
    harness.coreEvents.publisher.publish('flow', teamStateEvent());
    expect(primaryHandle?.receivedEvents.map((event) => event.kind)).toEqual(['team.state']);

    // Ordering: schedulers stop first, then runtimes converge (Team, then
    // materialized TeamMates, then the dispatcher Agent itself), THEN
    // subscriptions are revoked, THEN sessions are actually closed, THEN
    // accepted work drains, then the whole idempotent sweep repeats once.
    const relevant = harness.recorder.filter(
      (label) =>
        !label.includes(':create') || label.startsWith('channel:'),
    );
    const firstCloseIndex = relevant.findIndex((label) => label.endsWith(':close:begin'));
    const stopForHostIndex = relevant.indexOf('teams.stopForHost');
    const teammateStopIndex = relevant.indexOf('teammate:member-a:stopForHost');
    expect(stopForHostIndex).toBeGreaterThanOrEqual(0);
    expect(teammateStopIndex).toBeGreaterThan(stopForHostIndex);
    expect(firstCloseIndex).toBeGreaterThan(teammateStopIndex);
    expect(harness.recorder).toContain('admittedTasks.drain');
    // The idempotent late sweep repeats stopForHost at least once more.
    expect(
      harness.recorder.filter((label) => label === 'teams.stopForHost').length,
    ).toBeGreaterThanOrEqual(2);

    // Channels service was cleared, not merely closed-but-still-listed.
    expect(harness.channels.live().size).toBe(0);

    // Item 14 (host stop is not logical close): the fake Team/TeamMate
    // collaborators above expose only `stopForHost`/scheduler methods — nothing
    // resembling a dissolve, a durable `closed` write, a retirement fact, or
    // worktree cleanup exists on them to be reached. The rollback path only
    // ever called `stopForHost` on those two, never anything from that
    // vocabulary (the `channel:*:close` labels are the ordinary Channel-bridge
    // lifecycle, not a durable entity close, so they are excluded here).
    // The `teams`/`teammates` fakes above implement exactly three methods:
    // `recoverWorktreeCleanup` (startup recovery trigger, not a close),
    // `stopSchedulers`, and `stopForHost` (runtime-authority release). Nothing
    // resembling a dissolve, a durable `closed` write, a retirement fact, or a
    // worktree-deletion call exists on them to be reached — if the production
    // rollback path called anything else, that call would throw "not a
    // function" and this whole test would fail loud instead of passing
    // quietly. The exact multiset actually observed is this closed set:
    const teamOrTeammateLabels = harness.recorder
      .filter((label) => label.startsWith('teams.') || label.startsWith('teammate:'))
      .sort();
    expect(teamOrTeammateLabels).toEqual(
      [
        'teams.recoverWorktreeCleanup',
        'teams.stopForHost',
        'teams.stopForHost',
        'teams.stopSchedulers',
        'teammate:member-a:stopForHost',
        'teammate:member-a:stopForHost',
      ].sort(),
    );

    // A durable Agent this failed start never even ran (it exists but its
    // `stopForHost` on an inactive phase is the whole story) comes out
    // unchanged: `agent` is still readable and its identity file exists, but
    // nothing marked it closed.
    expect(harness.lifecycle.agent).not.toBeNull();
    expect(harness.lifecycle.agent?.current().status).not.toBe('closed');
  });

  it('markStopped() drops the held Channel-port fences so a later start initializes a fresh set', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();
    harness.lifecycle.closeChannelPortAdmission();
    const handle = harness.fakeChannel.sessions.get('primary');
    await expect(handle!.port!.invoke.invoke('team.submit', {})).rejects.toBeInstanceOf(
      ServerShuttingDownError,
    );

    // markStopped() is what a completed host stop calls; it must not throw and
    // must not itself touch the Channel session (that already happened via
    // closePreparedChannels/rollback in a real stop sequence).
    expect(() => harness.lifecycle.markStopped()).not.toThrow();
  });
});
