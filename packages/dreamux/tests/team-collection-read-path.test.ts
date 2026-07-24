import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import {
  CompletionRouter,
  type CompletionDeliveryResult,
  type CompletionEnvelope,
} from '../src/service/completion-router/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  stopAttempts = 0;
  private status: AgentRuntimeStatus = 'declared';
  private onTurnSettled: ((settled: TurnSettledSignal) => void) | undefined;
  private readonly queuedStopErrors: Error[] = [];

  constructor(
    private readonly opts: {
      settleImmediately?: boolean;
      lastText?: string;
      submitError?: Error;
      stopError?: Error;
    } = {},
  ) {}

  setOnTurnSettled(onTurnSettled: (settled: TurnSettledSignal) => void): void {
    this.onTurnSettled = onTurnSettled;
  }

  settle(turnId: string, status: TurnSettledSignal['status'] = 'completed'): void {
    this.onTurnSettled?.({
      turnId,
      status,
      result: { text: this.opts.lastText ?? null },
    });
  }

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.stopAttempts += 1;
    const error = this.queuedStopErrors.shift() ?? this.opts.stopError;
    if (error !== undefined) throw error;
    this.status = 'stopped';
  }

  failNextStop(error: Error): void {
    this.queuedStopErrors.push(error);
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.submitted.push(input);
    const turnId = `turn-${this.submitted.length}`;
    if (this.opts.settleImmediately) {
      queueMicrotask(() =>
        this.onTurnSettled?.({
          turnId,
          status: 'completed',
          result: { text: this.opts.lastText ?? null },
        }),
      );
    }
    return { status: 'submitted', turnId };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    if (this.opts.submitError !== undefined) throw this.opts.submitError;
    this.submitted.push({ sourceId: input.sourceId ?? '', text: input.text });
    const turnId = `turn-${this.submitted.length}`;
    return { status: 'submitted', turnId };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return { id: 'thread-fake' };
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: this.opts.lastText ?? 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

function fakeRuntimeCatalog(
  runtimes: FakeRuntime[],
  opts: {
    settleImmediately?: boolean;
    lastText?: string;
    submitError?: Error;
    stopError?: Error;
  } = {},
  contexts: AgentRuntimeCreateContext[] = [],
): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(context: AgentRuntimeCreateContext) {
      contexts.push(context);
      const runtime = new FakeRuntime(opts);
      if (context.onTurnSettled !== undefined) {
        runtime.setOnTurnSettled(context.onTurnSettled);
      }
      runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== FAKE_RUNTIME_REF) {
        throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as AgentRuntimeProviderCatalog;
}

class FakeInitiator {
  readonly completions: CompletionEnvelope[] = [];

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    this.completions.push(completion);
    return { status: 'accepted' };
  }
}

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
    const turnsStore = new AgentTurnsStore(log);
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
      prompt: 'initial leader prompt',
    });

    // Spawn one team member through the team's own (store-sharing) collection.
    const team = await teams.get('alpha');
    const spawn = await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do the work',
      agentRuntime: 'agent-a',
      intent: 'member work',
    });
    expect(spawn.teammate.name).toMatch(/worker/);
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
        type: 'submit',
        turn_id: 'turn-1',
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
});

/**
 * Guards the create-time behavior change: a Team created WITHOUT an explicit
 * `prompt` must start its leader idle and fire no turn — we no longer fabricate
 * a synthetic default prompt and auto-run a turn at creation. The leader still
 * exists and is started (resumable), so a later bound channel or dispatcher
 * `send` drives its first real turn.
 */
describe('TeamCollection route readiness recovery', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-route-ready-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    expect(created.turn).toBeNull();

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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    })).rejects.toThrow(/creation and leader cleanup failed/);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.stopAttempts).toBe(1);

    await expect(teams.stopAll()).rejects.toBe(leaderStopError);
    expect(runtimes[0]?.stopAttempts).toBe(2);
    expect(runtimes[0]?.getStatus()).toBe('ready');
  });
});

describe('TeamCollection identity prompt launch behavior', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-identity-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    ]);
    const append = contexts[0]?.systemPrompt?.append ?? [];
    expect(append).toHaveLength(4);
    expect(append[0]).toBe('You are the TeamLeader of Dreamux Team "alpha".');
    expect(append[1]).toContain('team-workflow');
    expect(append[1]).toMatch(/TeamMate/i);
    expect(append[1]).toMatch(/channel/i);
    expect(append[1]).toMatch(/cron/i);
    expect(append[1]).toMatch(/transfer/i);
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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

describe('TeamCollection dispatcher send to TeamLeader', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-send-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
    const turnsStore = new AgentTurnsStore(log);
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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

    expect(Object.keys(sent).sort()).toEqual(['leader', 'team', 'turn']);
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
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual(['follow up']);

    const team = await teams.get('alpha');
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
        type: 'submit',
        turn_id: 'turn-1',
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
    const router = new CompletionRouter({ dispatcherId: 'dispatcher-a', log });
    const turnsStore = new AgentTurnsStore(log);
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, {
        lastText: 'leader finished',
      }),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log),
      turnsStore,
      router,
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
    runtimes[0]?.settle('turn-1');
    await waitFor(() => initiator.completions.length === 1);

    const team = await teams.get('alpha');
    expect(initiator.completions).toEqual([
      {
        source: team.leader.name,
        id: `${team.leader.name}:turn-1`,
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    const team = await teams.get('alpha');
    await team.dissolve({ teamId: 'alpha', note: 'done' });
    await expect(
      teams.sendToLeader('alpha', {
        prompt: 'should not revive',
        initiator: new FakeInitiator(),
      }),
    ).rejects.toThrow(/is closed/);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted).toHaveLength(0);
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
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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
    await team.dissolve({ teamId: 'gamma', note: 'team done' });
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
    mkdirSync(process.env['HOME'], { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
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

    const dissolved = await team.dissolve({ teamId: 'delta', note: 'team done' });

    // The worktree is actually gone, AND the persisted/displayed state agrees.
    expect(dissolved.leader!.repo?.cleanup_state).toBe('deleted');
    const member = await team.teammates.status(memberName);
    expect(member.repo?.cleanup_state).toBe('deleted');
  });
});
