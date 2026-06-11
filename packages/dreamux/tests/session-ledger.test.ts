import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
import { TeamMateSessionLedger } from '../src/dispatcher-service/teammate/session-ledger.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import {
  teamLeaderPrincipal,
  type TeamMateIdentity,
} from '../src/dispatcher-service/teammate/types.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

function noopLog() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never;
}

async function initGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dreamux Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dreamux-test@example.com'], { cwd: path });
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: path });
  return realpathSync(path);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ─── Unit: TeamMateSessionLedger directly ───────────────────────────────────

function identity(overrides: Partial<TeamMateIdentity> = {}): TeamMateIdentity {
  return {
    version: 1,
    dispatcher_id: 'flow',
    name: 'reviewer',
    owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
    role: 'teammate',
    team_id: null,
    agent_runtime: 'flow',
    session_id: 'sess-1',
    source_cwd: '/work/repo',
    source_repo: '/work/repo',
    cwd: '/work/space/.workspace/worktree/repo-abc/reviewer',
    runtime_cwd: '/work/space/.workspace/worktree/repo-abc/reviewer',
    worktree: {
      mode: 'managed',
      slug: 'reviewer',
      path: '/work/space/.workspace/worktree/repo-abc/reviewer',
      branch: 'dreamux/reviewer',
      base_ref: 'HEAD',
      cleanup: 'keep',
      cleanup_state: 'managed-active',
      cleanup_error: null,
    },
    intent: 'review the auth change',
    created_at: 1,
    updated_at: 1,
    status: 'running',
    checkpoint: { kind: 'codexThread', id: 'thread-xyz' },
    last_error: null,
    closed_at: null,
    close_note: null,
    ...overrides,
  };
}

describe('TeamMateSessionLedger (unit)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-ledger-')));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('appends events and reconstructs recovery metadata from the ledger alone', async () => {
    const ledger = new TeamMateSessionLedger(noopLog());
    await ledger.append({
      identity: identity({ checkpoint: null }),
      type: 'spawn',
      prompt: 'Review the change.',
      turnId: 'turn-1',
    });
    await ledger.append({ identity: identity(), type: 'send', prompt: 'Any update?', turnId: 'turn-2' });
    await ledger.append({
      identity: identity(),
      type: 'settled',
      turnId: 'turn-2',
      assistant: 'Looks good, shipped.',
      settleStatus: 'completed',
    });
    await ledger.append({
      identity: identity({ status: 'closed', close_note: 'done' }),
      type: 'close',
      note: 'merged and done',
    });

    const events = await ledger.read('flow');
    expect(events.map((e) => e.type)).toEqual(['spawn', 'send', 'settled', 'close']);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set(['sess-1']));

    const [session] = await ledger.materializeSessions('flow');
    expect(session).toMatchObject({
      session_id: 'sess-1',
      name: 'reviewer',
      role: 'teammate',
      agent_runtime: 'flow',
      // Runtime-resumable identifiers preserved for recovery weeks later.
      checkpoint_kind: 'codexThread',
      session_ref: 'thread-xyz',
      source_repo: '/work/repo',
      worktree_slug: 'reviewer',
      branch: 'dreamux/reviewer',
      base_ref: 'HEAD',
      intent: 'review the auth change',
      status: 'closed',
      turn_count: 2,
      last_prompt_preview: 'Any update?',
      last_assistant_preview: 'Looks good, shipped.',
      close_note_preview: 'merged and done',
    });
    // No volatile socket path leaks into the durable ledger.
    expect(JSON.stringify(events)).not.toMatch(/\.sock/);
  });

  it('preserves the human-readable leader name for a team member', async () => {
    const ledger = new TeamMateSessionLedger(noopLog());
    await ledger.append({
      identity: identity({
        name: 'builder',
        role: 'team_member',
        team_id: 'alpha',
        session_id: 'sess-member',
        owner: {
          kind: 'team',
          dispatcher_id: 'flow',
          team_id: 'alpha',
          leader_name: 'alpha-leader',
        },
      }),
      type: 'spawn',
      prompt: 'build it',
      turnId: 'turn-1',
    });
    const [row] = await ledger.materializeSessions('flow');
    expect(row).toMatchObject({
      name: 'builder',
      role: 'team_member',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
    });
  });

  it('keeps only the most recent N events when read is bounded', async () => {
    const ledger = new TeamMateSessionLedger(noopLog());
    for (let i = 0; i < 5; i += 1) {
      await ledger.append({ identity: identity(), type: 'send', prompt: `p${i}`, turnId: `turn-${i}` });
    }
    const tail = await ledger.read('flow', { limit: 2 });
    expect(tail).toHaveLength(2);
    expect(tail.map((e) => e.turn_id)).toEqual(['turn-3', 'turn-4']);
  });

  it('skips an event whose identity has no session id rather than writing it', async () => {
    const ledger = new TeamMateSessionLedger(noopLog());
    await ledger.append({ identity: identity({ session_id: null }), type: 'spawn', prompt: 'x' });
    expect(await ledger.read('flow')).toEqual([]);
  });
});

// ─── Integration: capture through TeamMateAgentService ───────────────────────

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [{ kind: 'codexInboxTurn', description: 'inbox turn' }],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private turns = 0;
  private lastTurnId: string | null = null;

  constructor(
    private readonly context: AgentRuntimeCreateContext,
    private readonly instanceId: number,
  ) {}

  async start(): Promise<void> {
    this.status = 'ready';
    this.threadId = `thread-${this.instanceId}`;
    await this.context.state?.setThreadId(this.context.row.dispatcher_id, this.threadId);
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    this.status = 'ready';
    this.threadId = input.checkpoint?.id ?? `thread-${this.instanceId}`;
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'stopped');
  }

  async channelInput(_input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.turns += 1;
    this.lastTurnId = `runtime-${this.instanceId}-turn-${this.turns}`;
    return { status: 'submitted', turnId: this.lastTurnId };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  async completionInput(): Promise<TeamMateCompletionDeliveryResult> {
    return { status: 'accepted' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'final assistant output' };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  /** Drive a terminal settle for the most recent turn. */
  settle(status: TurnSettledSignal['status']): void {
    this.context.onTurnSettled?.({ turnId: this.lastTurnId, status });
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

describe('session ledger capture (integration through TeamMateAgentService)', () => {
  let root: string;
  let dispatcherCwd: string;
  let previousHome: string | undefined;

  function buildService(): { service: TeamMateAgentService; provider: FakeProvider } {
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const registry = createBuiltinProviderRegistry();
    const descriptor = registry.resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    registry.registerImplementation(descriptor.id, provider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: noopLog(),
      // A no-op completion sink so teammate runtimes get the settle hook wired.
      onTeamMateCompletion: async () => ({ status: 'accepted' }) as never,
    });
    return { service, provider };
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-ledger-int-')));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    dispatcherCwd = join(root, 'workspace');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures spawn(intent), send(intent), settled(output+session id) and close(note)', async () => {
    const repo = await initGitRepo(join(root, 'repo'));
    const { service, provider } = buildService();

    await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'review the auth change',
      prompt: 'Please review.',
      cwd: repo,
      worktree: { mode: 'managed', slug: 'reviewer', branch: 'dreamux/reviewer', cleanup: 'keep' },
    });

    await service.send({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Any progress?',
      intent: 'follow up on review',
    });

    // Settle the most recent turn → the settled event captures assistant output.
    provider.runtimes[0]?.settle('completed');
    await waitFor(async () => {
      const events = await service.sessions().read('flow');
      return events.some((e) => e.type === 'settled');
    });

    await service.close({ dispatcherId: 'flow', name: 'reviewer', note: 'merged and done' });

    const events = await service.sessions().read('flow');
    expect(events.map((e) => e.type)).toEqual(['spawn', 'send', 'settled', 'close']);

    const spawn = events.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({
      name: 'reviewer',
      role: 'teammate',
      intent: 'review the auth change',
      source_repo: repo,
      worktree_slug: 'reviewer',
      branch: 'dreamux/reviewer',
      checkpoint_kind: 'codexThread',
      session_ref: 'thread-1',
    });
    expect(spawn.session_id).toMatch(/.+/);

    // The optional send intent updated the recorded recovery subject.
    expect(events.find((e) => e.type === 'send')?.intent).toBe('follow up on review');

    const settled = events.find((e) => e.type === 'settled')!;
    expect(settled).toMatchObject({
      settle_status: 'completed',
      assistant_preview: 'final assistant output',
      session_ref: 'thread-1',
      checkpoint_kind: 'codexThread',
    });

    expect(events.find((e) => e.type === 'close')?.note).toBe('merged and done');

    // All four events share the one stable session id, never re-keyed.
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);

    const [session] = await service.sessions().materializeSessions('flow');
    expect(session).toMatchObject({
      name: 'reviewer',
      session_ref: 'thread-1',
      intent: 'follow up on review',
      status: 'closed',
      turn_count: 2,
      last_assistant_preview: 'final assistant output',
      close_note_preview: 'merged and done',
    });
  });

  it('reuses the same session id when send reopens a closed teammate', async () => {
    const repo = await initGitRepo(join(root, 'reopen-repo'));
    const { service } = buildService();

    await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'first pass',
      prompt: 'go',
      cwd: repo,
      worktree: { mode: 'managed', slug: 'reviewer', cleanup: 'keep' },
    });
    await service.close({ dispatcherId: 'flow', name: 'reviewer', note: 'paused' });
    // send reopens the closed teammate from its checkpoint — same session.
    await service.send({ dispatcherId: 'flow', name: 'reviewer', prompt: 'resume' });

    const events = await service.sessions().read('flow');
    const reopenSend = events.filter((e) => e.type === 'send');
    expect(reopenSend).toHaveLength(1);
    // The reopen send shares the spawn's stable session id (no re-keying).
    expect(reopenSend[0]?.session_id).toBe(events.find((e) => e.type === 'spawn')?.session_id);
  });

  it('captures team leader and member identity metadata', async () => {
    const repo = await initGitRepo(join(root, 'team-repo'));
    const { service } = buildService();

    const leader = await service.createTeamLeader({
      dispatcherId: 'flow',
      teamId: 'alpha',
      name: 'alpha-leader',
      prompt: 'lead',
      agentRuntime: 'flow',
      sourceCwd: repo,
      sourceRepo: repo,
      runtimeCwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'team-alpha',
        path: join(dispatcherCwd, '.workspace', 'worktree', 'x', 'team-alpha'),
        branch: 'dreamux/team-alpha',
        base_ref: 'HEAD',
        cleanup: 'keep',
        cleanup_state: 'managed-active',
        cleanup_error: null,
      },
      intent: 'ship alpha',
    });

    const leaderPrincipal = teamLeaderPrincipal({
      dispatcherId: 'flow',
      teamId: 'alpha',
      leaderName: 'alpha-leader',
    });
    await service.spawnScoped({
      principal: leaderPrincipal,
      name: 'builder',
      intent: 'build the feature',
      prompt: 'build',
      sharedWorkspace: {
        sourceCwd: repo,
        sourceRepo: repo,
        runtimeCwd: repo,
        worktree: leader.teammate.worktree,
      },
    });

    const events = await service.sessions().read('flow');
    const leaderEvent = events.find((e) => e.name === 'alpha-leader')!;
    expect(leaderEvent).toMatchObject({
      role: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
    });
    const memberEvent = events.find((e) => e.name === 'builder')!;
    expect(memberEvent).toMatchObject({
      role: 'team_member',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
    });
  });
});
