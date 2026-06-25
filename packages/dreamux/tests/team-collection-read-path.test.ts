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
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamMateIdentityStore } from '../src/service/teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../src/service/teammate-collection/turns-store.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { ChannelBindingStore } from '../src/service/channel-binding/store.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: false },
  systemPrompt: { mode: 'append' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  private status: AgentRuntimeStatus = 'declared';

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    return { status: 'submitted', turnId: `turn-${this.submitted.length}` };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getThreadId(): string | null {
    return 'thread-fake';
  }

  wasThreadResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

function fakeRuntimeCatalog(runtimes: FakeRuntime[]): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(_context: AgentRuntimeCreateContext) {
      const runtime = new FakeRuntime();
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
    const teams = new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes),
      worktrees: new WorktreeManager(),
      bindings: new ChannelBindingStore(),
      identities: new TeamMateIdentityStore({ warn: log.warn.bind(log) }),
      turnsStore: new TeamMateTurnsStore({ warn: log.warn.bind(log) }),
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
      bindings: new ChannelBindingStore(),
      identities: new TeamMateIdentityStore({ warn: log.warn.bind(log) }),
      turnsStore: new TeamMateTurnsStore({ warn: log.warn.bind(log) }),
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
});

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
      bindings: new ChannelBindingStore(),
      identities: new TeamMateIdentityStore({ warn: log.warn.bind(log) }),
      turnsStore: new TeamMateTurnsStore({ warn: log.warn.bind(log) }),
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
      bindings: new ChannelBindingStore(),
      identities: new TeamMateIdentityStore({ warn: log.warn.bind(log) }),
      turnsStore: new TeamMateTurnsStore({ warn: log.warn.bind(log) }),
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
