/**
 * Coverage cell C (event half), Stage 9 node "core-events".
 *
 * Covers the seven-kind Core event catalog, the dispatcher-scoped live bus's
 * best-effort delivery and subscription-lifecycle guarantees
 * (`service/dispatcher-core-events/`), the `teammate.state` role catalog and
 * `team.state` redundant-aggregate republication rule
 * (`service/team-collection/store.ts`, `service/team-service/roster-projection.ts`,
 * `service/agent-entity/identity-store.ts`), and turn-event correlation by
 * `turn_id` alone (`channel/conversation-projection.ts`).
 *
 * `tests/cot-projection-privacy.test.ts` owns the redaction/truncation half of
 * the conversation projection; this file owns everything else about the
 * catalog.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCoreEvent,
  TeamStateTeammateSummary,
} from '@excitedjs/dreamux-types';

import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { sealChannelCoreEvent } from '../src/service/dispatcher-core-events/seal.js';
import {
  createConversationProjection,
  type ProjectedAgent,
} from '../src/channel/conversation-projection.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { TeamRosterProjection } from '../src/service/team-service/roster-projection.js';
import {
  AgentEntityCollectionStore,
} from '../src/service/agent-entity/identity-store.js';
import { AgentRuntimeStateStore } from '../src/service/agent-entity/runtime-state.js';
import {
  createCapturingLogger,
  createCapturingPublisher,
  makeIdentity,
  makeIdentityCreateInput,
  makeIdentityStore,
  makeTempDir,
  removeTempDir,
} from './helpers/event-harness.js';

const DISPATCHER_ID = 'dispatcher-fixture';

function baseScope(overrides: Partial<{
  teammate_name: string;
  role: 'dispatcher' | 'teammate' | 'team_leader';
  team_name: string | null;
  turn_id: string;
}> = {}) {
  return {
    schema_version: 1 as const,
    occurred_at: Date.now(),
    teammate_name: 'scout',
    role: 'teammate' as const,
    team_name: 'alpha',
    turn_id: 'turn-1',
    ...overrides,
  };
}

/** One minimal, schema-valid fixture for every kind the catalog union admits. */
function catalogFixtures(): Record<ChannelCoreEvent['kind'], ChannelCoreEvent> {
  return {
    'team.state': {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: Date.now(),
      team_name: 'alpha',
      leader_name: 'alpha-leader',
      status: 'running',
      teammates: [],
    },
    'teammate.state': {
      schema_version: 1,
      kind: 'teammate.state',
      occurred_at: Date.now(),
      teammate_name: 'alpha-leader',
      role: 'team_leader',
      team_name: 'alpha',
      status: 'running',
    },
    'teammate.turn.submitted': {
      ...baseScope(),
      kind: 'teammate.turn.submitted',
      turn_source: 'feishu',
    },
    'teammate.turn.settled': {
      ...baseScope(),
      kind: 'teammate.turn.settled',
      status: 'completed',
      assistant: 'done',
      assistant_truncated: false,
      redacted: false,
    },
    'teammate.turn.message': {
      ...baseScope(),
      kind: 'teammate.turn.message',
      event_id: 'evt-1',
      message_role: 'user',
      content: 'hi',
      content_truncated: false,
      redacted: false,
    },
    'teammate.turn.tool_call': {
      ...baseScope(),
      kind: 'teammate.turn.tool_call',
      event_id: 'evt-2',
      call_id: 'call-1',
      tool_name: 'read_file',
      tool_action: 'read',
      status: 'completed',
      arguments_json: '{}',
      result_json: '{}',
      arguments_truncated: false,
      result_truncated: false,
      redacted: false,
    },
    // The one actor-scoped turn fact: a provider folds any number of logical
    // submissions into one native turn, so this event deliberately carries no
    // `turn_id` — only who the runtime belongs to and how it stopped.
    'teammate.native_turn.ended': {
      schema_version: 1,
      kind: 'teammate.native_turn.ended',
      occurred_at: Date.now(),
      teammate_name: 'alpha-leader',
      role: 'team_leader',
      team_name: 'alpha',
      status: 'completed',
    },
  };
}

function makeTeamRecordInput(
  overrides: Partial<Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'>> = {},
): Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'> {
  return {
    dispatcher_id: DISPATCHER_ID,
    team_id: 'alpha',
    name: 'alpha',
    repo_cwd: '/workspace/repo',
    source_repo: null,
    leader_name: 'alpha-leader',
    leader_agent_runtime: 'fixture-runtime',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: '/workspace/repo',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/workspace/repo',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    status: 'starting',
    intent: null,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
    ...overrides,
  };
}

describe('the published Core event catalog is exactly seven kinds', () => {
  it('accepts a schema-valid fixture of every catalog kind', () => {
    const fixtures = catalogFixtures();
    for (const [kind, event] of Object.entries(fixtures)) {
      const sealed = sealChannelCoreEvent(event);
      expect(sealed, `kind ${kind} should seal`).not.toBeNull();
      expect(sealed?.kind).toBe(kind);
    }
  });

  it('rejects every deleted or never-added event kind', () => {
    // Binding, Collaboration Space, Workflow, scheduler, host-maintenance, and
    // a separate creation event are all deliberately absent from the union
    // (see channel.ts doc comment); a stray publisher naming one of these
    // kinds must be dropped, not silently accepted.
    const rejectedKinds = [
      'team.binding',
      'channel.binding.route',
      'collaboration_space.updated',
      'workflow.updated',
      'workflow.run.started',
      'scheduler.tick',
      'host.maintenance',
      'teammate.created',
      'team.transfer_back',
    ];
    const base = baseScope();
    for (const kind of rejectedKinds) {
      const event = { ...base, kind } as unknown as ChannelCoreEvent;
      expect(sealChannelCoreEvent(event), `kind ${kind} must be rejected`).toBeNull();
    }
  });

  it('rejects a schema_version other than 1', () => {
    const event = { ...catalogFixtures()['teammate.state'], schema_version: 2 } as unknown as ChannelCoreEvent;
    expect(sealChannelCoreEvent(event)).toBeNull();
  });

  it('rejects a non-finite occurred_at', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const event = { ...catalogFixtures()['teammate.state'], occurred_at: bad } as unknown as ChannelCoreEvent;
      expect(sealChannelCoreEvent(event)).toBeNull();
    }
  });

  it('deep-freezes a sealed event so no listener can rewrite a broadcast fact', () => {
    const sealed = sealChannelCoreEvent(catalogFixtures()['teammate.turn.message']);
    expect(sealed).not.toBeNull();
    expect(Object.isFrozen(sealed)).toBe(true);
  });
});

describe('DispatcherCoreEventBus: live, best-effort delivery', () => {
  function makeBus(maxSources = 4) {
    const { logger, warnCalls, errorCalls } = createCapturingLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: DISPATCHER_ID,
      log: logger,
      maxSources,
    });
    return { bus, warnCalls, errorCalls };
  }

  it('drops and logs an event outside the seven-kind catalog instead of delivering it', () => {
    const { bus, errorCalls } = makeBus();
    const source = bus.createSource('channel-a');
    const received: ChannelCoreEvent[] = [];
    source.source.subscribe((event) => { received.push(event); });

    bus.publisher.publish(DISPATCHER_ID, {
      ...baseScope(),
      kind: 'not.a.catalog.kind',
    } as unknown as ChannelCoreEvent);

    expect(received).toHaveLength(0);
    expect(errorCalls.some((c) => c.message === 'dispatcher core event is not a publishable catalog event')).toBe(true);
  });

  it('drops and logs an event scoped to a different dispatcher rather than deliver it', () => {
    const { bus, errorCalls } = makeBus();
    const source = bus.createSource('channel-a');
    const received: ChannelCoreEvent[] = [];
    source.source.subscribe((event) => { received.push(event); });

    bus.publisher.publish('some-other-dispatcher', catalogFixtures()['teammate.state']);

    expect(received).toHaveLength(0);
    expect(errorCalls.some((c) => c.message === 'dispatcher core event scope mismatch')).toBe(true);
  });

  it('publish() is a void call: no listener promise can ever be awaited to gate a Core operation', () => {
    const { bus } = makeBus();
    bus.createSource('channel-a');
    // If this returned a Promise, a caller could `await` it and let a
    // listener's own timing decide when a Core operation is considered done —
    // exactly the coupling "notifications after the durable fact" forbids.
    const result = bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);
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

    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);

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
      bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']),
    ).not.toThrow();

    expect(received).toEqual(['a-1', 'a-2', 'b-1']);
    expect(warnCalls.some((c) => c.message === 'channel core event listener failed')).toBe(true);
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
      bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']),
    ).not.toThrow();
    expect(settled).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(warnCalls.some((c) => c.message === 'channel core event listener failed')).toBe(true);
  });

  it('a turn still projects submitted/settled facts to a well-behaved sibling listener even with a hostile listener attached', () => {
    const { bus } = makeBus();
    const sourceA = bus.createSource('channel-hostile');
    const sourceB = bus.createSource('channel-well-behaved');
    sourceA.source.subscribe(() => {
      throw new Error('always throws');
    });
    const wellBehaved: ChannelCoreEvent[] = [];
    sourceB.source.subscribe((event) => { wellBehaved.push(event); });

    const projection = createConversationProjection({
      coreEvents: bus.publisher,
      log: createCapturingLogger().logger,
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };

    expect(() => projection.projectSubmitted(agent, turn)).not.toThrow();
    expect(() =>
      projection.projectSettled({
        agent,
        turn,
        settlement: { status: 'completed', resultText: 'done', truncated: false },
      }),
    ).not.toThrow();

    const kinds = wellBehaved.map((event) => event.kind);
    expect(kinds).toContain('teammate.turn.submitted');
    expect(kinds).toContain('teammate.turn.settled');
  });
});

describe('DispatcherCoreEventBus: subscription lifecycle', () => {
  function makeBus(maxSources = 4) {
    const { logger } = createCapturingLogger();
    return new DispatcherCoreEventBus({
      dispatcherId: DISPATCHER_ID,
      log: logger,
      maxSources,
    });
  }

  it('never delivers a fact published before the source existed (no subscribe-time snapshot, no replay)', () => {
    const bus = makeBus();
    // Publish before anyone has subscribed at all.
    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);

    const source = bus.createSource('channel-a');
    const received: ChannelCoreEvent[] = [];
    source.source.subscribe((event) => { received.push(event); });

    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.turn.submitted']);

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('teammate.turn.submitted');
  });

  it('revoking one source stops its delivery without touching a sibling source', () => {
    const bus = makeBus();
    const sourceA = bus.createSource('channel-a');
    const sourceB = bus.createSource('channel-b');
    const receivedA: ChannelCoreEvent[] = [];
    const receivedB: ChannelCoreEvent[] = [];
    sourceA.source.subscribe((event) => { receivedA.push(event); });
    sourceB.source.subscribe((event) => { receivedB.push(event); });

    sourceA.revoke();
    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
  });

  it('revokeSources() fences every live source at once, and no callback runs after that final close', () => {
    const bus = makeBus();
    const sourceA = bus.createSource('channel-a');
    const sourceB = bus.createSource('channel-b');
    const received: ChannelCoreEvent[] = [];
    sourceA.source.subscribe((event) => { received.push(event); });
    sourceB.source.subscribe((event) => { received.push(event); });

    bus.revokeSources();
    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);

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
    const subA = source.source.subscribe(() => { received.push('a'); });
    source.source.subscribe(() => { received.push('b'); });

    subA.unsubscribe();
    bus.publisher.publish(DISPATCHER_ID, catalogFixtures()['teammate.state']);

    expect(received).toEqual(['b']);
  });

  it('hasSources() is true only while at least one non-revoked source exists', () => {
    const bus = makeBus();
    expect(bus.publisher.hasSources?.()).toBe(false);
    const sourceA = bus.createSource('channel-a');
    expect(bus.publisher.hasSources?.()).toBe(true);
    const sourceB = bus.createSource('channel-b');
    sourceA.revoke();
    expect(bus.publisher.hasSources?.()).toBe(true);
    sourceB.revoke();
    expect(bus.publisher.hasSources?.()).toBe(false);
  });

  it('exposes no FIFO, replay, snapshot, or history surface a caller could read the past from', () => {
    const bus = makeBus();
    const untyped = bus as unknown as Record<string, unknown>;
    for (const forbidden of ['replay', 'getHistory', 'history', 'snapshot', 'ack', 'acknowledge', 'retry']) {
      expect(untyped[forbidden], `DispatcherCoreEventBus must not expose '${forbidden}'`).toBeUndefined();
    }
  });
});

describe('teammate.state covers every Agent entity kind, with role a runtime projection only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the FIRST state fact only after the identity write is durable, and never before', async () => {
    const dir = await makeTempDir('identity-first-fact');
    try {
      const published: unknown[] = [];
      const seenOnDiskAtPublishTime: boolean[] = [];
      const identityPath = join(dir, 'identity.json');
      const store = makeIdentityStore({
        dir,
        onPersisted: (identity) => {
          // A synchronous check from inside the hook: if publication ever ran
          // before the write settled, the file would not exist on disk yet at
          // this exact call — the one falsifiable proof of "notification
          // after the durable fact, never before".
          seenOnDiskAtPublishTime.push(existsSync(identityPath));
          published.push(identity);
        },
      });

      await store.create(makeIdentityCreateInput({ name: 'scout' }));

      expect(published).toHaveLength(1);
      expect(seenOnDiskAtPublishTime).toEqual([true]);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('republishes on a later status transition, but not on an update that leaves status unchanged', async () => {
    const dir = await makeTempDir('identity-transitions');
    try {
      const persistedStatuses: string[] = [];
      const store = makeIdentityStore({
        dir,
        onPersisted: (identity) => persistedStatuses.push(identity.status),
      });
      const created = await store.create(makeIdentityCreateInput({ name: 'scout', status: 'starting' }));
      expect(persistedStatuses).toEqual(['starting']);

      const running = await store.update(created, { status: 'running' });
      expect(persistedStatuses).toEqual(['starting', 'running']);

      // Same status, different field: not a transition, so no republish.
      await store.update(running, { intent: 'do the thing' });
      expect(persistedStatuses).toEqual(['starting', 'running']);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('never persists a role field on the identity the store hands to onPersisted', async () => {
    const dir = await makeTempDir('identity-no-role');
    try {
      let capturedKeys: string[] = [];
      const store = makeIdentityStore({
        dir,
        onPersisted: (identity) => {
          capturedKeys = Object.keys(identity);
        },
      });
      await store.create(makeIdentityCreateInput({ name: 'scout' }));
      expect(capturedKeys).not.toContain('role');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('a standalone (dispatcher-scoped) TeamMate uses the exact same durable-then-publish hook as any other collection member', async () => {
    const root = await makeTempDir('teammate-collection');
    try {
      const published: string[] = [];
      const collection = new AgentEntityCollectionStore({
        root,
        dispatcherId: DISPATCHER_ID,
        log: createCapturingLogger().logger,
        onPersisted: (identity) => published.push(identity.name),
      });
      await collection.entity('scout').create(makeIdentityCreateInput({ name: 'scout' }));
      expect(published).toEqual(['scout']);
    } finally {
      await removeTempDir(root);
    }
  });

  it('the Dispatcher and its dispatcher-scoped TeamMates are wired to the real publisher with role read from team_id, not asserted', async () => {
    // `DispatcherService` is too heavy to construct here (full config,
    // registry, catalog, admin socket...), so this anchors to the actual
    // `dispatcher-service/index.ts` source instead of re-deriving the event
    // shape from a local fixture (which would only prove the test's own
    // construction, not production behavior).
    const dispatcherServiceSource = await readFile(
      new URL('../src/service/dispatcher-service/index.ts', import.meta.url),
      'utf8',
    );

    // Both onPersisted wirings exist, and use exactly the two roles a
    // dispatcher-scoped Agent (the dispatcher root itself, or one of its
    // TeamMates) can ever be: never 'team_leader', which only a Team-scoped
    // identity can carry.
    expect(dispatcherServiceSource).toContain(
      "onPersisted: (identity) => this.publishAgentState(identity, 'dispatcher')",
    );
    expect(dispatcherServiceSource).toContain(
      "onPersisted: (identity) => this.publishAgentState(identity, 'teammate')",
    );

    // The single publisher method both wirings funnel through: it builds
    // `teammate.state` reading `team_name` off the identity's own `team_id`
    // (never a literal `null`), so a mis-scoped record would publish what it
    // actually is instead of what the call site assumed — and its `role`
    // parameter is typed to exclude 'team_leader' entirely, which is the
    // compile-time half of "a Dispatcher/dispatcher TeamMate never reports as
    // a team_leader".
    const methodStart = dispatcherServiceSource.indexOf('private publishAgentState(');
    expect(methodStart).toBeGreaterThan(-1);
    const methodBody = dispatcherServiceSource.slice(methodStart, methodStart + 600);
    expect(methodBody).toContain("role: 'dispatcher' | 'teammate'");
    expect(methodBody).toContain("kind: 'teammate.state'");
    expect(methodBody).toContain('team_name: identity.team_id');
  });

  it('the TeammateRole vocabulary excludes the deleted team_member kind (issue #63 deleted surface)', async () => {
    const teammateTypesSource = await readFile(
      new URL('../../dreamux-types/src/teammate.ts', import.meta.url),
      'utf8',
    );
    expect(teammateTypesSource).not.toContain('team_member');
    expect(teammateTypesSource).toMatch(
      /TeammateRole = 'dispatcher' \| 'teammate' \| 'team_leader'/,
    );
  });
});

describe('team.state is the redundant Team aggregate', () => {
  it('publishes on create() with the roster the owner supplied', async () => {
    const root = await makeTempDir('team-store-create');
    try {
      const publisher = createCapturingPublisher();
      const roster = vi.fn(async (): Promise<readonly TeamStateTeammateSummary[]> => []);
      const store = new TeamStore({ root, dispatcherId: DISPATCHER_ID, coreEvents: publisher, roster });

      await store.create(makeTeamRecordInput());

      expect(publisher.published).toHaveLength(1);
      const event = publisher.published[0]?.event;
      expect(event?.kind).toBe('team.state');
      if (event?.kind === 'team.state') {
        expect(event.team_name).toBe('alpha');
        expect(event.leader_name).toBe('alpha-leader');
        expect(event.status).toBe('starting');
        expect(event.teammates).toEqual([]);
      }
    } finally {
      await removeTempDir(root);
    }
  });

  it('publishes nothing when nobody is listening, and never even asks for a roster', async () => {
    const root = await makeTempDir('team-store-no-sources');
    try {
      const publisher = createCapturingPublisher(false);
      const roster = vi.fn(async (): Promise<readonly TeamStateTeammateSummary[]> => []);
      const store = new TeamStore({ root, dispatcherId: DISPATCHER_ID, coreEvents: publisher, roster });

      await store.create(makeTeamRecordInput());

      expect(publisher.published).toHaveLength(0);
      expect(roster).not.toHaveBeenCalled();
    } finally {
      await removeTempDir(root);
    }
  });

  it('republishes when the Team lifecycle status changes, but not on a same-status field update', async () => {
    const root = await makeTempDir('team-store-lifecycle');
    try {
      const publisher = createCapturingPublisher();
      const roster = vi.fn(async (): Promise<readonly TeamStateTeammateSummary[]> => []);
      const store = new TeamStore({ root, dispatcherId: DISPATCHER_ID, coreEvents: publisher, roster });
      const created = await store.create(makeTeamRecordInput());
      expect(created).not.toBeNull();
      if (created === null) throw new Error('unreachable');
      expect(publisher.published).toHaveLength(1);

      const running = await store.update(created, { status: 'running' });
      expect(publisher.published).toHaveLength(2);

      await store.update(running, { intent: 'a new intent, same status' });
      expect(publisher.published).toHaveLength(2);
    } finally {
      await removeTempDir(root);
    }
  });

  it('is republished by TeamRosterProjection when a contained TeamMate is created or changes state, teammate.state first', async () => {
    const root = await makeTempDir('team-roster-projection');
    try {
      const publisher = createCapturingPublisher();
      const roster = vi.fn(async (): Promise<readonly TeamStateTeammateSummary[]> => []);
      const store = new TeamStore({ root, dispatcherId: DISPATCHER_ID, coreEvents: publisher, roster });
      let currentRecord = await store.create(makeTeamRecordInput());
      expect(currentRecord).not.toBeNull();
      publisher.published.length = 0; // isolate the projection's own publications

      const projection = new TeamRosterProjection({
        teamId: 'alpha',
        store,
        coreEvents: publisher,
        record: () => currentRecord,
      });

      const leaderIdentity = makeIdentity({ name: 'alpha-leader', team_id: 'alpha' });
      projection.publish(leaderIdentity, 'team_leader');

      expect(publisher.published).toHaveLength(2);
      expect(publisher.published[0]?.event.kind).toBe('teammate.state');
      expect(publisher.published[1]?.event.kind).toBe('team.state');
      const aggregate = publisher.published[1]?.event;
      if (aggregate?.kind === 'team.state') {
        expect(aggregate.teammates).toEqual([
          { teammate_name: 'alpha-leader', role: 'team_leader', status: 'starting' },
        ]);
      }

      publisher.published.length = 0;
      const memberIdentity = makeIdentity({ name: 'scout', team_id: 'alpha' });
      projection.publish(memberIdentity, 'teammate');

      expect(publisher.published).toHaveLength(2);
      const secondAggregate = publisher.published[1]?.event;
      if (secondAggregate?.kind === 'team.state') {
        // A fresh bounded summary every publish, not a shared mutable array.
        expect(secondAggregate.teammates).toHaveLength(2);
        // `TeamStateTeammateSummary.role` is typed `TeamContainedRole`
        // ('teammate' | 'team_leader') — a Dispatcher literally cannot type-check
        // as a row here, which is the compile-time half of "a Dispatcher never
        // appears in a team.state summary". This is the runtime half: only the
        // roles this test actually published ever show up.
        expect(secondAggregate.teammates.every((row) => row.role === 'teammate' || row.role === 'team_leader')).toBe(true);
      }
      if (currentRecord === null) throw new Error('unreachable');
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('turn events correlate only by turn_id', () => {
  it('submitted carries turn_source and the Core turn_id; later events on the same turn share only turn_id', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: createCapturingLogger().logger,
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    const turn = { id: 'turn-77', submittedAt: Date.now(), prompt: 'investigate', source: 'feishu:chat-1' };

    projection.projectSubmitted(agent, turn);
    projection.projectSettled({
      agent,
      turn,
      settlement: { status: 'completed', resultText: 'done', truncated: false },
    });

    const kinds = publisher.published.map((entry) => entry.event.kind);
    expect(kinds).toEqual(['teammate.turn.submitted', 'teammate.turn.message', 'teammate.turn.settled']);

    const submitted = publisher.published[0]?.event;
    expect(submitted?.kind === 'teammate.turn.submitted' && submitted.turn_source).toBe('feishu:chat-1');

    for (const entry of publisher.published) {
      expect('turn_id' in entry.event && entry.event.turn_id).toBe('turn-77');
    }
  });

  it('never carries a ChannelOrigin, turnOrigin, or presentation-correlation field on any turn event', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: createCapturingLogger().logger,
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    const turn = { id: 'turn-9', submittedAt: Date.now(), prompt: 'do it', source: 'feishu:chat-1' };

    projection.projectSubmitted(agent, turn);
    projection.projectSettled({
      agent,
      turn,
      settlement: { status: 'completed', resultText: 'ok', truncated: false },
    });

    const forbidden = /channelorigin|turnorigin|presentation.?correlation|correlation.?token/i;
    for (const entry of publisher.published) {
      for (const key of Object.keys(entry.event)) {
        expect(forbidden.test(key), `unexpected field '${key}' on ${entry.event.kind}`).toBe(false);
      }
    }
  });

  it('projects nothing for a dispatcher-scoped TeamMate (neither a Dispatcher stream nor a Team one)', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: createCapturingLogger().logger,
    });
    const identity = makeIdentity({ team_id: null, name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'dispatcher:cli' };

    projection.projectSubmitted(agent, turn);

    expect(publisher.published).toHaveLength(0);
  });

  it('publishes nothing at all when hasSources() reports no live listener', () => {
    const publisher = createCapturingPublisher(false);
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: createCapturingLogger().logger,
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };

    projection.projectSubmitted(agent, turn);

    expect(publisher.published).toHaveLength(0);
  });
});

describe('activity from a revoked runtime generation can never reach a replacement runtime\'s COT stream', () => {
  it('AgentRuntimeStateStore revokes the prior lease the instant a new generation opens, and revocation never un-happens', async () => {
    const dir = await makeTempDir('runtime-generation-lease');
    try {
      const store = makeIdentityStore({ dir });
      const identity = await store.create(makeIdentityCreateInput({ name: 'scout' }));
      const state = new AgentRuntimeStateStore(store, identity);

      const generationOne = state.leaseRuntimeGeneration();
      expect(generationOne.isCurrent()).toBe(true);

      const generationTwo = state.leaseRuntimeGeneration();
      expect(generationOne.isCurrent()).toBe(false);
      expect(generationTwo.isCurrent()).toBe(true);

      state.revokeRuntimeGeneration();
      expect(generationTwo.isCurrent()).toBe(false);
      expect(generationOne.isCurrent()).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it('TeammateRuntimeOwner forwards activity to Core only after checking that same lease, fail-open on rejection', async () => {
    // `generationActivitySink` is private and reachable only through a full
    // provider-backed runtime start, which is out of this cell's scope; the
    // ownership of the gate (checked before forwarding, never after) is
    // exactly what a regression here would silently remove, so it is the
    // absence/ordering this guard proves.
    const source = await readFile(
      new URL('../src/service/teammate-service/runtime-owner.ts', import.meta.url),
      'utf8',
    );
    const sinkStart = source.indexOf('private generationActivitySink');
    expect(sinkStart).toBeGreaterThan(-1);
    const sinkBody = source.slice(sinkStart, source.indexOf('private resolveLaunch'));
    const guardIndex = sinkBody.indexOf('lease.isCurrent()');
    const logIndex = sinkBody.indexOf('dropped Agent Runtime activity from a revoked runtime generation');
    const forwardIndex = sinkBody.indexOf('this.callbacks.activitySink(event)');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeGreaterThan(guardIndex);
    expect(forwardIndex).toBeGreaterThan(logIndex);
  });
});
