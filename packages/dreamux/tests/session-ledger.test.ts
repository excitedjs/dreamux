import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  dispatcherTeamMateIdentitiesDir,
  dispatcherTeamMateIdentityPath,
  dispatcherTeamMateSessionLedgerPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
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

  it('materializeSessions folds via a streaming reader, not an unbounded read() (#182 final gate)', async () => {
    const ledger = new TeamMateSessionLedger(noopLog());
    // Two sessions; one carries a huge settled assistant body to model the
    // long-ledger memory risk the streaming fold must avoid.
    await ledger.append({ identity: identity({ session_id: 'sess-a', name: 'a' }), type: 'spawn', prompt: 'a1', turnId: 't1' });
    await ledger.append({
      identity: identity({ session_id: 'sess-a', name: 'a' }),
      type: 'settled',
      turnId: 't1',
      assistant: 'x'.repeat(170_000),
      settleStatus: 'completed',
    });
    await ledger.append({ identity: identity({ session_id: 'sess-b', name: 'b' }), type: 'spawn', prompt: 'b1', turnId: 't1' });

    // The public `history` source must not buffer the whole append-only ledger
    // into an events array via the unbounded `read()`.
    const readSpy = vi.spyOn(ledger, 'read');
    const rows = await ledger.materializeSessions('flow');
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();

    expect(rows.map((r) => r.session_id).sort()).toEqual(['sess-a', 'sess-b']);
    // Folded rows keep only bounded previews — never the full assistant text.
    const a = rows.find((r) => r.session_id === 'sess-a')!;
    expect(a.last_assistant_preview).not.toBeNull();
    expect(a.last_assistant_preview!.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(rows)).not.toContain('x'.repeat(1000));
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

  function buildService(
    options: { sink?: () => Promise<never> } = {},
  ): { service: TeamMateAgentService; provider: FakeProvider } {
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
      // A completion sink so teammate runtimes get the settle hook wired. The
      // default no-op accepts; tests can inject a throwing sink.
      onTeamMateCompletion:
        options.sink ?? (async () => ({ status: 'accepted' }) as never),
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

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'review the auth change',
        prompt: 'Please review.',
        cwd: repo,
        worktree: { mode: 'managed', slug: 'reviewer', branch: 'dreamux/reviewer', cleanup: 'keep' },
      })
    ).teammate.name;

    await service.send({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Any progress?',
      intent: 'follow up on review',
    });

    // Settle the most recent turn → the settled event captures assistant output.
    provider.runtimes[0]?.settle('completed');
    await waitFor(async () => {
      const events = await service.sessions().read('flow');
      return events.some((e) => e.type === 'settled');
    });

    await service.close({ dispatcherId: 'flow', name: reviewer, note: 'merged and done' });

    const events = await service.sessions().read('flow');
    expect(events.map((e) => e.type)).toEqual(['spawn', 'send', 'settled', 'close']);

    const spawn = events.find((e) => e.type === 'spawn')!;
    expect(spawn).toMatchObject({
      name: reviewer,
      display_name: 'reviewer',
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
      // #188: the full assistant output is captured durably with a truncation flag.
      assistant: 'final assistant output',
      assistant_truncated: false,
      session_ref: 'thread-1',
      checkpoint_kind: 'codexThread',
    });

    expect(events.find((e) => e.type === 'close')?.note).toBe('merged and done');

    // All four events share the one stable session id, never re-keyed.
    expect(new Set(events.map((e) => e.session_id)).size).toBe(1);

    const [session] = await service.sessions().materializeSessions('flow');
    expect(session).toMatchObject({
      name: reviewer,
      display_name: 'reviewer',
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

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'first pass',
        prompt: 'go',
        cwd: repo,
        worktree: { mode: 'managed', slug: 'reviewer', cleanup: 'keep' },
      })
    ).teammate.name;
    await service.close({ dispatcherId: 'flow', name: reviewer, note: 'paused' });
    // send reopens the closed teammate from its checkpoint — same session.
    await service.send({ dispatcherId: 'flow', name: reviewer, prompt: 'resume' });

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
    // The leader name here is caller-supplied ('alpha-leader'); the member name
    // is service-allocated (#188), so it is found by role/display_name.
    const leaderEvent = events.find((e) => e.name === 'alpha-leader')!;
    expect(leaderEvent).toMatchObject({
      role: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
    });
    const memberEvent = events.find((e) => e.role === 'team_member')!;
    expect(memberEvent).toMatchObject({
      role: 'team_member',
      display_name: 'builder',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
    });
    expect(memberEvent.name).toMatch(/^tm-builder-[a-z0-9]{8}$/);
  });

  it('captures the settled turn even when reverse delivery fails (#182 PR-5, PR#187 P2)', async () => {
    const repo = await initGitRepo(join(root, 'sink-fail-repo'));
    const { service, provider } = buildService({
      sink: async () => {
        throw new Error('reverse delivery boom');
      },
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'review',
      prompt: 'go',
      cwd: repo,
      worktree: { mode: 'managed', slug: 'reviewer', cleanup: 'keep' },
    });

    provider.runtimes[0]?.settle('failed');

    // The terminal lifecycle fact is captured despite the failed delivery — that
    // is exactly when recovery metadata is most useful.
    await waitFor(async () => {
      const events = await service.sessions().read('flow');
      return events.some((e) => e.type === 'settled');
    });
    const settled = (await service.sessions().read('flow')).find((e) => e.type === 'settled')!;
    expect(settled).toMatchObject({
      settle_status: 'failed',
      assistant_preview: 'final assistant output',
      session_ref: 'thread-1',
    });
  });

  /** Seed a pre-PR-5 identity file (no `session_id`) directly on disk. */
  async function seedOldIdentity(
    name: string,
    status: 'running' | 'closed',
    cwd: string,
  ): Promise<void> {
    await mkdir(dispatcherTeamMateIdentitiesDir('flow'), { recursive: true });
    await writeFile(
      dispatcherTeamMateIdentityPath('flow', name),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name,
        owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
        role: 'teammate',
        team_id: null,
        agent_runtime: 'flow',
        // session_id intentionally absent — a pre-PR-5 record.
        source_cwd: cwd,
        source_repo: null,
        cwd,
        runtime_cwd: cwd,
        worktree: {
          mode: 'reuse-cwd',
          slug: null,
          path: cwd,
          branch: null,
          base_ref: null,
          cleanup: 'keep',
          cleanup_state: 'not-managed',
          cleanup_error: null,
        },
        intent: 'legacy work',
        created_at: 1,
        updated_at: 1,
        status,
        checkpoint: null,
        last_error: null,
        closed_at: status === 'closed' ? 2 : null,
        close_note: status === 'closed' ? 'paused' : null,
      }),
      { mode: 0o600 },
    );
  }

  it('mints a session id and captures send on a pre-PR-5 identity (#182 PR-5, PR#187 P3)', async () => {
    const { service } = buildService();
    const cwd = join(root, 'legacy-send');
    await mkdir(cwd, { recursive: true });
    await seedOldIdentity('legacy', 'closed', cwd);

    await service.send({ dispatcherId: 'flow', name: 'legacy', prompt: 'resume work' });

    const sends = (await service.sessions().read('flow')).filter((e) => e.type === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.session_id).toMatch(/.+/);
    expect(sends[0]?.prompt_preview).toBe('resume work');
  });

  it('mints a session id and captures close on a pre-PR-5 identity (#182 PR-5, PR#187 P3)', async () => {
    const { service } = buildService();
    const cwd = join(root, 'legacy-close');
    await mkdir(cwd, { recursive: true });
    await seedOldIdentity('legacy', 'running', cwd);

    await service.close({ dispatcherId: 'flow', name: 'legacy', note: 'archived' });

    const closes = (await service.sessions().read('flow')).filter((e) => e.type === 'close');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.session_id).toMatch(/.+/);
    expect(closes[0]?.note).toBe('archived');
  });

  it('last folds the ledger in append order (not event_id), overrides settled, pairs submit, isolates sessions (#188 P1)', async () => {
    const { service } = buildService();
    const cwd = join(root, 'append-order');
    await mkdir(cwd, { recursive: true });
    // Seed an identity bound to session 'sess-A'.
    await mkdir(dispatcherTeamMateIdentitiesDir('flow'), { recursive: true });
    await writeFile(
      dispatcherTeamMateIdentityPath('flow', 'reviewer-aaaaaaaa'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'reviewer-aaaaaaaa',
        display_name: 'reviewer',
        owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
        role: 'teammate',
        team_id: null,
        agent_runtime: 'flow',
        session_id: 'sess-A',
        source_cwd: cwd,
        source_repo: null,
        cwd,
        runtime_cwd: cwd,
        worktree: {
          mode: 'reuse-cwd',
          slug: null,
          path: cwd,
          branch: null,
          base_ref: null,
          cleanup: 'keep',
          cleanup_state: 'not-managed',
          cleanup_error: null,
        },
        intent: 'review',
        created_at: 1,
        updated_at: 1,
        status: 'running',
        checkpoint: null,
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
      { mode: 0o600 },
    );

    // Hand-craft the ledger so event_id DESCENDS down the file: any code that
    // sorted by event_id would reverse the turns and pick the wrong "latest"
    // settled. Correct behavior follows append (line) order.
    const base = {
      version: 1,
      dispatcher_id: 'flow',
      name: 'reviewer-aaaaaaaa',
      display_name: 'reviewer',
      role: 'teammate',
      team_id: null,
      leader_name: null,
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
      agent_runtime: 'flow',
      source_repo: null,
      source_cwd: cwd,
      cwd,
      worktree_slug: null,
      worktree_path: cwd,
      branch: null,
      base_ref: null,
      checkpoint_kind: null,
      session_ref: null,
      status: 'running',
      turn_origin: null,
      prompt_preview: null,
      assistant_preview: null,
      assistant: null,
      assistant_truncated: false,
      settle_status: null,
      note: null,
    };
    const lines = [
      // turn-1 submitted (dispatcher), then settled with an OLD answer.
      { ...base, session_id: 'sess-A', event_id: 500, timestamp: 500, type: 'spawn', turn_id: 'turn-1', turn_origin: 'dispatcher', prompt_preview: 'first prompt', intent: 'review one' },
      { ...base, session_id: 'sess-A', event_id: 400, timestamp: 400, type: 'settled', turn_id: 'turn-1', settle_status: 'completed', assistant: 'A1-old', assistant_preview: 'A1-old' },
      // turn-2 submitted (channel), then settled.
      { ...base, session_id: 'sess-A', event_id: 300, timestamp: 300, type: 'send', turn_id: 'turn-2', turn_origin: 'channel', prompt_preview: 'second prompt', intent: 'review two' },
      { ...base, session_id: 'sess-A', event_id: 200, timestamp: 200, type: 'settled', turn_id: 'turn-2', settle_status: 'completed', assistant: 'A2', assistant_preview: 'A2' },
      // A duplicate settled for turn-1 appended LATER must OVERRIDE the old one,
      // even though its event_id is the smallest.
      { ...base, session_id: 'sess-A', event_id: 100, timestamp: 100, type: 'settled', turn_id: 'turn-1', settle_status: 'completed', assistant: 'A1-new', assistant_preview: 'A1-new' },
      // A different session in the same file must NOT bleed into sess-A.
      { ...base, session_id: 'sess-B', event_id: 999, timestamp: 999, type: 'settled', turn_id: 'turn-9', settle_status: 'completed', assistant: 'other-session', assistant_preview: 'other-session' },
    ];
    await mkdir(
      dispatcherTeamMateSessionLedgerPath('flow').replace(/\/[^/]+$/, ''),
      { recursive: true },
    );
    await writeFile(
      dispatcherTeamMateSessionLedgerPath('flow'),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      { mode: 0o600 },
    );

    const last = await service.last('flow', 'reviewer-aaaaaaaa', 5);
    expect(last.session_id).toBe('sess-A');
    // Append order, not event_id order: turn-1 before turn-2, no sess-B bleed.
    expect(last.turns.map((t) => t.turn_id)).toEqual(['turn-1', 'turn-2']);
    // The later duplicate settled for turn-1 wins (override by append order).
    expect(last.turns[0]).toMatchObject({
      turn_id: 'turn-1',
      assistant: 'A1-new',
      turn_origin: 'dispatcher',
      prompt_preview: 'first prompt',
      intent: 'review one',
      submitted_at: 500,
    });
    // turns>1 pairs each settled row with its submit-side prompt/origin/intent.
    expect(last.turns[1]).toMatchObject({
      turn_id: 'turn-2',
      assistant: 'A2',
      turn_origin: 'channel',
      prompt_preview: 'second prompt',
      intent: 'review two',
    });

    // turns=1 (default) returns just the newest-by-append-order settled turn.
    const latest = await service.last('flow', 'reviewer-aaaaaaaa');
    expect(latest.turns.map((t) => t.turn_id)).toEqual(['turn-2']);
  });
});
