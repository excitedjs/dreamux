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
import { CoreCommandPort } from '../src/command/port.js';
import { CoreCommands } from '../src/command/registry.js';
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
import { fakeChannelCommand } from './helpers/command-harness.js';

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
  /** The real admitted port this lifecycle registers its Channel catalog into. */
  channelCommandPort: CoreCommandPort;
  /** Flip what `isUnavailable()` answers, as a real shutdown fence would. */
  setUnavailable: (value: boolean) => void;
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
  let unavailable = false;

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
  // The registration half is the real one, behind the real admitted port, so
  // the names these tests resolve are the names an admin.sock caller would.
  // Only the invoke half above is a fake, because these tests order the
  // lifecycle rather than exercise the Core catalog.
  const channelCommandPort = new CoreCommandPort(new CoreCommands([]));

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
    channelCommands: channelCommandPort,
    coreEvents,
    scheduler,
    teams,
    teammates,
    admittedTasks,
    workflows,
    isUnavailable: () => unavailable,
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
    channelCommandPort,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
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

function turnScope() {
  return {
    schema_version: 1 as const,
    occurred_at: Date.now(),
    teammate_name: 'flow',
    role: 'dispatcher' as const,
    team_name: null,
    turn_id: 'turn-1',
  };
}

function allCatalogEvents(): ChannelCoreEvent[] {
  return [
    teamStateEvent(),
    teammateStateEvent(),
    {
      ...turnScope(),
      kind: 'teammate.turn.submitted',
      turn_source: 'channel',
      source_id: null,
    },
    {
      ...turnScope(),
      kind: 'teammate.turn.settled',
      status: 'completed',
      assistant: 'done',
      assistant_truncated: false,
      redacted: false,
    },
    {
      ...turnScope(),
      kind: 'teammate.turn.message',
      event_id: 'evt-1',
      message_role: 'assistant',
      content: 'hi',
      content_truncated: false,
      redacted: false,
    },
    {
      ...turnScope(),
      kind: 'teammate.turn.tool_call',
      event_id: 'evt-2',
      call_id: 'call-1',
      tool_name: 'reply',
      tool_action: null,
      status: 'completed',
      arguments_json: null,
      result_json: null,
      arguments_truncated: false,
      result_truncated: false,
      redacted: false,
    },
    {
      schema_version: 1 as const,
      occurred_at: Date.now(),
      teammate_name: 'flow',
      role: 'dispatcher' as const,
      team_name: null,
      kind: 'teammate.native_turn.ended',
      status: 'completed',
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

  it('delivers each of the seven catalog event kinds to a subscribed Channel', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();

    for (const event of allCatalogEvents()) {
      harness.coreEvents.publisher.publish('flow', event);
    }

    const handle = harness.fakeChannel.sessions.get('primary');
    expect(handle?.receivedEvents.map((event) => event.kind)).toEqual([
      'team.state',
      'teammate.state',
      'teammate.turn.submitted',
      'teammate.turn.settled',
      'teammate.turn.message',
      'teammate.turn.tool_call',
      'teammate.native_turn.ended',
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

/** A promise a test settles by hand, to hold a Command handler open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CHANNEL_CALLER: CoreCommandContext = {
  source: 'channel',
  dispatcher_id: 'flow',
  channel_id: 'primary',
};

/** Invoke one Channel Command through the same admitted port an admin caller uses. */
function invokeChannelCommand(
  harness: Harness,
  name: string,
  payload: JsonValue = { note: 'x' },
  context: CoreCommandContext = CHANNEL_CALLER,
): Promise<JsonValue> {
  return harness.channelCommandPort.invoke(context, name, payload);
}

/** Whether the dispatcher currently holds a registration lease at all. */
function leaseIsFree(harness: Harness): boolean {
  try {
    harness.channelCommandPort.registerChannelCommands('flow', []).unregister();
    return true;
  } catch {
    return false;
  }
}

describe('DispatcherInputSourceLifecycle: Channel Command registration lifecycle', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await teardown(harness);
  });

  it('registers the whole catalog when Channels are built, and serves nothing until each session has started', async () => {
    harness = await buildHarness({
      channelOptions: { commands: [fakeChannelCommand('ping')] },
    });

    await harness.lifecycle.prepareChannels();

    // Resolvable immediately: a caller must not have to know channel start
    // order to learn the name exists.
    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([
      'channel.primary.ping',
    ]);
    expect(harness.lifecycle.channelCommandNames('primary')).toEqual([
      'channel.primary.ping',
    ]);
    await expect(invokeChannelCommand(harness, 'channel.primary.ping')).rejects.toMatchObject(
      { code: 'CHANNEL_COMMAND_UNAVAILABLE' },
    );

    await harness.lifecycle.start();
    await expect(invokeChannelCommand(harness, 'channel.primary.ping')).resolves.toEqual({
      echoed: 'x',
    });
  });

  it('opens admission per registration, at the moment that session own start returns', async () => {
    const observed: string[] = [];
    harness = await buildHarness({
      channelOptions: { commands: [fakeChannelCommand('ping')] },
      extraChannel: {
        id: 'secondary',
        ref: 'npm:@example/second#create',
        options: {
          commands: [fakeChannelCommand('ping')],
          // Runs inside `secondary.start()`, i.e. after primary started and
          // before secondary is published as live. Exactly the window where
          // "one registration at a time" is observable.
          onStart: async () => {
            observed.push(
              await invokeChannelCommand(harness, 'channel.primary.ping')
                .then(() => 'primary:served')
                .catch((error: { code?: string }) => `primary:${error.code}`),
            );
            observed.push(
              await invokeChannelCommand(
                harness,
                'channel.secondary.ping',
                { note: 'x' },
                { source: 'channel', dispatcher_id: 'flow', channel_id: 'secondary' },
              )
                .then(() => 'secondary:served')
                .catch((error: { code?: string }) => `secondary:${error.code}`),
            );
          },
        },
      },
    });

    await harness.lifecycle.start();

    expect(observed).toEqual([
      'primary:served',
      'secondary:CHANNEL_COMMAND_UNAVAILABLE',
    ]);
    // Both serve once the whole start returned.
    await expect(
      invokeChannelCommand(
        harness,
        'channel.secondary.ping',
        { note: 'x' },
        { source: 'channel', dispatcher_id: 'flow', channel_id: 'secondary' },
      ),
    ).resolves.toEqual({ echoed: 'x' });
  });

  it('an ordinary stop fences admission, drains what it accepted, closes the sessions, and only then revokes the catalog', async () => {
    const held = deferred();
    let record!: (label: string) => void;
    harness = await buildHarness({
      channelOptions: {
        commands: [
          fakeChannelCommand('slow', {
            async execute(_context, input) {
              record('command:slow:begin');
              await held.promise;
              record('command:slow:end');
              return { echoed: input.note };
            },
          }),
        ],
      },
    });
    record = harness.record;

    await harness.lifecycle.start();
    const inFlight = invokeChannelCommand(harness, 'channel.primary.slow');
    // Let the handler reach its await before the fence closes, so this is a
    // genuinely accepted call rather than one refused at the door.
    await Promise.resolve();
    expect(harness.recorder).toContain('command:slow:begin');

    // The stop sequence `DispatcherService.doStop` runs, in its order.
    let drained = false;
    const draining = harness.lifecycle.drainChannelCommands().then(() => {
      drained = true;
    });
    // Fenced synchronously: a call arriving now is refused, and the descriptor
    // says `closing` rather than `ready` from that same instant.
    await expect(invokeChannelCommand(harness, 'channel.primary.slow')).rejects.toMatchObject(
      { code: 'CHANNEL_COMMAND_UNAVAILABLE' },
    );
    expect(harness.lifecycle.channelDescriptors()).toEqual([
      {
        channel_id: 'primary',
        provider: 'npm:@example/chan#create',
        identity: null,
        commands: ['channel.primary.slow'],
        status: 'closing',
      },
    ]);
    await Promise.resolve();
    expect(drained).toBe(false);

    held.resolve();
    await draining;
    await expect(inFlight).resolves.toEqual({ echoed: 'x' });

    await harness.channels.closeAll(silentLogger());
    await harness.lifecycle.closePreparedChannels();
    harness.lifecycle.markStopped();

    // The accepted call finished before the session it ran against closed, and
    // the names went away only after that.
    const order = (label: string) => harness.recorder.indexOf(label);
    expect(order('command:slow:end')).toBeGreaterThan(order('command:slow:begin'));
    expect(order('channel:primary:close')).toBeGreaterThan(order('command:slow:end'));
    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    await expect(invokeChannelCommand(harness, 'channel.primary.slow')).rejects.toMatchObject(
      { code: 'UNKNOWN_METHOD' },
    );
    expect(harness.lifecycle.channelDescriptors()).toEqual([
      {
        channel_id: 'primary',
        provider: 'npm:@example/chan#create',
        identity: null,
        commands: [],
        status: 'closed',
      },
    ]);
    expect(leaseIsFree(harness)).toBe(true);
  });

  it('a prepare-only teardown revokes the catalog it registered, in the same order', async () => {
    harness = await buildHarness({
      channelOptions: { commands: [fakeChannelCommand('ping')] },
    });
    await harness.lifecycle.prepareChannels();
    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([
      'channel.primary.ping',
    ]);

    await harness.lifecycle.closePreparedChannels();

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    expect(leaseIsFree(harness)).toBe(true);
    expect(harness.lifecycle.channelDescriptors()[0]?.status).toBe('closed');
  });

  it('a failed start revokes the whole batch, including the Channel that had already started', async () => {
    harness = await buildHarness({
      channelOptions: { commands: [fakeChannelCommand('ping')] },
      extraChannel: {
        id: 'secondary',
        ref: 'npm:@example/second#create',
        options: {
          commands: [fakeChannelCommand('ping')],
          failStart: () => new Error('secondary channel start failed'),
        },
      },
    });

    await expect(harness.lifecycle.start()).rejects.toThrow(
      /secondary channel start failed/,
    );

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    await expect(invokeChannelCommand(harness, 'channel.primary.ping')).rejects.toMatchObject(
      { code: 'UNKNOWN_METHOD' },
    );
    // The lease went with it, so the retry a failed start invites can register.
    expect(leaseIsFree(harness)).toBe(true);
    expect(harness.lifecycle.channelDescriptors().map((c) => c.status)).toEqual([
      'closed',
      'closed',
    ]);
  });

  it('a shutdown that lands while build() is still running registers no catalog at all', async () => {
    harness = await buildHarness({
      channelOptions: {
        commands: [fakeChannelCommand('ping')],
        onCreateSession: () => {
          harness.setUnavailable(true);
        },
      },
    });

    await expect(harness.lifecycle.prepareChannels()).rejects.toThrow(/shutting down/);

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    harness.setUnavailable(false);
    expect(leaseIsFree(harness)).toBe(true);
  });

  it('a definitions() call that synchronously begins a shutdown leaves no catalog and no lease', async () => {
    // `definitions()` is Channel-owned code Core runs synchronously while
    // assembling the catalog: it can reach back into its own dispatcher and
    // start a stop before the last source is even collected.
    harness = await buildHarness({
      channelOptions: {
        commands: () => {
          harness.setUnavailable(true);
          return [fakeChannelCommand('ping')];
        },
      },
    });

    await expect(harness.lifecycle.prepareChannels()).rejects.toThrow(/shutting down/);

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    harness.setUnavailable(false);
    expect(leaseIsFree(harness)).toBe(true);
  });

  it('a definitions() call that begins a shutdown asynchronously has its already-registered catalog revoked', async () => {
    // The harder half of the same hazard: the fence lands *after* the catalog
    // is in the registry, so correctness depends on the failed prepare
    // unwinding what it registered rather than on the fence arriving in time.
    harness = await buildHarness({
      channelOptions: {
        commands: () => {
          queueMicrotask(() => harness.setUnavailable(true));
          return [fakeChannelCommand('ping')];
        },
      },
    });

    await expect(harness.lifecycle.prepareChannels()).rejects.toThrow(/shutting down/);

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    harness.setUnavailable(false);
    expect(leaseIsFree(harness)).toBe(true);
    expect(harness.fakeChannel.sessions.get('primary')?.closeCalled).toBe(true);
  });

  it('a Channel that declares no Commands still gets a registration, so it has a fence of its own', async () => {
    harness = await buildHarness();
    await harness.lifecycle.prepareChannels();

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    // Registered-but-empty is not the same as unregistered: the descriptor
    // still describes a live Channel rather than a closed one.
    expect(harness.lifecycle.channelDescriptors()[0]).toEqual({
      channel_id: 'primary',
      provider: 'npm:@example/chan#create',
      identity: null,
      commands: [],
      status: 'starting',
    });
    expect(leaseIsFree(harness)).toBe(false);
  });

  it('a retry after a fenced prepare registers a fresh catalog and stops reporting the previous fence', async () => {
    // The retryable teardown this lifecycle actually supports: a prepare that
    // never got as far as adopting an Agent. It fenced admission on the way
    // out, so the fence must belong to the run that closed it — not to the one
    // that registers next.
    let refuse = true;
    harness = await buildHarness({
      channelOptions: {
        commands: () => {
          if (refuse) harness.setUnavailable(true);
          return [fakeChannelCommand('ping')];
        },
      },
    });
    await expect(harness.lifecycle.prepareChannels()).rejects.toThrow(/shutting down/);
    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([]);
    expect(harness.lifecycle.channelDescriptors()[0]?.status).toBe('closed');

    refuse = false;
    harness.setUnavailable(false);
    await harness.lifecycle.start();

    expect(harness.channelCommandPort.channelCommandNames('flow')).toEqual([
      'channel.primary.ping',
    ]);
    expect(harness.lifecycle.channelDescriptors()[0]?.status).toBe('ready');
    await expect(invokeChannelCommand(harness, 'channel.primary.ping')).resolves.toEqual({
      echoed: 'x',
    });
  });
});
