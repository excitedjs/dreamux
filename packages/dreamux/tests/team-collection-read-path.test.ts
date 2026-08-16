import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';

import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import {
  dispatcherAgentIdentityPath,
  dispatcherTeamNameClaimPath,
} from '../src/platform/paths.js';
import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
import {
  AgentIdentityStore,
  type AgentIdentityCreateInput,
  type AgentIdentityUpdateInput,
} from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { TeammateService } from '../src/service/teammate-service/index.js';
import { CompletionDeliveryPolicy } from '../src/service/completion-router/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { fakeChannels } from './helpers/collaboration-space.js';
import {
  deferred,
  FakeInitiator,
  FakeRuntime,
  FAKE_RUNTIME_REF,
  fakeRuntimeCatalog,
  noopLog,
} from './helpers/fake-team-runtime.js';

class RetryableCloseIdentityStore extends AgentIdentityStore {
  allowClose = false;
  closeAttempts = 0;

  override async update(
    identity: AgentEntityIdentity,
    input: AgentIdentityUpdateInput,
  ): Promise<AgentEntityIdentity> {
    if (input.status === 'closed') {
      this.closeAttempts += 1;
      if (!this.allowClose) throw new Error('identity close unavailable');
    }
    return super.update(identity, input);
  }
}

class GatedCreateIdentityStore extends AgentIdentityStore {
  readonly published = deferred<AgentEntityIdentity>();
  readonly release = deferred<void>();
  failAfterPublication = false;

  override async create(
    input: AgentIdentityCreateInput,
  ): Promise<AgentEntityIdentity> {
    const identity = await super.create(input);
    this.published.resolve(identity);
    await this.release.promise;
    if (this.failAfterPublication) {
      throw new Error('identity creation failed after durable publication');
    }
    return identity;
  }
}

async function dissolveTeamForTest(
  teams: TeamCollection,
  teamId: string,
  note: string,
) {
  const accepted = await teams.acceptDissolve({
    teamId,
    note,
    requester: { kind: 'dispatcher' },
  });
  teams.startAcceptedDissolve(accepted, (input) =>
    teams.closeAcceptedResources(input),
  );
  await vi.waitFor(async () => {
    expect(await new TeamStore().get('dispatcher-a', teamId)).toMatchObject({
      status: 'closed',
      dissolve: {
        operation_id: accepted.operationId,
        phase: 'complete',
      },
    });
  }, { timeout: 5_000 });
  return (await teams.get(teamId)).status();
}

/**
 * Guards issue #233 R4: the read path (`list` / `history` / `status`) reads the
 * leader + member count straight from the shared identity store instead of
 * newing a throwaway per-team collection. The discriminating shape the old
 * #233 scope bug needed is a team with a leader AND ≥1 spawned member: an empty
 * team would pass even a broken rewrite (member_count === 0, trivial leader).
 */
describe('TeamCollection read path (issue #233 R4)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-collection-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a non-null leader_state and member_count for a team with a spawned member', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const turnsStore = new AgentTurnsStore();
    const agentSuffixes = ['aaaa', 'bbbbbbbb'];
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
      agentNameSuffixGenerator: () => agentSuffixes.shift()!,
    });

    const created = await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
      prompt: 'initial leader prompt',
    });
    expect(created.leader?.name).toBe('tl-alpha-aaaa');

    // Spawn one team member through the team's own (store-sharing) collection.
    const team = await teams.get('alpha');
    const spawn = await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });
    expect(spawn.teammate.name).toBe('tm-worker-bbbbbbbb');
    runtimes[1]!.settle(0);
    await vi.waitFor(async () => {
      expect((await team.teammates.last(spawn.teammate.name)).returned_turns)
        .toBe(1);
    });
    const memberTurns = [];
    for await (const row of turnsStore.stream({
      dispatcherId: 'dispatcher-a',
      name: spawn.teammate.name,
      teamId: team.id,
      role: 'team_member',
    })) {
      memberTurns.push(row);
    }
    expect(memberTurns).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        turn_origin: 'team_leader',
        prompt_preview: 'do the work',
      }),
    );

    // list(): leaderState + memberCount read straight from the shared store.
    const rows = await teams.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.team_name).toBe('alpha');
    expect(rows[0]!.leader_state).not.toBeNull();
    expect(rows[0]!.member_count).toBe(1);

    // history(): same two probes, via historyRow.
    const history = await teams.history({});
    expect(history.items).toHaveLength(1);
    expect(history.items[0]!.leader_state).not.toBeNull();
    expect(history.items[0]!.member_count).toBe(1);

    // status(): the per-team entity's own memberCount.
    const status = await team.status();
    expect(status.member_count).toBe(1);
    expect(status.leader).not.toBeNull();
  });

  it('uses the shared 4-char endpoint through the real dispatcher TeamMate path', async () => {
    const workspace = join(root, 'dispatcher-teammate-workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: null,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      suffixGenerator: () => 'a1b2',
      log,
    });
    const spawned = await collection.spawn({
      name: 'reviewer',
      prompt: 'review',
      intent: 'verify generated name',
      agentRuntime: 'agent-a',
    });
    expect(spawned.teammate.name).toBe('reviewer-a1b2');
    await collection.close({
      name: spawned.teammate.name,
      note: 'test complete',
    });
  });
});

describe('entity-owned TeamMate lock lifecycle', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-locked-teammate-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  function collection(
    runtimes: FakeRuntime[],
    settleImmediately = false,
    options: {
      identities?: AgentIdentityStore;
      contexts?: AgentRuntimeCreateContext[];
    } = {},
  ): TeammateCollection {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    return new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: null,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        settleImmediately,
      }, options.contexts),
      worktrees: new WorktreeManager(),
      identities: options.identities ?? new AgentIdentityStore(noopLog()),
      turnsStore: new AgentTurnsStore(),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      suffixGenerator: () => 'a1b2',
      log: noopLog(),
    });
  }

  it('creates and locks before runtime start, then closes and retires on unlock', async () => {
    const runtimes: FakeRuntime[] = [];
    const teammates = collection(runtimes);
    const handle = await teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });

    expect(runtimes).toHaveLength(0);
    await expect(
      teammates.send({ name: handle.name, prompt: 'intrude' }),
    ).rejects.toThrow(/cannot accept send/u);
    await expect(
      teammates.close({ name: handle.name, note: 'intrude' }),
    ).rejects.toThrow(/locked/u);

    const admission = await handle.submit({
      prompt: 'review',
      turnOrigin: 'dispatcher',
    });
    expect(admission.status).toBe('submitted');
    expect(runtimes).toHaveLength(1);
    runtimes[0]!.settle(0);
    if (admission.status === 'submitted') {
      await expect(admission.turn.settled).resolves.toMatchObject({
        status: 'completed',
      });
    }

    await handle.close({ note: 'workflow complete' });
    expect(teammates.materializedEntities()).toHaveLength(1);
    await expect(handle.submit({
      prompt: 'closed but still held',
      turnOrigin: 'dispatcher',
    })).resolves.toEqual({ status: 'stopped' });
    await expect(
      teammates.send({ name: handle.name, prompt: 'must not reopen' }),
    ).rejects.toThrow(/cannot accept send/u);
    expect(runtimes).toHaveLength(1);
    expect(teammates.materializedEntities()).toHaveLength(1);
    handle.unlock();
    expect(teammates.materializedEntities()).toHaveLength(0);
    expect(() => handle.unlock()).toThrow(/stale TeamMate lock/u);
    expect(() =>
      handle.submit({ prompt: 'late', turnOrigin: 'dispatcher' }),
    ).toThrow(/stale TeamMate lock/u);
  });

  it('publishes one locked canonical entity across durable creation and joins cleanup', async () => {
    const runtimes: FakeRuntime[] = [];
    const identities = new GatedCreateIdentityStore(noopLog());
    const teammates = collection(runtimes, false, { identities });
    const creating = teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });
    const identity = await identities.published.promise;
    expect(identity.name).toBe('reviewer-a1b2');

    const identityRead = vi.spyOn(identities, 'get');
    const subscription = vi.spyOn(TeammateService.prototype, 'onClosed');
    try {
      const sendOutcome = teammates.send({
        name: identity.name,
        prompt: 'must join the locked publication',
      }).then(
        (value) => ({ kind: 'fulfilled' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      await Promise.resolve();
      const identityReadsWhilePending = identityRead.mock.calls.length;
      const allowCleanup = deferred<void>();
      const cleanup = creating.then(async (handle) => {
        await allowCleanup.promise;
        await handle.close({ note: 'workflow stopped during materialization' });
        handle.unlock();
      });

      identities.release.resolve();
      const handle = await creating;
      const outcome = await sendOutcome;
      const cached = teammates.materializedEntities();

      expect(identityReadsWhilePending).toBe(0);
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') {
        throw new Error('send unexpectedly bypassed the locked canonical entity');
      }
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/cannot accept send/u);
      expect(subscription).toHaveBeenCalledTimes(1);
      expect(cached).toEqual([subscription.mock.instances[0]]);
      expect(cached[0]?.isLocked()).toBe(true);
      expect(handle.name).toBe(identity.name);
      expect(runtimes).toHaveLength(0);

      allowCleanup.resolve();
      await cleanup;
      await vi.waitFor(() => {
        expect(teammates.materializedEntities()).toHaveLength(0);
      });
      expect(runtimes).toHaveLength(0);
    } finally {
      identities.release.resolve();
      identityRead.mockRestore();
      subscription.mockRestore();
    }
  });

  it('clears a failed fresh canonical slot for later durable materialization', async () => {
    const runtimes: FakeRuntime[] = [];
    const identities = new GatedCreateIdentityStore(noopLog());
    identities.failAfterPublication = true;
    const teammates = collection(runtimes, false, { identities });
    const creating = teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });
    const creationOutcome = creating.then(
      (value) => ({ kind: 'fulfilled' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    const identity = await identities.published.promise;
    const identityRead = vi.spyOn(identities, 'get');
    const subscription = vi.spyOn(TeammateService.prototype, 'onClosed');
    try {
      identities.release.resolve();
      const failed = await creationOutcome;
      expect(failed.kind).toBe('rejected');
      if (failed.kind !== 'rejected') {
        throw new Error('fresh creation unexpectedly succeeded');
      }
      expect(failed.error).toBeInstanceOf(Error);
      expect((failed.error as Error).message).toMatch(
        /failed after durable publication/u,
      );
      expect(teammates.materializedEntities()).toHaveLength(0);
      expect(subscription).not.toHaveBeenCalled();
      expect(runtimes).toHaveLength(0);

      identityRead.mockClear();
      const sent = teammates.send({
        name: identity.name,
        prompt: 'recover the durable identity',
      });
      await Promise.resolve();
      expect(identityRead).toHaveBeenCalledTimes(1);
      await expect(sent).resolves.toMatchObject({ status: 'submitted' });
      expect(subscription).toHaveBeenCalledTimes(1);
      expect(teammates.materializedEntities()).toHaveLength(1);
      expect(runtimes).toHaveLength(1);

      runtimes[0]!.settle(0);
      await vi.waitFor(async () => {
        expect((await teammates.last(identity.name, 1)).returned_turns).toBe(1);
      });
      await teammates.close({
        name: identity.name,
        note: 'recovered creation complete',
      });
      await vi.waitFor(() => {
        expect(teammates.materializedEntities()).toHaveLength(0);
      });
      expect(runtimes[0]!.stopAttempts).toBe(1);
    } finally {
      identities.release.resolve();
      identityRead.mockRestore();
      subscription.mockRestore();
    }
  });

  it('projects a runtime-free failed close as retryable until durable close commits', async () => {
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const identities = new RetryableCloseIdentityStore(noopLog());
    const teammates = collection(runtimes, false, { identities, contexts });
    const handle = await teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });
    const entity = teammates.materializedEntities()[0]!;
    const closedFacts = vi.fn();
    const subscription = entity.onClosed(closedFacts);
    const admission = await handle.submit({
      prompt: 'review',
      turnOrigin: 'dispatcher',
    });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await contexts[0]!.state!.setStatus('ready');
    runtimes[0]!.settle(0);
    await admission.turn.persistence;
    expect(entity.current().status).toBe('running');

    await expect(handle.close({ note: 'first attempt' })).rejects.toMatchObject({
      runtime_terminated: true,
    });
    expect(entity.current()).toMatchObject({
      status: 'running',
      closed_at: null,
      close_note: null,
    });
    expect(entity.runtimeStatus()).toBeNull();
    expect(entity.isLocked()).toBe(true);
    expect(entity.isRetired()).toBe(false);
    expect(runtimes[0]!.stopAttempts).toBe(1);
    expect(teammates.materializedEntities()).toEqual([entity]);
    expect(closedFacts).not.toHaveBeenCalled();

    await expect(teammates.status(handle.name)).resolves.toMatchObject({
      status: 'stopped',
      runtime_status: null,
      closed_at: null,
    });
    await expect(teammates.list()).resolves.toEqual([
      expect.objectContaining({
        name: handle.name,
        status: 'stopped',
        runtime_status: null,
      }),
    ]);
    await expect(teammates.last(handle.name, 1)).resolves.toMatchObject({
      teammate: {
        status: 'stopped',
        runtime_status: null,
        closed_at: null,
      },
    });
    await expect(teammates.history({ status: 'stopped' })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          name: handle.name,
          status: 'stopped',
          runtime_status: null,
        }),
      ],
    });
    await expect(teammates.history({ status: 'running' })).resolves.toMatchObject({
      items: [],
    });
    await Promise.resolve();
    expect(teammates.materializedEntities()).toEqual([entity]);
    expect(closedFacts).not.toHaveBeenCalled();

    identities.allowClose = true;
    await expect(handle.close({ note: 'retry' })).resolves.toMatchObject({
      teammate: { status: 'closed', runtime_status: null },
    });
    expect(identities.closeAttempts).toBe(2);
    expect(runtimes[0]!.stopAttempts).toBe(1);
    expect(entity.current().status).toBe('closed');
    expect(entity.isLocked()).toBe(true);
    expect(teammates.materializedEntities()).toEqual([entity]);
    expect(closedFacts).not.toHaveBeenCalled();

    handle.unlock();
    await vi.waitFor(() => {
      expect(closedFacts).toHaveBeenCalledTimes(1);
      expect(teammates.materializedEntities()).toHaveLength(0);
    });
    subscription.unsubscribe();
  });

  it('linearizes ordinary mutation and lock admission in both orders', async () => {
    const runtimes: FakeRuntime[] = [];
    const teammates = collection(runtimes, true);
    const spawned = await teammates.spawn({
      name: 'reviewer',
      prompt: 'initial',
      intent: 'ordinary',
      agentRuntime: 'agent-a',
    });
    await vi.waitFor(async () => {
      expect((await teammates.last(spawned.teammate.name, 2)).returned_turns)
        .toBe(1);
    });
    const entity = teammates.materializedEntities()[0]!;

    const sending = teammates.send({
      name: spawned.teammate.name,
      prompt: 'ordinary wins',
    });
    expect(() => entity.lock()).toThrow(/being mutated/u);
    await sending;
    await vi.waitFor(async () => {
      expect((await teammates.last(spawned.teammate.name, 3)).returned_turns)
        .toBe(2);
      expect(entity.current().turn_count).toBe(2);
    });

    const handle = entity.lock();
    await expect(
      teammates.send({
        name: spawned.teammate.name,
        prompt: 'lock wins',
      }),
    ).rejects.toThrow(/cannot accept send/u);
    handle.unlock();
    await expect(
      teammates.send({
        name: spawned.teammate.name,
        prompt: 'ordinary restored',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await vi.waitFor(() => {
      expect(entity.current().turn_count).toBe(3);
    });
  });

  it('rejects a stale resolved source after that exact entity retires', async () => {
    const runtimes: FakeRuntime[] = [];
    const teammates = collection(runtimes);
    const handle = await teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });
    handle.unlock();
    const source = teammates.materializedEntities()[0]!;
    const originalSend = source.send.bind(source);
    const entered = deferred<void>();
    const release = deferred<void>();
    const sendSpy = vi.spyOn(source, 'send').mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return originalSend(input);
    });

    const stale = teammates.send({ name: handle.name, prompt: 'stale send' });
    await entered.promise;
    const closingHandle = source.lock();
    await closingHandle.close({ note: 'retire resolved source' });
    closingHandle.unlock();

    try {
      release.resolve();
      await expect(stale).rejects.toThrow(/cannot accept send/u);
      expect(runtimes).toHaveLength(0);
    } finally {
      release.resolve();
      sendSpy.mockRestore();
    }
  });

  it('single-flights replacement materialization and ignores the old retirement fact', async () => {
    const runtimes: FakeRuntime[] = [];
    const teammates = collection(runtimes, true);
    const handle = await teammates.createLocked({
      name: 'reviewer',
      prompt: 'review',
      intent: 'workflow member',
      agentRuntime: 'agent-a',
    });
    const admission = await handle.submit({
      prompt: 'review',
      turnOrigin: 'dispatcher',
    });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await admission.turn.settled;
    await handle.close({ note: 'workflow complete' });
    handle.unlock();

    const [first, second] = await Promise.all([
      teammates.send({ name: handle.name, prompt: 'resume one' }),
      teammates.send({ name: handle.name, prompt: 'resume two' }),
    ]);
    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    expect(runtimes).toHaveLength(2);

    await Promise.resolve();
    await teammates.send({ name: handle.name, prompt: 'after old fact' });
    expect(runtimes).toHaveLength(2);
  });
});
describe('TeamCollection route readiness recovery', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-route-ready-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('materializes a valid stale starting Team before returning its route owner', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    const makeTeams = () => new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    const first = makeTeams();
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    await first.stopAll();
    const store = new TeamStore();
    const record = await store.get('dispatcher-a', 'alpha');
    if (record === null) throw new Error('Team record was not created');
    await store.update(record, { status: 'starting' });

    const recovered = makeTeams();
    await expect(recovered.requireRoutableTeamOwner('alpha')).resolves.toMatchObject({
      teamName: 'alpha',
      leaderName: record.leader_name,
    });
    await expect(store.get('dispatcher-a', 'alpha')).resolves.toMatchObject({
      status: 'running',
    });
    expect(runtimes.at(-1)?.getStatus()).toBe('ready');
    await recovered.stopAll();
  });

  it('serializes route publication with the start of Team closure', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    const routeEntered = deferred<void>();
    const releaseRoute = deferred<void>();
    const closingEntered = deferred<void>();
    const releaseClosing = deferred<void>();
    const routeLease = teams.withRoutableTeamProjection('alpha', async () => {
      routeEntered.resolve();
      await releaseRoute.promise;
    });
    await routeEntered.promise;

    const closing = teams.withTeamRouteClosing('alpha', async () => {
      closingEntered.resolve();
      await releaseClosing.promise;
    });
    let closureStarted = false;
    void closingEntered.promise.then(() => {
      closureStarted = true;
    });
    await Promise.resolve();
    expect(closureStarted).toBe(false);

    releaseRoute.resolve();
    await routeLease;
    await closingEntered.promise;
    await expect(
      teams.withRoutableTeamProjection('alpha', async () => undefined),
    ).rejects.toThrow(/closing/);

    releaseClosing.resolve();
    await closing;
    await teams.stopAll();
  });
});

describe('TeamCollection create without a prompt fires no leader turn', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-create-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('starts the leader idle and returns turn === null when no prompt is given', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    // No `prompt` field on the create input.
    const created = await teams.create({
      name: 'beta',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead beta',
    });

    // No first turn was fabricated or fired at creation.
    expect(created.status).toBeNull();

    // The leader runtime was started, but received no submitted turn.
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.getStatus()).toBe('ready');
    expect(runtimes[0]!.submitted).toHaveLength(0);

    // The leader still exists in the read path (idle, resumable).
    const status = await (await teams.get('beta')).status();
    expect(status.leader).not.toBeNull();
    expect(status.member_count).toBe(0);
  });

  it('stops a started leader when Team creation fails after launch', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        submitError: new Error('initial prompt failed'),
      }),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await expect(teams.create({
      name: 'failed-create',
      leaderAgentRuntime: 'agent-a',
      intent: 'exercise create compensation',
      prompt: 'fail after leader launch',
    })).rejects.toThrow(/initial prompt failed/);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.getStatus()).toBe('stopped');
    const failedRecord = await new TeamStore().get(
      'dispatcher-a',
      'failed-create',
    );
    expect(failedRecord).toMatchObject({
      status: 'closed',
      close_note: 'Team creation failed',
      closed_at: expect.any(Number),
    });
    const failedLeader = await new AgentIdentityStore(log).leaderIdentity(
      'dispatcher-a',
      'failed-create',
    );
    expect(failedLeader).toMatchObject({
      status: 'closed',
      close_note: 'Team creation failed',
    });

    const restarted = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    await expect(
      restarted.requireRoutableTeamProjection('failed-create'),
    ).rejects.toThrow(/closed/u);
    expect(runtimes).toHaveLength(1);
  });

  it('closes a durably published leader when identity creation throws afterward', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new GatedCreateIdentityStore(log);
    identities.failAfterPublication = true;
    const makeTeams = () => new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      agentNameSuffixGenerator: () => 'aaaa',
      log,
    });
    const teams = makeTeams();

    const creation = teams.create({
      name: 'published-failure',
      leaderAgentRuntime: 'agent-a',
      intent: 'must not resurrect',
    });
    const published = await identities.published.promise;
    identities.release.resolve();
    await expect(creation).rejects.toThrow(
      /identity creation failed after durable publication/u,
    );

    await expect(identities.get(
      'dispatcher-a',
      published.name,
      'published-failure',
    )).resolves.toMatchObject({
      status: 'closed',
      close_note: 'Team creation failed',
    });
    await expect(new TeamStore().get(
      'dispatcher-a',
      'published-failure',
    )).resolves.toMatchObject({
      status: 'closed',
      close_note: 'Team creation failed',
    });
    await expect(
      makeTeams().requireRoutableTeamProjection('published-failure'),
    ).rejects.toThrow(/closed/u);
    expect(runtimes).toHaveLength(0);
  });

  it('materializes and closes every durable cold-cache Team entity on stopAll', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const initialRuntimes: FakeRuntime[] = [];
    const recoveredRuntimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    const makeTeams = (runtimes: FakeRuntime[]) => new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      agentNameSuffixGenerator: () => 'aaaa',
      log,
    });
    const first = makeTeams(initialRuntimes);
    const created = await first.create({
      name: 'cold-stop',
      leaderAgentRuntime: 'agent-a',
      intent: 'close after restart',
    });
    const firstTeam = await first.get('cold-stop');
    const spawned = await firstTeam.spawnTeamMate({
      name: 'worker',
      prompt: 'work until shutdown',
      intent: 'cold member',
      agentRuntime: 'agent-a',
    });

    const recovered = makeTeams(recoveredRuntimes);
    await recovered.stopAll();

    await expect(identities.get(
      'dispatcher-a',
      created.team.leader_name,
      'cold-stop',
    )).resolves.toMatchObject({ status: 'closed' });
    await expect(identities.get(
      'dispatcher-a',
      spawned.teammate.name,
      'cold-stop',
    )).resolves.toMatchObject({ status: 'closed' });
    expect(recoveredRuntimes).toHaveLength(0);
  });

  it('still closes materialized Teams when durable Team discovery fails', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({
        dispatcherId: 'dispatcher-a',
        log,
      }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    await teams.create({
      name: 'materialized-before-list-failure',
      leaderAgentRuntime: 'agent-a',
      intent: 'close even when Team discovery fails',
    });
    const discoveryError = new Error('durable Team list unavailable');
    const store = (teams as unknown as { store: TeamStore }).store;
    vi.spyOn(store, 'list').mockRejectedValueOnce(discoveryError);

    await expect(teams.stopAll()).rejects.toBe(discoveryError);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.getStatus()).toBe('stopped');
    await expect(new AgentIdentityStore(log).leaderIdentity(
      'dispatcher-a',
      'materialized-before-list-failure',
    )).resolves.toMatchObject({ status: 'closed' });
  });

  it('materializes and closes every durable cold-cache member during dissolve', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    const makeTeams = () => new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      agentNameSuffixGenerator: () => 'bbbb',
      log,
    });
    const first = makeTeams();
    const created = await first.create({
      name: 'cold-dissolve',
      leaderAgentRuntime: 'agent-a',
      intent: 'dissolve after restart',
    });
    const spawned = await (await first.get('cold-dissolve')).spawnTeamMate({
      name: 'worker',
      prompt: 'work until dissolve',
      intent: 'cold dissolve member',
      agentRuntime: 'agent-a',
    });

    const recovered = makeTeams();
    await dissolveTeamForTest(recovered, 'cold-dissolve', 'restart dissolve');
    await expect(identities.get(
      'dispatcher-a',
      created.team.leader_name,
      'cold-dissolve',
    )).resolves.toMatchObject({ status: 'closed' });
    await expect(identities.get(
      'dispatcher-a',
      spawned.teammate.name,
      'cold-dissolve',
    )).resolves.toMatchObject({ status: 'closed' });
  });

  it('continues stopping sibling members and the leader after a member stop fails', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    await teams.create({
      name: 'stop-all',
      leaderAgentRuntime: 'agent-a',
      intent: 'exercise Team runtime cleanup',
    });
    const team = await teams.get('stop-all');
    await team.spawnTeamMate({
      name: 'worker-a',
      prompt: 'work a',
      agentRuntime: 'agent-a',
      intent: 'first worker',
    });
    await team.spawnTeamMate({
      name: 'worker-b',
      prompt: 'work b',
      agentRuntime: 'agent-a',
      intent: 'second worker',
    });
    expect(runtimes).toHaveLength(3);
    const leaderStopError = new Error('leader stop failed');
    const memberStopError = new Error('member stop failed');
    runtimes[0]?.failNextStop(leaderStopError);
    runtimes[1]?.failNextStop(memberStopError);

    await expect(teams.stopAll()).rejects.toMatchObject({
      errors: [memberStopError, leaderStopError],
    });

    expect(runtimes.map((runtime) => runtime.stopAttempts)).toEqual([1, 1, 1]);
    expect(runtimes.map((runtime) => runtime.getStatus())).toEqual([
      'ready',
      'ready',
      'stopped',
    ]);
  });

  it('retries an uncached failed-create leader during stopAll and fails loud', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const leaderStopError = new Error('persistent leader stop failure');
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        submitError: new Error('initial prompt failed'),
        stopError: leaderStopError,
      }),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await expect(teams.create({
      name: 'failed-create-stop',
      leaderAgentRuntime: 'agent-a',
      intent: 'exercise retained failed-create ownership',
      prompt: 'fail after leader launch',
    })).rejects.toThrow(/creation failed and cleanup did not converge/);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.stopAttempts).toBe(1);

    const retained = await teams.get('failed-create-stop');
    await expect(
      teams.requireRoutableTeamProjection('failed-create-stop'),
    ).rejects.toThrow(/closed/u);
    expect(await teams.get('failed-create-stop')).toBe(retained);
    expect(runtimes).toHaveLength(1);

    await expect(teams.stopAll()).rejects.toBe(leaderStopError);
    expect(runtimes[0]?.stopAttempts).toBe(2);
    expect(runtimes[0]?.getStatus()).toBe('ready');
  });

  it('preserves create, leader-close, and Team terminal-write failures', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const admissionError = new Error('initial prompt failed');
    const leaderStopError = new Error('leader termination proof failed');
    const terminalWriteError = new Error('Team terminal write unavailable');
    const originalUpdate = TeamStore.prototype.update;
    const update = vi.spyOn(TeamStore.prototype, 'update').mockImplementation(
      async function (this: TeamStore, team, input) {
        if (input.status === 'closed') throw terminalWriteError;
        return originalUpdate.call(this, team, input);
      },
    );
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        submitError: admissionError,
        stopError: leaderStopError,
      }),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({
        dispatcherId: 'dispatcher-a',
        log,
      }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    try {
      const failure = await teams.create({
        name: 'aggregate-create-failure',
        leaderAgentRuntime: 'agent-a',
        intent: 'preserve every failure',
        prompt: 'fail after leader launch',
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors;
      expect(errors).toHaveLength(3);
      expect(errors[0]).toMatchObject({
        message: expect.stringContaining(admissionError.message),
      });
      expect(errors[1]).toBe(leaderStopError);
      expect(errors[2]).toBe(terminalWriteError);
    } finally {
      update.mockRestore();
    }
  });
});

describe('TeamCollection identity prompt launch behavior', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-identity-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('persists trimmed TeamLeader identity, supplies append-only systemPrompt, and does not inherit it to members', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {}, contexts),
      worktrees: new WorktreeManager(),
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
      identity: '  architecture reviewer  ',
      prompt: 'lead this team',
    });
    const team = await teams.get('alpha');
    expect(team.leader.current().identity_prompt).toBe('architecture reviewer');
    expect(contexts[0]?.skillSources?.map((source) => source.name)).toEqual([
      'team-leader',
      'shared',
    ]);
    const append = contexts[0]?.systemPrompt?.append ?? [];
    expect(append).toHaveLength(4);
    expect(append[0]).toBe('You are the TeamLeader of Dreamux Team "alpha".');
    expect(append[1]).toContain('team-workflow');
    expect(append[1]).toMatch(/TeamMate/i);
    expect(append[1]).toMatch(/channel/i);
    expect(append[1]).toMatch(/cron/i);
    for (const tool of ['dissolve', 'bind_channel', 'transfer_back']) {
      expect(append[1]).toContain(tool);
    }
    expect(append[2]).toMatch(/task was submitted successfully[\s\S]*end the turn naturally/i);
    expect(append[3]).toBe('architecture reviewer');
    expect(contexts[0]?.systemPrompt).not.toHaveProperty('replace');
    const summary = await team.status();
    expect(summary.leader).not.toHaveProperty('identity_prompt');
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual([
      'lead this team',
    ]);

    await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });
    const memberContext = contexts.find(
      (context) => context.identity.runtime_id.includes('.tm.') &&
        context.identity.runtime_id !== contexts[0]?.identity.runtime_id,
    );
    expect(memberContext?.systemPrompt)
      .toBeUndefined();
    expect(memberContext?.skillSources?.map((source) => source.name)).toEqual([]);
  });

  it('rejects blank TeamLeader identity input', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await expect(
      teams.create({
        name: 'alpha',
        leaderAgentRuntime: 'agent-a',
        intent: 'lead alpha',
        identity: '   ',
      }),
    ).rejects.toThrow('TeamLeader identity must be a non-empty string');
    expect(runtimes).toHaveLength(0);
  });
});

describe('TeamCollection TeamLeader lifecycle and dispatcher send', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-send-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('submits to the TeamLeader, records dispatcher turn_origin, and returns the public response shape', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const turnsStore = new AgentTurnsStore();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });

    const sent = await teams.sendToLeader('alpha', {
      prompt: 'follow up',
      intent: 'lead alpha follow-up',
      initiator: new FakeInitiator(),
    });

    expect(Object.keys(sent).sort()).toEqual(['leader', 'status', 'team']);
    expect(sent.team).toMatchObject({
      team_name: 'alpha',
      status: 'running',
      source_repo: null,
      leader_agent_runtime: 'agent-a',
    });
    expect(sent.team).not.toHaveProperty('repo_cwd');
    expect(sent.team).not.toHaveProperty('runtime_cwd');
    expect(sent.team).not.toHaveProperty('worktree');
    expect(sent.leader.intent).toBe('lead alpha follow-up');
    expect(sent.status).toBe('submitted');
    expect(sent).not.toHaveProperty('turn');
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual(['follow up']);

    const team = await teams.get('alpha');
    runtimes[0]!.settle(0);
    await vi.waitFor(async () => {
      expect((await team.leader.last()).returned_turns).toBe(1);
    });
    const identity = team.leader.current();
    const rows = [];
    for await (const row of turnsStore.stream({
      dispatcherId: identity.dispatcher_id,
      name: identity.name,
      teamId: identity.team_id,
      role: identity.role,
    })) {
      rows.push(row);
    }
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        turn_origin: 'dispatcher',
        prompt_preview: 'follow up',
      }),
    );

    await teams.stopAll();
  });

  it('routes dispatcher team.send completion back to the dispatcher initiator', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const completionDelivery = new CompletionDeliveryPolicy({
      dispatcherId: 'dispatcher-a',
      log,
    });
    const turnsStore = new AgentTurnsStore();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        lastText: 'leader finished',
      }),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      completionDelivery,
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });
    const initiator = new FakeInitiator();
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });

    await teams.sendToLeader('alpha', {
      prompt: 'settle later',
      initiator,
    });
    runtimes[0]?.settle(0);
    await waitFor(() => initiator.completions.length === 1);

    const team = await teams.get('alpha');
    expect(initiator.completions).toEqual([
      {
        kind: 'teammate',
        source: team.leader.name,
        status: 'completed',
        result: 'leader finished',
      },
    ]);
    await teams.stopAll();
  });

  it('fails missing or closed Teams before submitting to the leader', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await expect(
      teams.sendToLeader('ghost', {
        prompt: 'should not submit',
        initiator: new FakeInitiator(),
      }),
    ).rejects.toThrow(/does not exist/);
    expect(runtimes).toHaveLength(0);

    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    await dissolveTeamForTest(teams, 'alpha', 'done');
    await expect(
      teams.sendToLeader('alpha', {
        prompt: 'should not revive',
        initiator: new FakeInitiator(),
      }),
    ).rejects.toThrow(/is closed/);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted).toHaveLength(0);
  });

  it('never reuses a closed Team name when recreating the prefix with reuse-cwd', async () => {
    const sourceRepo = join(root, 'source');
    mkdirSync(sourceRepo, { recursive: true });
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd: sourceRepo });
      return stdout;
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(sourceRepo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);

    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    const firstClaim = await teams.claimName('alpha');
    const firstName = firstClaim.name;
    expect(firstName).toMatch(/^alpha-[a-z0-9]{4,8}$/);
    await teams.create({
      name: firstName,
      nameClaimToken: firstClaim.token,
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha in a managed worktree',
      repoCwd: sourceRepo,
      worktree: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    const firstProjection = await teams.requireRoutableTeamProjection(firstName);
    expect(firstProjection.runtime_cwd).not.toBe(sourceRepo);

    await dissolveTeamForTest(
      teams,
      firstName,
      'replace the workspace mode',
    );
    await expect(teams.create({
      name: firstName,
      leaderAgentRuntime: 'agent-a',
      intent: 'must not reuse the closed concrete name',
      repoCwd: sourceRepo,
      worktree: { mode: 'reuse-cwd' },
    })).rejects.toThrow(/concrete Team names are never reused/);

    const secondClaim = await teams.claimName('alpha');
    const secondName = secondClaim.name;
    expect(secondName).toMatch(/^alpha-[a-z0-9]{4,8}$/);
    expect(secondName).not.toBe(firstName);
    await teams.create({
      name: secondName,
      nameClaimToken: secondClaim.token,
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha from the source checkout',
      repoCwd: sourceRepo,
      worktree: { mode: 'reuse-cwd' },
    });

    const secondProjection = await teams.requireRoutableTeamProjection(secondName);
    expect(secondProjection.runtime_cwd).toBe(sourceRepo);
    expect((await teams.get(secondName)).sharedWorkspace()).toMatchObject({
      sourceCwd: sourceRepo,
      runtimeCwd: sourceRepo,
      worktree: { mode: 'reuse-cwd', path: sourceRepo },
    });
    const record = await new TeamStore().get('dispatcher-a', secondName);
    expect(record).toMatchObject({
      repo_cwd: sourceRepo,
      runtime_cwd: sourceRepo,
      worktree: { mode: 'reuse-cwd', path: sourceRepo },
    });
    await teams.stopAll();
  });

  it('recovers the same collaboration name claim after restart while explicit create skips it', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const createCollection = (
      runtimes: FakeRuntime[],
      generateSuffix: () => string,
    ): TeamCollection =>
      new TeamCollection({
        dispatcherId: 'dispatcher-a',
        config,
        agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
        worktrees: new WorktreeManager(),
        identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
        initiatorFor: async () => null,
        isShuttingDown: () => false,
        adminSocketPath: '/tmp/admin.sock',
        leaderChannelDescriptors: () => [],
        log,
        nameSuffixGenerator: generateSuffix,
      });

    const channels = fakeChannels();
    const store = new CollaborationSpaceStore();
    const beforeRestart = createCollection([], () => 'aaaa');
    const firstService = new CollaborationSpaceService({
      dispatcherId: 'dispatcher-a',
      config,
      teams: beforeRestart,
      channels: channels.service,
      store,
      log,
      isShuttingDown: () => false,
    });
    await firstService.bind({
      spaceName: 'space-alpha',
      container: {
        container_type: 'topic_group',
        container_key: 'container-a',
      },
      leaderAgentRuntime: 'agent-a',
    });
    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: {
        container_type: 'topic_group',
        container_key: 'container-a',
      },
      target: {
        target_type: 'topic',
        target_key: 'topic-a',
        display: 'Alpha',
        bindable: true,
      },
    } as const;
    await expect(
      firstService.acceptTargetCreated(targetInput),
    ).resolves.toBe(true);
    const durableTarget = (await store.listTargets('dispatcher-a'))[0];
    expect(durableTarget).toMatchObject({
      team_name: 'space-alpha-aaaa',
      lifecycle_status: 'creating',
      phase: 'claimed',
    });
    expect(
      await beforeRestart.hasTeam(durableTarget!.team_name),
    ).toBe(false);

    const suffixes = ['aaaa', 'bbbb'];
    const runtimes: FakeRuntime[] = [];
    const afterRestart = createCollection(
      runtimes,
      () => suffixes.shift() ?? 'bbbb',
    );
    const explicit = await afterRestart.createFromPrefix({
      namePrefix: 'space-alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'must skip the durable collaboration claim',
    });
    expect(explicit.team.team_name).toBe('space-alpha-bbbb');
    expect(runtimes).toHaveLength(1);

    const resumedService = new CollaborationSpaceService({
      dispatcherId: 'dispatcher-a',
      config,
      teams: afterRestart,
      channels: channels.service,
      store,
      log,
      isShuttingDown: () => false,
    });
    await resumedService.resumePendingTargets();
    await expect(
      resumedService.status({ spaceName: 'space-alpha' }),
    ).resolves.toMatchObject({
      targets: [{
        team_name: 'space-alpha-aaaa',
        lifecycle_status: 'active',
        phase: 'bound',
      }],
    });
    expect(runtimes).toHaveLength(2);
    expect(channels.boundOwners.get('topic-a')).toMatchObject({
      teamName: 'space-alpha-aaaa',
    });
    await afterRestart.stopAll();
  });

  it('publishes competing name claims atomically and ignores interrupted temps', async () => {
    const store = new TeamStore();
    const results = await Promise.all([
      store.claimName('dispatcher-a', 'alpha-aaaa', 'owner-a'),
      store.claimName('dispatcher-a', 'alpha-aaaa', 'owner-b'),
    ]);
    expect([...results].sort()).toEqual([false, true]);
    const winner = results[0] ? 'owner-a' : 'owner-b';
    const loser = results[0] ? 'owner-b' : 'owner-a';
    await expect(
      store.requireNameClaim('dispatcher-a', 'alpha-aaaa', winner),
    ).resolves.toBeUndefined();
    await expect(
      store.requireNameClaim('dispatcher-a', 'alpha-aaaa', loser),
    ).rejects.toThrow(/claimed by another owner/);

    const interrupted = dispatcherTeamNameClaimPath(
      'dispatcher-a',
      'alpha-bbbb',
    );
    mkdirSync(dirname(interrupted), { recursive: true });
    writeFileSync(`${interrupted}.interrupted.tmp`, '{"version":');
    await expect(
      store.claimName('dispatcher-a', 'alpha-bbbb', 'owner-c'),
    ).resolves.toBe(true);
    await expect(
      store.requireNameClaim('dispatcher-a', 'alpha-bbbb', 'owner-c'),
    ).resolves.toBeUndefined();
  });

  it('regenerates before spawn when an unreadable identity directory occupies the candidate', async () => {
    const workspace = join(root, 'corrupt-identity-workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const identities = new AgentIdentityStore(log);
    await identities.create({
      dispatcherId: 'dispatcher-a',
      name: 'reviewer-aaaa',
      role: 'teammate',
      teamId: null,
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      sourceRepo: null,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: workspace,
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
      intent: 'corrupt occupancy fixture',
      status: 'closed',
    });
    writeFileSync(
      dispatcherAgentIdentityPath({
        dispatcherId: 'dispatcher-a',
        name: 'reviewer-aaaa',
        teamId: null,
        role: 'teammate',
      }),
      '{"version":',
    );

    const suffixes = ['aaaa', 'bbbb'];
    const worktrees = new WorktreeManager();
    const prepareWorkspace = vi.spyOn(worktrees, 'prepareDefaultWorkspace');
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: null,
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees,
      identities,
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      suffixGenerator: () => suffixes.shift()!,
      log,
    });
    const spawned = await collection.spawn({
        name: 'reviewer',
        prompt: 'skip the corrupt occupied candidate',
        intent: 'verify directory occupancy',
        agentRuntime: 'agent-a',
      });
    expect(spawned).toMatchObject({
      teammate: { name: 'reviewer-bbbb' },
    });
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    await collection.close({
      name: spawned.teammate.name,
      note: 'test complete',
    });
  });

  it('creates agent identities without silently replacing an existing file', async () => {
    const identities = new AgentIdentityStore(noopLog());
    const workspace = join(root, 'identity-workspace');
    mkdirSync(workspace, { recursive: true });
    const input = {
      dispatcherId: 'dispatcher-a',
      name: 'worker-aaaa',
      role: 'teammate' as const,
      teamId: null,
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      sourceRepo: null,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: {
        mode: 'reuse-cwd' as const,
        slug: null,
        path: workspace,
        branch: null,
        base_ref: null,
        cleanup: 'keep' as const,
        cleanup_state: 'not-managed' as const,
        cleanup_error: null,
      },
      intent: 'first identity',
      status: 'starting' as const,
    };
    await identities.create(input);
    await expect(
      identities.create({ ...input, intent: 'must not replace' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      identities.get('dispatcher-a', input.name),
    ).resolves.toMatchObject({ intent: 'first identity' });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

/**
 * Regression: closing a team member must NOT clean up the Team's shared
 * worktree. A member borrows the team's one managed worktree (spawn injects the
 * shared workspace), so its `close()` used to run `WorktreeManager.cleanup()`
 * on that shared worktree — `git worktree remove`-ing the live dir out from
 * under the leader and every other member when it was `delete-on-close` and
 * clean. The shared worktree is owned by the Team and must only be cleaned at
 * `dissolve`. This exercises the real delete path (a fresh managed worktree at
 * base HEAD is clean and reachable, so the old code's retain guard would NOT
 * save it).
 */
describe('closing a team member must not remove the shared team worktree', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-member-close-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves the managed/delete-on-close worktree on member close; only dissolve removes it', async () => {
    // A real source repo so the managed worktree is a real `git worktree`.
    const sourceRepo = join(root, 'source');
    mkdirSync(sourceRepo, { recursive: true });
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd: sourceRepo });
      return stdout;
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(sourceRepo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    const countWorktrees = async (): Promise<number> =>
      (await git(['worktree', 'list', '--porcelain']))
        .split('\n')
        .filter((line) => line.startsWith('worktree ')).length;

    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    // Create the team on a MANAGED, delete-on-close worktree of the source repo.
    await teams.create({
      name: 'gamma',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead gamma',
      repoCwd: sourceRepo,
      worktree: { mode: 'managed', cleanup: 'delete-on-close' },
      prompt: 'lead',
    });
    // source repo's main worktree + the team's managed worktree.
    expect(await countWorktrees()).toBe(2);

    const team = await teams.get('gamma');
    const spawn = await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });

    // Closing the member must leave the shared team worktree intact.
    await team.teammates.close({ name: spawn.teammate.name, note: 'member done' });
    expect(await countWorktrees()).toBe(2);

    // Dissolve is the one place that cleans the shared worktree.
    await dissolveTeamForTest(teams, 'gamma', 'team done');
    expect(await countWorktrees()).toBe(1);
  });
});

/**
 * Regression (issue #237): after `dissolve` removes the Team's shared worktree,
 * every borrower's recorded `cleanup_state` must reflect that — not stay
 * `managed-active`. Since members/leader skip cleanup on their own close (#236),
 * dissolve propagates its single authoritative cleanup result to the leader and
 * each member.
 */
describe('team dissolve syncs cleanup_state to the leader and members (#237)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-dissolve-state-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  it('reports cleanup_state "deleted" for the leader and members after dissolve', async () => {
    const sourceRepo = join(root, 'source');
    mkdirSync(sourceRepo, { recursive: true });
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd: sourceRepo });
      return stdout;
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(sourceRepo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);

    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(),
      completionDelivery: new CompletionDeliveryPolicy({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
    });

    await teams.create({
      name: 'delta',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead delta',
      repoCwd: sourceRepo,
      worktree: { mode: 'managed', cleanup: 'delete-on-close' },
      prompt: 'lead',
    });
    const team = await teams.get('delta');
    const spawn = await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });
    const memberName = spawn.teammate.name;

    // Sanity: before dissolve the leader's worktree is live.
    const before = await team.status();
    expect(before.leader!.repo?.cleanup_state).toBe('managed-active');

    const dissolved = await dissolveTeamForTest(teams, 'delta', 'team done');

    // The worktree is actually gone, AND the persisted/displayed state agrees.
    expect(dissolved.leader!.repo?.cleanup_state).toBe('deleted');
    const member = await team.teammates.status(memberName);
    expect(member.repo?.cleanup_state).toBe('deleted');
  });
});
