import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
} from '../src/agent-runtime/index.js';
import type { TurnSettledSignal } from '../src/agent-runtime/turn.js';
import type { InboundTurnInput } from '../src/agent-runtime/turn.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private resumed = false;
  private turns = 0;
  readonly submitted: InboundTurnInput[] = [];

  constructor(private readonly context: AgentRuntimeCreateContext) {}

  async start(): Promise<void> {
    this.status = 'ready';
    this.threadId = `${this.context.row.dispatcher_id}-thread`;
    await this.context.state?.setThreadId(
      this.context.row.dispatcher_id,
      this.threadId,
    );
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

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    this.turns += 1;
    return { status: 'submitted', turnId: `turn-${this.turns}` };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
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
    return { text: 'last fake result' };
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
    this.context.onTurnSettled?.({ turnId, status });
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref: string;
  readonly runtimes: FakeRuntime[] = [];
  /** Every create context this provider was asked to build, for assertions. */
  readonly contexts: AgentRuntimeCreateContext[] = [];

  constructor(
    readonly descriptor: AgentRuntimeProvider['descriptor'],
    ref: string = 'builtin:codex',
  ) {
    this.ref = ref;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
    this.contexts.push(context);
    const runtime = new FakeRuntime(context);
    this.runtimes.push(runtime);
    return runtime;
  }
}

function providerCatalog(): {
  catalog: AgentRuntimeProviderCatalog;
  provider: FakeProvider;
} {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  const provider = new FakeProvider(descriptor);
  registry.registerImplementation(descriptor.id, provider);
  return {
    catalog: new AgentRuntimeProviderCatalog({ registry }),
    provider,
  };
}

function buildService(provider: AgentRuntimeProvider): TeamMateAgentService {
  const config = testDreamuxConfig();
  const dispatchers = new DispatcherStore(config);
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  registry.registerImplementation(descriptor.id, provider);
  return new TeamMateAgentService({
    config,
    dispatchers,
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

describe('TeamMateAgentService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // realpath: on macOS tmpdir() is a /var -> /private/var symlink, and git
    // reports symlink-resolved repo roots (source_repo), so fixture paths must
    // be canonical for path equality assertions.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-teammate-agent-')));
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

  it('runs a cross-provider teammate from its own named agent config', async () => {
    // Dispatcher 'flow' runs the 'codex' agent (builtin:codex). A teammate that
    // names the 'claude' agent (builtin:claude-code) must run with the claude
    // agent's resolved config — NOT inherit the codex dispatcher's runtime
    // (which is the wrong shape and used to throw "is not wired to Claude
    // Code"). The create-context dispatcher carries the teammate's OWN resolved
    // runtime, so cross-provider correctness falls out structurally.
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'codex' });
    const config = {
      agents: {
        codex: {
          provider: 'builtin:codex',
          config: dispatcher.runtime.config,
        },
        claude: {
          provider: 'builtin:claude-code',
          config: { permission_mode: 'default' },
        },
      },
      dispatchers: [dispatcher],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const claudeDesc = registry.resolve('builtin:claude-code');
    const codexProvider = new FakeProvider(codexDesc, 'builtin:codex');
    const claudeProvider = new FakeProvider(claudeDesc, 'builtin:claude-code');
    registry.registerImplementation(codexDesc.id, codexProvider);
    registry.registerImplementation(claudeDesc.id, claudeProvider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'claude-mate',
      agentRuntime: 'claude',
      prompt: 'go',
      cwd: root,
    });
    expect(claudeProvider.contexts).toHaveLength(1);
    // The teammate's create-context carries the claude agent's resolved runtime,
    // taken from agents['claude'] — never the dispatcher's codex runtime.
    expect(claudeProvider.contexts[0]?.dispatcher).not.toBeNull();
    expect(claudeProvider.contexts[0]?.dispatcher?.runtime.provider).toBe(
      'builtin:claude-code',
    );

    // A teammate omitting agentRuntime falls back to the dispatcher's own agent.
    await service.spawn({
      dispatcherId: 'flow',
      name: 'codex-mate',
      prompt: 'go',
      cwd: root,
    });
    expect(codexProvider.contexts).toHaveLength(1);
    expect(codexProvider.contexts[0]?.dispatcher).not.toBeNull();
    expect(codexProvider.contexts[0]?.dispatcher?.runtime.provider).toBe(
      'builtin:codex',
    );
  });

  it('dispatcher and teammate referencing the same agent id get the same resolved runtime (#148)', async () => {
    // Both the dispatcher config (resolved at loadConfig) and the teammate
    // create-context (resolved at spawn time by service.ts) walk the same
    // agents[] id -> {provider, config} map. They must produce structurally
    // equal results — this guards both resolution paths against drift.
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'shared' });
    // Manually inject a shared agent entry so the dispatcher's resolved
    // runtime comes from agents['shared'] (same as what the teammate will get).
    const sharedRuntime = dispatcher.runtime;
    const config = {
      agents: { shared: { provider: sharedRuntime.provider, config: sharedRuntime.config } },
      dispatchers: [{ ...dispatcher, agentRuntime: 'shared', runtime: sharedRuntime }],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const provider = new FakeProvider(codexDesc, 'builtin:codex');
    registry.registerImplementation(codexDesc.id, provider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: noopLog(),
    });

    // Spawn a teammate that explicitly names the same 'shared' agent.
    await service.spawn({
      dispatcherId: 'flow',
      name: 'same-mate',
      agentRuntime: 'shared',
      prompt: 'go',
      cwd: root,
    });
    expect(provider.contexts).toHaveLength(1);
    const teammateDispatcher = provider.contexts[0]?.dispatcher;
    expect(teammateDispatcher).not.toBeNull();
    // The teammate's dispatcher.runtime must deep-equal the dispatcher's own
    // resolved runtime — both came from agents['shared'].
    expect(teammateDispatcher?.runtime).toEqual(sharedRuntime);
    expect(teammateDispatcher?.runtime.provider).toBe('builtin:codex');
  });

  it('getCapabilities advertises spawnable agents[].id values, not provider refs', async () => {
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'codex-safe' });
    const config = {
      agents: {
        'codex-safe': {
          provider: 'builtin:codex',
          config: dispatcher.runtime.config,
        },
        'codex-yolo': {
          provider: 'builtin:codex',
          config: { ...dispatcher.runtime.config, sandbox_mode: 'danger-full-access' },
        },
      },
      dispatchers: [dispatcher],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const provider = new FakeProvider(codexDesc, 'builtin:codex');
    registry.registerImplementation(codexDesc.id, provider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: noopLog(),
    });

    const capabilities = service.getCapabilities();
    expect(capabilities.agent_runtimes.map((entry) => entry.id)).toEqual([
      'codex-safe',
      'codex-yolo',
    ]);
    expect(
      capabilities.agent_runtimes.map((entry) => entry.spawn.agent_runtime),
    ).toEqual(['codex-safe', 'codex-yolo']);
    expect(JSON.stringify(capabilities)).not.toContain('provider_ref');
    expect(JSON.stringify(capabilities)).not.toContain('builtin:codex');

    const spawnableId = capabilities.agent_runtimes[1]!.id;
    expect(spawnableId).toBe('codex-yolo');
    await service.spawn({
      dispatcherId: 'flow',
      name: 'from-caps',
      agentRuntime: spawnableId,
      prompt: 'go',
      cwd: root,
    });
    expect(provider.contexts[0]?.dispatcher?.agentRuntime).toBe('codex-yolo');
  });

  it('spawns a named resumable teammate and records raw history events', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Review the change.',
      cwd: root,
    });
    expect(spawned.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(spawned.teammate).toMatchObject({
      name: 'reviewer',
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
      agent_runtime: 'flow',
      source_cwd: root,
      runtime_cwd: root,
      worktree: {
        mode: 'reuse-cwd',
        path: root,
        cleanup_state: 'not-managed',
      },
      status: 'running',
      checkpoint: { kind: 'codexThread', id: expect.stringContaining('thread') },
    });

    await service.send({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Check tests too.',
    });
    const sent = await service.send({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Continue from prior context.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-3' });
    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0]?.submitted).toHaveLength(3);

    const history = await service.historyEvents('flow', 'reviewer');
    expect(history.events.map((event) => event.type)).toEqual([
      'state',
      'spawn',
      'send',
      'send',
    ]);
    expect(history.events.map((event) => event.prompt_preview)).toEqual([
      null,
      'Review the change.',
      'Check tests too.',
      'Continue from prior context.',
    ]);
  });

  it('resumes persisted identity through the same provider contract', async () => {
    const { provider } = providerCatalog();
    const first = buildService(provider);
    await first.spawn({
      dispatcherId: 'flow',
      name: 'builder',
      prompt: 'Build once.',
      cwd: root,
    });
    await first.stopAll();

    const second = buildService(provider);
    const sent = await second.send({
      dispatcherId: 'flow',
      name: 'builder',
      prompt: 'Resume and continue.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);

    const last = await second.last('flow', 'builder');
    const ctx = await second.context('flow', 'builder');
    expect(last.last).toEqual({ text: 'last fake result' });
    expect(ctx.context).toEqual({ usedTokens: 12, windowTokens: 100 });
  });

  it('returns a bounded session ledger with worktree metadata and filters', async () => {
    const repo = await initGitRepo(join(root, 'ledger-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'alpha',
      prompt: 'Review alpha.',
      cwd: root,
      intent: 'review alpha',
    });
    await service.spawn({
      dispatcherId: 'flow',
      name: 'managed-ledger',
      prompt: 'Build managed.',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'managed-ledger',
        branch: 'dreamux/managed-ledger',
        cleanup: 'keep',
      },
      intent: 'managed work',
    });
    await service.close({ dispatcherId: 'flow', name: 'alpha', note: 'done' });

    const firstPage = await service.history({ dispatcherId: 'flow', limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).not.toBeNull();

    const all = await service.history({ dispatcherId: 'flow' });
    expect(all.items.map((item) => item.name).sort()).toEqual([
      'alpha',
      'managed-ledger',
    ]);
    const managed = all.items.find((item) => item.name === 'managed-ledger');
    expect(managed).toMatchObject({
      id: 'managed-ledger',
      agent_runtime: 'flow',
      source_cwd: repo,
      source_repo: repo,
      runtime_cwd: expect.stringContaining('managed-ledger'),
      worktree: {
        mode: 'managed',
        slug: 'managed-ledger',
        branch: 'dreamux/managed-ledger',
        cleanup_state: 'managed-active',
      },
      intent: 'managed work',
      close_status: 'open',
      resume: { tool: 'send', name: 'managed-ledger' },
    });

    const closed = await service.history({
      dispatcherId: 'flow',
      closeStatus: 'closed',
    });
    expect(closed.items.map((item) => item.name)).toEqual(['alpha']);
    expect(closed.items[0]).toMatchObject({
      close_note_preview: 'done',
      last_prompt_preview: 'Review alpha.',
    });

    const grep = await service.history({ dispatcherId: 'flow', grep: 'managed work' });
    expect(grep.items.map((item) => item.name)).toEqual(['managed-ledger']);

    const second = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const afterRestart = await second.history({
      dispatcherId: 'flow',
      name: 'managed-ledger',
    });
    expect(afterRestart.items).toHaveLength(1);
    expect(afterRestart.items[0]?.worktree.mode).toBe('managed');
  });

  it('closes a live teammate without deleting its history', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'closer',
      prompt: 'Start.',
      cwd: root,
    });
    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'closer',
      note: 'done',
    });
    expect(closed.teammate).toMatchObject({
      name: 'closer',
      status: 'closed',
      close_note: 'done',
    });
    // Read-only verbs never silently reopen a closed teammate (issue #155):
    // only send carries the reopen flag. last/ctx need a live runtime, so they
    // reject on a closed teammate; status reads the identity and returns the
    // closed state without reopening (it does not throw).
    await expect(service.last('flow', 'closer')).rejects.toThrow(/closed/);
    await expect(service.context('flow', 'closer')).rejects.toThrow(/closed/);
    expect((await service.status('flow', 'closer')).status).toBe('closed');

    const historyFile = await readFile(
      join(root, 'home', '.dreamux', 'state', 'flow', 'teammate', 'history', 'closer.jsonl'),
      'utf8',
    );
    expect(historyFile).toContain('"type":"spawn"');
    expect(historyFile).toContain('"type":"close"');
  });

  it('send reopens a closed teammate from its checkpoint (issue #155)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'reopener',
      prompt: 'Start.',
      cwd: root,
    });
    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'reopener',
      note: 'paused',
    });
    expect(closed.teammate).toMatchObject({ status: 'closed', close_note: 'paused' });

    // send must NOT throw on a closed teammate: it clears the closed markers,
    // restarts the runtime from the persisted checkpoint, and submits.
    const sent = await service.send({
      dispatcherId: 'flow',
      name: 'reopener',
      prompt: 'Pick up where you left off.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(sent.teammate).toMatchObject({
      name: 'reopener',
      status: 'running',
      closed_at: null,
      close_note: null,
    });
    // A second runtime was launched and it resumed from checkpoint (not a fresh
    // start) — that is what proves send revived the prior session.
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);
  });

  it('fails loud when spawned with an agentRuntime that matches no agent', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'ghost',
        agentRuntime: 'no-such-agent',
        prompt: 'go',
        cwd: root,
      }),
    ).rejects.toThrow(/'no-such-agent', which matches no agents\[\]\.id/);
  });

  it('requires cwd for native teammate spawn', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'no-cwd',
        prompt: 'go',
      } as Parameters<TeamMateAgentService['spawn']>[0]),
    ).rejects.toThrow(/cwd/);
  });

  it('reads old identities without owner as dispatcher-owned until mutated', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const dir = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'identities',
    );
    const path = join(dir, 'oldie.json');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'oldie',
        agent_runtime: 'flow',
        cwd: root,
        created_at: 1,
        updated_at: 1,
        status: 'stopped',
        checkpoint: null,
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
      { mode: 0o600 },
    );

    expect((await service.status('flow', 'oldie')).owner).toEqual({
      kind: 'dispatcher',
      dispatcher_id: 'flow',
    });
    const history = await service.history({ dispatcherId: 'flow', name: 'oldie' });
    expect(history.items[0]).toMatchObject({
      name: 'oldie',
      source_cwd: root,
      runtime_cwd: root,
      worktree: { mode: 'reuse-cwd', cleanup_state: 'not-managed' },
      intent: null,
    });
    expect(await readFile(path, 'utf8')).not.toContain('"owner"');
  });

  it('prepares managed worktrees, persists metadata, and deletes clean worktrees on close', async () => {
    const repo = await initGitRepo(join(root, 'repo'));
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'managed',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'managed',
        branch: 'dreamux/managed',
        cleanup: 'delete-on-close',
      },
    });

    expect(spawned.teammate.source_cwd).toBe(repo);
    expect(spawned.teammate.source_repo).toBe(repo);
    expect(spawned.teammate.worktree).toMatchObject({
      mode: 'managed',
      slug: 'managed',
      branch: 'dreamux/managed',
      base_ref: 'HEAD',
      cleanup: 'delete-on-close',
      cleanup_state: 'managed-active',
    });
    expect(provider.contexts[0]?.cwd).toBe(spawned.teammate.worktree.path);
    expect(existsSync(spawned.teammate.worktree.path)).toBe(true);

    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'managed',
      note: 'done',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe('deleted');
    expect(existsSync(spawned.teammate.worktree.path)).toBe(false);
  });

  it('reports the git-canonical source_repo when cwd reaches the repo through a symlink', async () => {
    // macOS regression guard: tmpdir() lives behind a /var -> /private/var
    // symlink, so `git rev-parse --show-toplevel` reports the symlink-resolved
    // repo root. Reproduce that shape on any OS with an explicit symlink:
    // source_repo is the canonical root while source_cwd keeps the
    // caller-supplied path.
    const repo = await initGitRepo(join(root, 'real-repo'));
    const linked = join(root, 'linked-repo');
    await symlink(repo, linked);
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'symlinked',
      prompt: 'go',
      cwd: linked,
    });

    expect(spawned.teammate.source_cwd).toBe(linked);
    expect(spawned.teammate.source_repo).toBe(repo);
  });

  it('recreates a deleted managed worktree when send reopens a closed teammate', async () => {
    const repo = await initGitRepo(join(root, 'reopen-repo'));
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'reopen-managed',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'reopen-managed',
        branch: 'dreamux/reopen-managed',
        cleanup: 'delete-on-close',
      },
    });
    const worktreePath = spawned.teammate.worktree.path;
    await service.close({
      dispatcherId: 'flow',
      name: 'reopen-managed',
    });
    expect(existsSync(worktreePath)).toBe(false);

    const sent = await service.send({
      dispatcherId: 'flow',
      name: 'reopen-managed',
      prompt: 'continue',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(sent.teammate.worktree).toMatchObject({
      mode: 'managed',
      path: worktreePath,
      cleanup_state: 'managed-active',
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);
    expect(provider.contexts[1]?.cwd).toBe(worktreePath);
  });

  it('marks intentionally retained managed worktrees as kept on close', async () => {
    const repo = await initGitRepo(join(root, 'kept-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'keeper',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'keeper',
        branch: 'dreamux/keeper',
        cleanup: 'keep',
      },
    });

    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'keeper',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe('kept');
    expect(existsSync(spawned.teammate.worktree.path)).toBe(true);
  });

  it('retains dirty managed worktrees on close', async () => {
    const repo = await initGitRepo(join(root, 'dirty-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'dirty',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'dirty',
        branch: 'dreamux/dirty',
        cleanup: 'delete-on-close',
      },
    });
    await writeFile(join(spawned.teammate.worktree.path, 'dirty.txt'), 'dirty');

    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'dirty',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe('retained-dirty');
    expect(existsSync(spawned.teammate.worktree.path)).toBe(true);
  });

  it('retains clean detached managed worktrees with unique commits', async () => {
    const repo = await initGitRepo(join(root, 'detached-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'detached',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'detached',
        branch: 'dreamux/detached',
        cleanup: 'delete-on-close',
      },
    });
    const worktreePath = spawned.teammate.worktree.path;
    await execa('git', ['switch', '--detach'], { cwd: worktreePath });
    await writeFile(join(worktreePath, 'detached.txt'), 'detached\n');
    await execa('git', ['add', 'detached.txt'], { cwd: worktreePath });
    await execa('git', ['commit', '-m', 'Detached work'], { cwd: worktreePath });

    const closed = await service.close({
      dispatcherId: 'flow',
      name: 'detached',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe(
      'retained-unique-commits',
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('rejects a managed path that exists for a different source repository', async () => {
    const firstRepo = await initGitRepo(join(root, 'slug-a'));
    const secondRepo = await initGitRepo(join(root, 'slug-b'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'first-slug',
      prompt: 'go',
      cwd: firstRepo,
      worktree: {
        mode: 'managed',
        slug: 'shared-slug',
        branch: 'dreamux/shared-slug',
        cleanup: 'keep',
      },
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'second-slug',
        prompt: 'go',
        cwd: secondRepo,
        worktree: {
          mode: 'managed',
          slug: 'shared-slug',
          branch: 'dreamux/shared-slug',
          cleanup: 'keep',
        },
      }),
    ).rejects.toThrow(/not registered for source repo|already owned/);
  });

  it('rejects two teammate identities using the same explicit managed slug', async () => {
    const repo = await initGitRepo(join(root, 'same-slug-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'slug-one',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'same-slug',
        branch: 'dreamux/same-slug',
        cleanup: 'keep',
      },
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'slug-two',
        prompt: 'go',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'same-slug',
          branch: 'dreamux/same-slug',
          cleanup: 'keep',
        },
      }),
    ).rejects.toThrow(/already owned by TeamMate "slug-one"/);
  });

  it('fails loud on a legacy provider_ref teammate identity (pre-#148)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    // Seed a pre-#148 identity record carrying the removed provider_ref field
    // instead of agent_runtime. Any lifecycle verb that reads it must fail loud
    // with rebuild guidance rather than silently defaulting a runtime.
    const dir = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'identities',
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'legacy',
        provider_ref: 'builtin:codex',
        cwd: root,
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
    await expect(
      service.send({ dispatcherId: 'flow', name: 'legacy', prompt: 'go' }),
    ).rejects.toThrow(/legacy provider_ref format/);
  });

  it('does not wire the settle hook when no completion sink is configured', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await service.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      prompt: 'Start.',
      cwd: root,
    });
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(false);
  });

  it('delivers a settled teammate turn upward as a completion envelope', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const received: Array<{ id: string; name: string; env: CompletionEnvelope }> = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (id, identity, env) => {
        received.push({ id, name: identity.name, env });
      },
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Review.',
      cwd: root,
    });
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(true);

    provider.runtimes[0]?.settle('completed', 'turn-1');
    await flush();

    expect(received).toEqual([
      {
        id: 'flow',
        name: 'reviewer',
        env: {
          source: 'reviewer',
          id: 'reviewer:turn-1',
          status: 'completed',
          result: 'last fake result',
        },
      },
    ]);
  });

  it('delivers terminal failure/stop settlements with their own status', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'breaker',
      prompt: 'Run.',
      cwd: root,
    });

    provider.runtimes[0]?.settle('failed', 'turn-7');
    provider.runtimes[0]?.settle('stopped', 'turn-8');
    await flush();

    expect(received).toEqual([
      {
        source: 'breaker',
        id: 'breaker:turn-7',
        status: 'failed',
        result: 'last fake result',
      },
      {
        source: 'breaker',
        id: 'breaker:turn-8',
        status: 'stopped',
        result: 'last fake result',
      },
    ]);
  });

  it('drops null-turn settlements rather than fabricating a completion id', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'breaker',
      prompt: 'Run.',
      cwd: root,
    });

    provider.runtimes[0]?.settle('stopped', null);
    await flush();

    expect(received).toEqual([]);
  });

  it('delivers concurrent teammate completions without dropping any', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'one',
      prompt: 'A.',
      cwd: root,
    });
    await service.spawn({
      dispatcherId: 'flow',
      name: 'two',
      prompt: 'B.',
      cwd: root,
    });

    provider.runtimes[0]?.settle('completed', 'turn-1');
    provider.runtimes[1]?.settle('completed', 'turn-1');
    await flush();

    expect(received.map((env) => env.source).sort()).toEqual(['one', 'two']);
    expect(received).toHaveLength(2);
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

/** Drain the microtask/macrotask the void-ed settle handler runs on. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function initGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dreamux Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dreamux-test@example.com'], {
    cwd: path,
  });
  await writeFile(join(path, 'README.md'), 'test\n');
  await execa('git', ['add', 'README.md'], { cwd: path });
  await execa('git', ['commit', '-m', 'Initial test commit'], { cwd: path });
  return path;
}
