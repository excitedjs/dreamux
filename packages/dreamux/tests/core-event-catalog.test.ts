/**
 * Coverage cell C (event half), Stage 9 node "core-events".
 *
 * Covers the seven-kind Core event catalog and the `teammate.state` role
 * catalog / `team.state` redundant-aggregate republication rule
 * (`service/team-collection/store.ts`, `service/agent-entity/identity-store.ts`).
 *
 * `DispatcherCoreEventBus`'s own delivery/subscription-lifecycle coverage and
 * `channel/conversation-projection.ts`'s display-fact/turn_id-correlation
 * coverage were removed from this file as Driver C collateral of the
 * `DreamuxLogger.child` required-ness change (stage 2a item 1) — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`.
 * Both contracts still hold in source and are owed back in the final test
 * completion pass.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCoreEvent,
  TeamStateTeammateSummary,
} from '@excitedjs/dreamux-types';

import { sealChannelCoreEvent } from '../src/service/dispatcher-core-events/seal.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { AgentRuntimeStateStore } from '../src/service/agent-entity/runtime-state.js';
import {
  createCapturingPublisher,
  makeIdentityCreateInput,
  makeIdentityStore,
  makeTempDir,
  removeTempDir,
} from './helpers/event-harness.js';

const DISPATCHER_ID = 'dispatcher-fixture';

function baseScope(overrides: Partial<{
  teammateName: string;
  role: 'dispatcher' | 'teammate' | 'team_leader';
  teamName: string | null;
  turn_id: string;
}> = {}) {
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

describe('the published Core event catalog is exactly four kinds', () => {
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
      // Deleted with the submission-keyed display line.
      'teammate.turn.submitted',
      'teammate.turn.settled',
      'teammate.turn.message',
      'teammate.turn.tool_call',
      'teammate.native_turn.ended',
    ];
    const base = baseScope();
    for (const kind of rejectedKinds) {
      const event = { ...base, kind } as unknown as ChannelCoreEvent;
      expect(sealChannelCoreEvent(event), `kind ${kind} must be rejected`).toBeNull();
    }
  });

  it('rejects a schemaVersion other than 1', () => {
    const event = { ...catalogFixtures()['teammate.state'], schemaVersion: 2 } as unknown as ChannelCoreEvent;
    expect(sealChannelCoreEvent(event)).toBeNull();
  });

  it('rejects a non-finite occurredAt', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const event = { ...catalogFixtures()['teammate.state'], occurredAt: bad } as unknown as ChannelCoreEvent;
      expect(sealChannelCoreEvent(event)).toBeNull();
    }
  });

  it('deep-freezes a sealed event so no listener can rewrite a broadcast fact', () => {
    const sealed = sealChannelCoreEvent(catalogFixtures()['teammate.activity']);
    expect(sealed).not.toBeNull();
    expect(Object.isFrozen(sealed)).toBe(true);
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
    // `teammate.state` reading `teamName` off the identity's own `team_id`
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
    expect(methodBody).toContain('teamName: identity.team_id');
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
        expect(event.teamName).toBe('alpha');
        expect(event.leaderName).toBe('alpha-leader');
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
    const forwardIndex = sinkBody.indexOf('projectActivity(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(logIndex).toBeGreaterThan(guardIndex);
    expect(forwardIndex).toBeGreaterThan(logIndex);
  });
});
