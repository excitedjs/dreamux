import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCreateContext,
  type AgentRuntimeLastResult,
  type AgentRuntimeProvider,
  type AgentRuntimeResumeInput,
  type AgentRuntimeSystemInput,
  type AgentRuntimeTurnResult,
  type CompletionEnvelope,
  type TeamMateCompletionDeliveryResult,
} from '../src/agent-runtime/index.js';
import type { InboundTurnInput, TurnSettledSignal } from '../src/agent-runtime/turn.js';
import { createFakeFeishuBot } from '../src/channel/feishu/bot.js';
import { DispatcherService } from '../src/dispatcher-service/service.js';
import { teamLeaderPrincipal } from '../src/dispatcher-service/teammate/types.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [{ kind: 'codexInboxTurn', description: 'inbox turn' }],
};

/**
 * One fake runtime used for both roles in the facade:
 *  - the dispatcher's own runtime (created via {@link DispatcherService.startDispatcher})
 *  - the teammate's runtime (created via {@link DispatcherService.spawnTeamMate})
 *
 * It records whether the launcher wired `onTurnSettled` (the reverse-delivery
 * settle hook) and every `completionInput` envelope it receives, so a test can
 * assert the full Seam ①→②→③ join end-to-end.
 */
class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private resumed = false;
  private turns = 0;
  private activeTurnId: string | null = null;
  readonly delivered: CompletionEnvelope[] = [];

  constructor(
    private readonly context: AgentRuntimeCreateContext,
    private readonly instanceId: number,
  ) {}

  async start(): Promise<void> {
    this.status = 'ready';
    this.threadId = `${this.context.row.dispatcher_id}-thread`;
    await this.context.state?.setThreadId(this.context.row.dispatcher_id, this.threadId);
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    this.resumed = true;
    this.status = 'ready';
    this.threadId = input.checkpoint?.id ?? null;
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'stopped');
  }

  async channelInput(_input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    if (this.activeTurnId !== null) {
      return { status: 'submitted', turnId: this.activeTurnId };
    }
    this.turns += 1;
    this.activeTurnId = `runtime-${this.instanceId}-turn-${this.turns}`;
    return { status: 'submitted', turnId: this.activeTurnId };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
    this.delivered.push(completion);
    return { status: 'accepted' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return this.activeTurnId === null
      ? { text: 'reviewer final answer' }
      : { text: null };
  }

  async getContext(): Promise<{ usedTokens: number; windowTokens: number }> {
    return { usedTokens: 12, windowTokens: 100 };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  /** True when the launcher wired the reverse-delivery settle hook. */
  hasSettleHook(): boolean {
    return this.context.onTurnSettled !== undefined;
  }

  /** Simulate the runtime firing a terminal turn-settled signal. */
  settle(status: TurnSettledSignal['status'], turnId: string | null): void {
    if (turnId !== null && this.activeTurnId === turnId) this.activeTurnId = null;
    this.context.onTurnSettled?.({ turnId, status });
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref = 'builtin:codex';
  readonly runtimes: FakeRuntime[] = [];

  constructor(readonly descriptor: AgentRuntimeProvider['descriptor']) {}

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
    const runtime = new FakeRuntime(context, this.runtimes.length + 1);
    this.runtimes.push(runtime);
    return runtime;
  }
}

/**
 * Dispatcher workspace cwd for the current test (issue #182 PR-4); set in
 * beforeEach to the per-test `workspace/` dir (a real, non-`~/.dreamux` repo)
 * so managed team worktrees land under `<workspace>/.workspace/worktree/...`.
 */
let dispatcherCwd: string;

function buildFacade(
  provider: FakeProvider,
  adminSocketPath: string,
): DispatcherService {
  const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  registry.registerImplementation(descriptor.id, provider);
  return new DispatcherService({
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    adminSocketPath,
    channelLoggerFactory: () => noopLog() as never,
    botFactory: () => createFakeFeishuBot('app-flow'),
    skipBotSecret: true,
    log: noopLog() as never,
  });
}

describe('reverse delivery end-to-end (Seam ①→②→③ through the facade)', () => {
  let root: string;
  let adminSocketPath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dx-reverse-e2e-'));
    await mkdir(join(root, 'workspace'));
    dispatcherCwd = join(root, 'workspace');
    adminSocketPath = join(root, 'a.sock');
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    // A best-effort record/turns write (atomic write = temp file + rename, issue
    // #199 Slice 4) can still be in flight when teardown runs, leaving a
    // transient `.tmp` sibling in `teammate/records/`. On slower filesystems the
    // recursive remove then races it and `rmdir` fails ENOTEMPTY. maxRetries
    // re-attempts (Node retries ENOTEMPTY) once the rename/cleanup completes.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("settles a teammate turn and reaches the dispatcher runtime's completionInput", async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const spawned = await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'work',
      prompt: 'Review the change.',
      cwd: workspace(root),
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;

    // Self-delivery guard: only the teammate runtime carries the settle hook.
    expect(dispatcherRuntime.hasSettleHook()).toBe(false);
    expect(teammateRuntime.hasSettleHook()).toBe(true);

    expect(spawned.turn.status).toBe('submitted');
    const turnId =
      spawned.turn.status === 'submitted' ? spawned.turn.turn_id : 'unreachable';
    teammateRuntime.settle('completed', turnId);
    await flush();

    const reviewer = spawned.teammate.name;
    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: reviewer,
        id: `${reviewer}:${turnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
    ]);

    await facade.shutdown();
  });

  it("routes a team member completion to the owning TeamLeader runtime", async () => {
    await initGitRepo(workspace(root));
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const created = await facade.createTeam({
      dispatcherId: 'flow',
      name: 'alpha',
      intent: 'work',
      repoCwd: workspace(root),
      leaderAgentRuntime: 'flow',
    });
    const workspaceInfo = await facade.teams.sharedWorkspace('flow', 'alpha');
    const spawned = await facade.teammates.spawnScoped({
      principal: teamLeaderPrincipal({
        dispatcherId: 'flow',
        teamId: 'alpha',
        // #188: scope to the team's concrete leader name (routing resolves the
        // live leader runtime by this stored name).
        leaderName: created.team.leader_name,
      }),
      name: 'builder',
      intent: 'work',
      prompt: 'Build it.',
      sharedWorkspace: workspaceInfo,
    });
    const builder = spawned.teammate.name;

    const dispatcherRuntime = provider.runtimes[0]!;
    const leaderRuntime = provider.runtimes[1]!;
    const memberRuntime = provider.runtimes[2]!;
    const turnId =
      spawned.turn.status === 'submitted' ? spawned.turn.turn_id : 'unreachable';
    memberRuntime.settle('completed', turnId);
    await flush();
    // Wait past the removed 25ms poller's interval: a duplicate delivery path
    // would have pushed a second envelope into the leader runtime by now.
    await sleep(150);

    expect(leaderRuntime.delivered).toEqual([
      {
        source: builder,
        id: `${builder}:${turnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
    ]);
    expect(dispatcherRuntime.delivered).toEqual([]);

    await facade.shutdown();
  });

  it('captures a bound-channel TeamLeader completion in the leader turns archive, never a dispatcher push', async () => {
    await initGitRepo(workspace(root));
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const created = await facade.createTeam({
      dispatcherId: 'flow',
      name: 'alpha',
      intent: 'work',
      repoCwd: workspace(root),
      leaderAgentRuntime: 'flow',
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const leaderRuntime = provider.runtimes[1]!;
    // Settle the dispatcher-initiated bootstrap turn first so the channel turn
    // below gets its own turn id instead of being steered into the bootstrap.
    const bootstrapTurnId =
      created.turn.status === 'submitted' ? created.turn.turn_id : 'unreachable';
    leaderRuntime.settle('completed', bootstrapTurnId);
    await flush();

    const submitted = await facade.teams.deliverToLeader({
      dispatcherId: 'flow',
      teamId: 'alpha',
      turn: { sourceId: 'msg-team', text: 'team asks' },
    });
    const turnId = submitted.status === 'submitted' ? submitted.turnId : 'unreachable';
    expect(turnId).not.toBe(bootstrapTurnId);
    leaderRuntime.settle('completed', turnId);
    const leaderName = created.team.leader_name;
    const settledRowsFor = async (): Promise<number> => {
      let count = 0;
      for await (const row of facade.teammates.turns().stream('flow', leaderName)) {
        if (row.type === 'settled' && row.turn_id === turnId) count += 1;
      }
      return count;
    };
    // #199 Slice 3: the channel-origin leader completion lands as a settled row
    // in the LEADER's own turns archive (pull-only), not the removed team ledger.
    await waitFor(async () => (await settledRowsFor()) >= 1);
    // Wait past the removed 25ms poller's interval: a second (duplicate) delivery
    // path would have appended a second settled row by now.
    await sleep(150);
    expect(await settledRowsFor()).toBe(1);
    // The bound-channel turn never reaches dispatcher context.
    expect(dispatcherRuntime.delivered.map((env) => env.id)).not.toContain(
      `${leaderName}:${turnId}`,
    );

    await facade.shutdown();
  });

  it('pushes the dispatcher-initiated bootstrap TeamLeader completion to the dispatcher; the dispatcher cannot send to the leader directly (#199 Slice 4)', async () => {
    await initGitRepo(workspace(root));
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const created = await facade.createTeam({
      dispatcherId: 'flow',
      name: 'alpha',
      intent: 'work',
      repoCwd: workspace(root),
      leaderAgentRuntime: 'flow',
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const leaderRuntime = provider.runtimes[1]!;
    const leaderName = created.team.leader_name;
    // The create bootstrap turn is dispatcher-initiated (origin 'dispatcher'), so
    // settling it pushes the completion back to the dispatcher — not pull-only.
    const bootstrapTurnId =
      created.turn.status === 'submitted' ? created.turn.turn_id : 'unreachable';
    leaderRuntime.settle('completed', bootstrapTurnId);
    await flush();
    expect(dispatcherRuntime.delivered.map((env) => env.id)).toContain(
      `${leaderName}:${bootstrapTurnId}`,
    );

    // #199 Slice 4: the dispatcher cannot reach the TeamLeader through
    // teammate.send — a TeamLeader is not on the dispatcher `teammate.*` surface.
    await expect(
      facade.sendTeamMate({
        dispatcherId: 'flow',
        name: leaderName,
        prompt: 'Status check from the dispatcher.',
      }),
    ).rejects.toThrow(/does not exist/);

    await facade.shutdown();
  });

  it('coalesces duplicate settled events for the same teammate turn', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const spawned = await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'work',
      prompt: 'Review the change.',
      cwd: workspace(root),
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;

    const turnId =
      spawned.turn.status === 'submitted' ? spawned.turn.turn_id : 'unreachable';
    teammateRuntime.settle('completed', turnId);
    teammateRuntime.settle('completed', turnId);
    await flush();
    teammateRuntime.settle('completed', turnId);
    await flush();

    const reviewer = spawned.teammate.name;
    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: reviewer,
        id: `${reviewer}:${turnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
    ]);

    // The settled-turn capture is a best-effort (fire-and-forget) record write.
    // Wait until it is durable before tearing down, so a still-in-flight atomic
    // write (temp file + rename) cannot race the recursive cleanup (ENOTEMPTY).
    await waitFor(
      async () => (await facade.getTeamMateLast('flow', reviewer)).returned_turns === 1,
    );

    await facade.shutdown();
  });

  it('reverse-delivers one completion for multiple sends steered into the current turn', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const spawned = await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'work',
      prompt: 'Review the change.',
      cwd: workspace(root),
    });
    const reviewer = spawned.teammate.name;
    const firstSend = await facade.sendTeamMate({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Fold this into the active review.',
    });
    const secondSend = await facade.sendTeamMate({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'One more steering note.',
    });

    expect(spawned.turn.status).toBe('submitted');
    expect(firstSend.turn).toEqual(spawned.turn);
    expect(secondSend.turn).toEqual(spawned.turn);

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;
    const turnId =
      spawned.turn.status === 'submitted' ? spawned.turn.turn_id : 'unreachable';
    teammateRuntime.settle('completed', turnId);
    await flush();

    // #188/#199: last reads the settled turn from the per-name turns archive by
    // concrete name. The settled-turn capture trails reverse delivery, so wait
    // for it (the record write is atomic, so this concurrent read is safe).
    await waitFor(
      async () => (await facade.getTeamMateLast('flow', reviewer)).returned_turns === 1,
    );
    const last = await facade.getTeamMateLast('flow', reviewer);
    expect(last.turns.at(-1)).toMatchObject({
      assistant: 'reviewer final answer',
      assistant_truncated: false,
      settle_status: 'completed',
    });
    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: reviewer,
        id: `${reviewer}:${turnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
    ]);

    await facade.shutdown();
  });

  it('reverse-delivers a follow-up send after close/reopen with a fresh logical turn id', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const spawned = await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'work',
      prompt: 'Review the change.',
      cwd: workspace(root),
    });
    const reviewer = spawned.teammate.name;

    const dispatcherRuntime = provider.runtimes[0]!;
    const firstTeammateRuntime = provider.runtimes[1]!;
    const firstTurnId =
      spawned.turn.status === 'submitted' ? spawned.turn.turn_id : 'unreachable';
    firstTeammateRuntime.settle('completed', firstTurnId);
    await flush();

    await facade.closeTeamMate({
      dispatcherId: 'flow',
      name: reviewer,
      note: 'done',
    });
    const sent = await facade.sendTeamMate({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Follow up after reopen.',
    });

    const secondTeammateRuntime = provider.runtimes[2]!;
    expect(secondTeammateRuntime.wasThreadResumed()).toBe(true);
    expect(secondTeammateRuntime.hasSettleHook()).toBe(true);

    const secondTurnId =
      sent.turn.status === 'submitted' ? sent.turn.turn_id : 'unreachable';
    expect(secondTurnId).not.toBe(firstTurnId);

    // Duplicate settles for that reopened turn must still coalesce.
    secondTeammateRuntime.settle('completed', secondTurnId);
    secondTeammateRuntime.settle('completed', secondTurnId);
    await flush();

    // #188: last(turns) reads settled turns from the durable ledger. Both turns
    // share the one session id (close/reopen never re-keys it). The settled-turn
    // ledger append trails the reverse delivery, so wait for both to land.
    await waitFor(
      async () => (await facade.getTeamMateLast('flow', reviewer, 2)).returned_turns === 2,
    );
    const last = await facade.getTeamMateLast('flow', reviewer, 2);
    expect(last.turns.map((turn) => turn.turn_id)).toEqual([
      firstTurnId,
      secondTurnId,
    ]);
    expect(last.turns.at(-1)?.assistant).toBe('reviewer final answer');
    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: reviewer,
        id: `${reviewer}:${firstTurnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
      {
        source: reviewer,
        id: `${reviewer}:${secondTurnId}`,
        status: 'completed',
        result: 'reviewer final answer',
      },
    ]);

    await facade.shutdown();
  });

  it('delivers a terminal failure/stop settlement to completionInput (not dropped)', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const breaker = (
      await facade.spawnTeamMate({
        dispatcherId: 'flow',
        name: 'breaker',
        intent: 'work',
        prompt: 'Run.',
        cwd: workspace(root),
      })
    ).teammate.name;

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;

    teammateRuntime.settle('failed', 'turn-3');
    teammateRuntime.settle('stopped', 'turn-4');
    await flush();

    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: breaker,
        id: `${breaker}:turn-3`,
        status: 'failed',
        result: '',
      },
      {
        source: breaker,
        id: `${breaker}:turn-4`,
        status: 'stopped',
        result: '',
      },
    ]);

    await facade.shutdown();
  });

  it('delivers two concurrent teammate completions without a busy-loop', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    const one = (
      await facade.spawnTeamMate({
        dispatcherId: 'flow',
        name: 'one',
        intent: 'work',
        prompt: 'A.',
        cwd: workspace(root),
      })
    ).teammate.name;
    const two = (
      await facade.spawnTeamMate({
        dispatcherId: 'flow',
        name: 'two',
        intent: 'work',
        prompt: 'B.',
        cwd: workspace(root),
      })
    ).teammate.name;

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateOne = provider.runtimes[1]!;
    const teammateTwo = provider.runtimes[2]!;

    teammateOne.settle('completed', 'turn-1');
    teammateTwo.settle('completed', 'turn-1');
    await flush();

    // Both delivered exactly once each: accepted submit never retries.
    expect(dispatcherRuntime.delivered.map((env) => env.source).sort()).toEqual(
      [one, two].sort(),
    );
    expect(dispatcherRuntime.delivered).toHaveLength(2);

    await facade.shutdown();
  });
});

function noopLog(): {
  info: () => undefined;
  warn: () => undefined;
  error: () => undefined;
} {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Drain the macrotask the void-ed settle handler runs on. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

function workspace(root: string): string {
  return join(root, 'workspace');
}

async function initGitRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dreamux Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dreamux-test@example.com'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'test\n');
  await execa('git', ['add', 'README.md'], { cwd: path });
  await execa('git', ['commit', '-m', 'Initial test commit'], { cwd: path });
}
