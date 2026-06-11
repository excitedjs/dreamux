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
import {
  dispatcherCompletionSpillDir,
  dispatcherTeamMateIdentitiesDir,
  dispatcherTeamMateIdentityPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
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
  /** Overridable last-assistant text so tests can drive capture/truncation. */
  lastText = 'last fake result';

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
    return { text: this.lastText };
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

/**
 * The dispatcher workspace cwd for the current test (issue #182 PR-4); set in
 * beforeEach to a non-`~/.dreamux` directory so managed worktrees land under
 * `<workspace>/.workspace/worktree/...`. reuse-cwd tests ignore it.
 */
let dispatcherCwd: string;

function buildService(provider: AgentRuntimeProvider): TeamMateAgentService {
  const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
    dispatcherCwd = join(root, 'workspace');
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
      intent: 'work',
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
      intent: 'work',
      prompt: 'go',
      cwd: root,
    });
    expect(codexProvider.contexts).toHaveLength(1);
    expect(codexProvider.contexts[0]?.dispatcher).not.toBeNull();
    expect(codexProvider.contexts[0]?.dispatcher?.runtime.provider).toBe(
      'builtin:codex',
    );

    // Issue #182 PR-2: a teammate runtime spills under its OPERATOR dispatcher
    // id ('flow'), NOT its composite runtime id — for both runtime kinds. The
    // launcher resolves completionSpillDir to the operator cache regardless of
    // the id argument, and the spill dir must not carry the teammate-name
    // segment that the runtime dir (dispatcherDir) does.
    const operatorSpill = dispatcherCompletionSpillDir('flow');
    for (const { captured, name } of [
      { captured: claudeProvider.contexts[0], name: 'claude-mate' },
      { captured: codexProvider.contexts[0], name: 'codex-mate' },
    ]) {
      const paths = captured?.paths;
      expect(paths).toBeDefined();
      expect(paths!.completionSpillDir('ignored-arg')).toBe(operatorSpill);
      // The runtime dir is keyed by the teammate name; the spill dir is not.
      expect(paths!.dispatcherDir('ignored-arg')).toContain(name);
      expect(paths!.completionSpillDir('ignored-arg')).not.toContain(name);
    }
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
      intent: 'work',
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
      intent: 'work',
      agentRuntime: spawnableId,
      prompt: 'go',
      cwd: root,
    });
    expect(provider.contexts[0]?.dispatcher?.agentRuntime).toBe('codex-yolo');
  });

  it('spawns a named resumable teammate and records raw history events', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
      intent: 'work',
      prompt: 'Review the change.',
      cwd: root,
    });
    expect(spawned.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    // #188: spawn allocates a concrete name and returns it; the requested label
    // is kept as display_name. All later calls use the returned concrete name.
    const reviewer = spawned.teammate.name;
    expect(reviewer).toMatch(/^reviewer-[a-z0-9]{8}$/);
    expect(spawned.teammate).toMatchObject({
      display_name: 'reviewer',
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
      name: reviewer,
      prompt: 'Check tests too.',
    });
    const sent = await service.send({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Continue from prior context.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-3' });
    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0]?.submitted).toHaveLength(3);

    // #182 PR-8: the write-only per-name history index was removed; the durable
    // session ledger is the single recovery record. It captures the spawn + each
    // send (no synthetic 'state' rows), in append order, with prompt previews.
    const events = (await service.sessions().read('flow')).filter(
      (event) => event.name === reviewer,
    );
    expect(events.map((event) => event.type)).toEqual(['spawn', 'send', 'send']);
    expect(events.map((event) => event.prompt_preview)).toEqual([
      'Review the change.',
      'Check tests too.',
      'Continue from prior context.',
    ]);
  });

  it('resumes persisted identity through the same provider contract', async () => {
    const { provider } = providerCatalog();
    const first = buildService(provider);
    const builder = (
      await first.spawn({
        dispatcherId: 'flow',
        name: 'builder',
        intent: 'work',
        prompt: 'Build once.',
        cwd: root,
      })
    ).teammate.name;
    await first.stopAll();

    const second = buildService(provider);
    const sent = await second.send({
      dispatcherId: 'flow',
      name: builder,
      prompt: 'Resume and continue.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);

    // #188: last is a durable ledger read keyed by the concrete name. Resolved
    // to the identity's session, it returns a well-formed result; with no
    // completion sink wired here, no settled turn was captured.
    const last = await second.last('flow', builder);
    expect(last.teammate.name).toBe(builder);
    expect(last.requested_turns).toBe(1);
    expect(last.session_id).not.toBeNull();
    expect(last.turns).toEqual([]);
  });

  it('returns a bounded session ledger with worktree metadata and filters', async () => {
    const repo = await initGitRepo(join(root, 'ledger-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const alpha = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'alpha',
        prompt: 'Review alpha.',
        cwd: root,
        intent: 'review alpha',
      })
    ).teammate.name;
    const managedName = (
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
      })
    ).teammate.name;
    await service.close({ dispatcherId: 'flow', name: alpha, note: 'done' });

    const firstPage = await service.history({ dispatcherId: 'flow', limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).not.toBeNull();

    const all = await service.history({ dispatcherId: 'flow' });
    // Rows carry the concrete name plus the requested display_name (#188).
    expect(all.items.map((item) => item.display_name).sort()).toEqual([
      'alpha',
      'managed-ledger',
    ]);
    expect(all.items.map((item) => item.name).sort()).toEqual(
      [alpha, managedName].sort(),
    );
    const managed = all.items.find((item) => item.name === managedName);
    expect(managed).toMatchObject({
      id: managedName,
      display_name: 'managed-ledger',
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
      resume: { tool: 'send', name: managedName },
    });

    const closed = await service.history({
      dispatcherId: 'flow',
      closeStatus: 'closed',
    });
    expect(closed.items.map((item) => item.name)).toEqual([alpha]);
    expect(closed.items[0]).toMatchObject({
      display_name: 'alpha',
      close_note_preview: 'done',
      last_prompt_preview: 'Review alpha.',
    });

    const grep = await service.history({ dispatcherId: 'flow', grep: 'managed work' });
    expect(grep.items.map((item) => item.name)).toEqual([managedName]);

    const second = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const afterRestart = await second.history({
      dispatcherId: 'flow',
      name: managedName,
    });
    expect(afterRestart.items).toHaveLength(1);
    expect(afterRestart.items[0]?.worktree.mode).toBe('managed');
  });

  it('closes a live teammate without deleting its history', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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

    const closer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'closer',
        intent: 'work',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    const closed = await service.close({
      dispatcherId: 'flow',
      name: closer,
      note: 'done',
    });
    expect(closed.teammate).toMatchObject({
      name: closer,
      display_name: 'closer',
      status: 'closed',
      close_note: 'done',
    });
    // #188: last is a pure durable-ledger read — it does NOT reopen a runtime, so
    // it works on a CLOSED teammate (this is the failed-completion fallback). It
    // returns the closed status and an empty turn list (no settled turn captured
    // here, since no completion sink is wired). status likewise does not reopen.
    expect(provider.runtimes).toHaveLength(1);
    const closerLast = await service.last('flow', closer);
    expect(closerLast.teammate.status).toBe('closed');
    expect(closerLast.turns).toEqual([]);
    expect((await service.status('flow', closer)).status).toBe('closed');
    expect(provider.runtimes).toHaveLength(1); // no new runtime started

    // #182 PR-8: closing retains the durable session ledger (spawn + close),
    // the single recovery record now that the per-name history index is gone.
    const events = (await service.sessions().read('flow')).filter(
      (event) => event.name === closer,
    );
    expect(events.map((event) => event.type)).toEqual(['spawn', 'close']);
  });

  it('send reopens a closed teammate from its checkpoint (issue #155)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const reopener = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reopener',
        intent: 'work',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    const closed = await service.close({
      dispatcherId: 'flow',
      name: reopener,
      note: 'paused',
    });
    expect(closed.teammate).toMatchObject({ status: 'closed', close_note: 'paused' });

    // send must NOT throw on a closed teammate: it clears the closed markers,
    // restarts the runtime from the persisted checkpoint, and submits.
    const sent = await service.send({
      dispatcherId: 'flow',
      name: reopener,
      prompt: 'Pick up where you left off.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(sent.teammate).toMatchObject({
      name: reopener,
      status: 'running',
      closed_at: null,
      close_note: null,
    });
    // A second runtime was launched and it resumed from checkpoint (not a fresh
    // start) — that is what proves send revived the prior session.
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);
  });

  it('send updates the recorded intent when supplied, and leaves it unchanged otherwise (#182 PR-3)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const shifter = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'shifter',
        intent: 'first task',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    expect((await service.status('flow', shifter)).intent).toBe('first task');

    // send WITH intent updates the durable recovery subject.
    const moved = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      intent: 'second task',
      prompt: 'Now do the second thing.',
    });
    expect(moved.teammate.intent).toBe('second task');
    expect((await service.status('flow', shifter)).intent).toBe('second task');

    // send WITHOUT intent leaves the recorded intent unchanged.
    const kept = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      prompt: 'Keep going.',
    });
    expect(kept.teammate.intent).toBe('second task');

    // send with an EMPTY intent must NOT wipe the recorded subject (#182 PR-3).
    const emptied = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      intent: '',
      prompt: 'Still going.',
    });
    expect(emptied.teammate.intent).toBe('second task');
  });

  it('rejects direct service spawn/close with missing or empty intent/note (#182 PR-3 P1)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    // spawn.intent required at the service boundary (in-process bypass of the
    // MCP shim / admin layer). Empty and missing both rejected.
    await expect(
      service.spawn({ dispatcherId: 'flow', name: 'a', intent: '', prompt: 'go', cwd: root }),
    ).rejects.toThrow(/TeamMate spawn intent must be a non-empty string/);
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'a',
        prompt: 'go',
        cwd: root,
      } as unknown as Parameters<TeamMateAgentService['spawn']>[0]),
    ).rejects.toThrow(/TeamMate spawn intent must be a non-empty string/);

    // close.note required at the service boundary — checked after the teammate
    // is found, so spawn a real one first.
    const closeme = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'closeme',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    await expect(
      service.close({ dispatcherId: 'flow', name: closeme, note: '' }),
    ).rejects.toThrow(/TeamMate close note must be a non-empty string/);
  });

  it('fails loud when spawned with an agentRuntime that matches no agent', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
        intent: 'work',
        agentRuntime: 'no-such-agent',
        prompt: 'go',
        cwd: root,
      }),
    ).rejects.toThrow(/'no-such-agent', which matches no agents\[\]\.id/);
  });

  it('requires cwd for native teammate spawn', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
        intent: 'work',
        prompt: 'go',
      } as Parameters<TeamMateAgentService['spawn']>[0]),
    ).rejects.toThrow(/cwd/);
  });

  it('reads old identities without owner as dispatcher-owned until mutated', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
      // #188: a pre-#188 record has no display name or session id; both read as
      // null and the record stays usable without migration.
      display_name: null,
      session_id: null,
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
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'managed',
      intent: 'work',
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
      name: spawned.teammate.name,
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
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'symlinked',
      intent: 'work',
      prompt: 'go',
      cwd: linked,
    });

    expect(spawned.teammate.source_cwd).toBe(linked);
    expect(spawned.teammate.source_repo).toBe(repo);
  });

  it('recreates a deleted managed worktree when send reopens a closed teammate', async () => {
    const repo = await initGitRepo(join(root, 'reopen-repo'));
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'reopen-managed',
      intent: 'work',
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
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(existsSync(worktreePath)).toBe(false);

    const sent = await service.send({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
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
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'keeper',
      intent: 'work',
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
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe('kept');
    expect(existsSync(spawned.teammate.worktree.path)).toBe(true);
  });

  it('retains dirty managed worktrees on close', async () => {
    const repo = await initGitRepo(join(root, 'dirty-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'dirty',
      intent: 'work',
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
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe('retained-dirty');
    expect(existsSync(spawned.teammate.worktree.path)).toBe(true);
  });

  it('retains clean detached managed worktrees with unique commits', async () => {
    const repo = await initGitRepo(join(root, 'detached-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'detached',
      intent: 'work',
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
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.worktree.cleanup_state).toBe(
      'retained-unique-commits',
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('disambiguates the same managed slug across different source repos (#182 PR-4)', async () => {
    // Repo-disambiguation: two different source repos that share an inner slug
    // must map to DISTINCT managed worktrees (under distinct repo-slug dirs),
    // not collide at one path. This is the cross-repo uniqueness contract.
    const firstRepo = await initGitRepo(join(root, 'slug-a'));
    const secondRepo = await initGitRepo(join(root, 'slug-b'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const first = await service.spawn({
      dispatcherId: 'flow',
      name: 'first-slug',
      intent: 'work',
      prompt: 'go',
      cwd: firstRepo,
      worktree: {
        mode: 'managed',
        slug: 'shared-slug',
        branch: 'dreamux/shared-slug',
        cleanup: 'keep',
      },
    });
    const second = await service.spawn({
      dispatcherId: 'flow',
      name: 'second-slug',
      intent: 'work',
      prompt: 'go',
      cwd: secondRepo,
      worktree: {
        mode: 'managed',
        slug: 'shared-slug',
        branch: 'dreamux/shared-slug',
        cleanup: 'keep',
      },
    });

    const firstPath = first.teammate.worktree.path;
    const secondPath = second.teammate.worktree.path;
    expect(firstPath).not.toBe(secondPath);
    // Both live under the dispatcher workspace boundary, never under ~/.dreamux.
    const boundary = join(dispatcherCwd, '.workspace', 'worktree');
    expect(firstPath.startsWith(boundary)).toBe(true);
    expect(secondPath.startsWith(boundary)).toBe(true);
    // Same inner slug, different repo-disambiguated parent dir.
    expect(join(firstPath, '..')).not.toBe(join(secondPath, '..'));
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
  });

  it('self-ignores the .workspace boundary so managed worktrees are not repo content (#182 PR-4)', async () => {
    const repo = await initGitRepo(join(root, 'boundary-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'boundary',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'boundary',
        branch: 'dreamux/boundary',
        cleanup: 'keep',
      },
    });

    const gitignore = join(dispatcherCwd, '.workspace', '.gitignore');
    expect(existsSync(gitignore)).toBe(true);
    expect((await readFile(gitignore, 'utf8')).split('\n')).toContain('*');
  });

  it('repairs an existing unsafe .workspace/.gitignore (#182 PR-4, PR#186 P2)', async () => {
    const repo = await initGitRepo(join(root, 'unsafe-boundary-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    // Seed an existing boundary file that does NOT safely ignore everything: it
    // un-ignores worktree content via a negation and has no bare `*`.
    const boundaryDir = join(dispatcherCwd, '.workspace');
    await mkdir(boundaryDir, { recursive: true });
    const gitignore = join(boundaryDir, '.gitignore');
    await writeFile(gitignore, '# keep some stuff\n!leaked\n', 'utf8');

    await service.spawn({
      dispatcherId: 'flow',
      name: 'unsafe-boundary',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'unsafe-boundary',
        branch: 'dreamux/unsafe-boundary',
        cleanup: 'keep',
      },
    });

    // The unsafe file must have been repaired to the canonical ignore-all form.
    const lines = (await readFile(gitignore, 'utf8'))
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('*');
    expect(lines.some((line) => line.startsWith('!'))).toBe(false);
  });

  it('rejects a managed worktree under a workspace that symlinks into Dreamux home (#182 PR-4, PR#186 P1)', async () => {
    const repo = await initGitRepo(join(root, 'symlink-repo'));
    // A directory physically inside Dreamux home, reached via a workspace path
    // that is OUTSIDE Dreamux home lexically but symlinks into it.
    const targetUnderDreamux = join(root, 'home', '.dreamux', 'state', 'sneaky');
    await mkdir(targetUnderDreamux, { recursive: true });
    const symlinkedWorkspace = join(root, 'outside-link');
    await symlink(targetUnderDreamux, symlinkedWorkspace);

    const config = testDreamuxConfig([
      testDispatcherConfig({ cwd: symlinkedWorkspace }),
    ]);
    const { catalog } = providerCatalog();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'sneaky',
        intent: 'work',
        prompt: 'go',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'sneaky',
          branch: 'dreamux/sneaky',
          cleanup: 'keep',
        },
      }),
    ).rejects.toThrow(/must not be created under the Dreamux home/);

    // And no managed worktree was physically created under Dreamux home.
    expect(existsSync(join(targetUnderDreamux, '.workspace', 'worktree'))).toBe(
      false,
    );
  });

  it('rejects two teammate identities using the same explicit managed slug', async () => {
    const repo = await initGitRepo(join(root, 'same-slug-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'slug-one',
      intent: 'work',
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
        intent: 'work',
        prompt: 'go',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'same-slug',
          branch: 'dreamux/same-slug',
          cleanup: 'keep',
        },
      }),
      // The owner is reported by its concrete name (#188: `slug-one-<suffix>`).
    ).rejects.toThrow(/already owned by TeamMate "slug-one-/);
  });

  it('fails loud on a legacy provider_ref teammate identity (pre-#148)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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

  it('reads a legacy under-state managed worktree path verbatim (#182 PR-4)', async () => {
    // A teammate identity persisted before the worktree relocation carries a
    // managed worktree.path under `~/.dreamux/state/.../worktrees/`. The reader
    // must surface that legacy path UNCHANGED — never rewrite it to the new
    // `.workspace/worktree/...` layout and never delete the old location.
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const legacyWorktreePath = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'worktrees',
      'legacy-mate',
    );
    await mkdir(dispatcherTeamMateIdentitiesDir('flow'), { recursive: true });
    await writeFile(
      dispatcherTeamMateIdentityPath('flow', 'legacy-mate'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'legacy-mate',
        owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
        role: 'teammate',
        team_id: null,
        agent_runtime: 'flow',
        source_cwd: root,
        source_repo: root,
        cwd: legacyWorktreePath,
        runtime_cwd: legacyWorktreePath,
        worktree: {
          mode: 'managed',
          slug: 'legacy-mate',
          path: legacyWorktreePath,
          branch: 'dreamux/legacy-mate',
          base_ref: 'HEAD',
          cleanup: 'keep',
          cleanup_state: 'managed-active',
          cleanup_error: null,
        },
        intent: 'legacy work',
        created_at: 1,
        updated_at: 1,
        status: 'closed',
        checkpoint: null,
        last_error: null,
        closed_at: 2,
        close_note: 'archived',
      }),
      { mode: 0o600 },
    );

    const status = await service.status('flow', 'legacy-mate');
    expect(status.worktree.mode).toBe('managed');
    expect(status.worktree.path).toBe(legacyWorktreePath);
    expect(status.runtime_cwd).toBe(legacyWorktreePath);
  });

  it('does not wire the settle hook when no completion sink is configured', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await service.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      intent: 'work',
      prompt: 'Start.',
      cwd: root,
    });
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(false);
  });

  it('delivers a settled teammate turn upward as a completion envelope', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'Review.',
        cwd: root,
      })
    ).teammate.name;
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(true);

    provider.runtimes[0]?.settle('completed', 'turn-1');
    await flush();

    // The completion envelope keys on the concrete name (#188).
    expect(received).toEqual([
      {
        id: 'flow',
        name: reviewer,
        env: {
          source: reviewer,
          id: `${reviewer}:turn-1`,
          status: 'completed',
          result: 'last fake result',
        },
      },
    ]);
  });

  it('delivers terminal failure/stop settlements with their own status', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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

    const breaker = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'breaker',
        intent: 'work',
        prompt: 'Run.',
        cwd: root,
      })
    ).teammate.name;

    provider.runtimes[0]?.settle('failed', 'turn-7');
    provider.runtimes[0]?.settle('stopped', 'turn-8');
    await flush();

    expect(received).toEqual([
      {
        source: breaker,
        id: `${breaker}:turn-7`,
        status: 'failed',
        result: 'last fake result',
      },
      {
        source: breaker,
        id: `${breaker}:turn-8`,
        status: 'stopped',
        result: 'last fake result',
      },
    ]);
  });

  it('drops null-turn settlements rather than fabricating a completion id', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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
      intent: 'work',
      prompt: 'Run.',
      cwd: root,
    });

    provider.runtimes[0]?.settle('stopped', null);
    await flush();

    expect(received).toEqual([]);
  });

  it('delivers concurrent teammate completions without dropping any', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
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

    const one = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'one',
        intent: 'work',
        prompt: 'A.',
        cwd: root,
      })
    ).teammate.name;
    const two = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'two',
        intent: 'work',
        prompt: 'B.',
        cwd: root,
      })
    ).teammate.name;

    provider.runtimes[0]?.settle('completed', 'turn-1');
    provider.runtimes[1]?.settle('completed', 'turn-1');
    await flush();

    expect(received.map((env) => env.source).sort()).toEqual([one, two].sort());
    expect(received).toHaveLength(2);
  });

  it('last(turns): defaults to 1, accepts 1..5, and rejects out-of-range/non-integer (#188)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const name = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'turns',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;

    expect((await service.last('flow', name)).requested_turns).toBe(1);
    expect((await service.last('flow', name, 5)).requested_turns).toBe(5);
    await expect(service.last('flow', name, 0)).rejects.toThrow(/1\.\.5/);
    await expect(service.last('flow', name, 6)).rejects.toThrow(/1\.\.5/);
    await expect(service.last('flow', name, 1.5)).rejects.toThrow(/1\.\.5/);
  });

  it('last reads settled turns from the durable ledger, filtered by session, with truncation metadata (#188)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      // A completion sink wires the settle hook so settled turns are captured.
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'first',
        cwd: root,
      })
    ).teammate.name;

    // Settle three turns with distinct assistant outputs; the third exceeds the
    // 160k hard cap so it must come back flagged truncated.
    const runtime = provider.runtimes[0]!;
    runtime.lastText = 'answer one';
    runtime.settle('completed', 'turn-1');
    await waitForSettled(service, 1);
    await service.send({ dispatcherId: 'flow', name: reviewer, prompt: 'second' });
    runtime.lastText = 'answer two';
    runtime.settle('completed', 'turn-2');
    await waitForSettled(service, 2);
    await service.send({ dispatcherId: 'flow', name: reviewer, prompt: 'third' });
    const huge = 'z'.repeat(170_000);
    runtime.lastText = huge;
    runtime.settle('completed', 'turn-3');
    await waitForSettled(service, 3);

    // Default returns just the newest settled turn (truncated to the hard cap).
    const latest = await service.last('flow', reviewer);
    expect(latest.requested_turns).toBe(1);
    expect(latest.returned_turns).toBe(1);
    expect(latest.session_id).not.toBeNull();
    const newest = latest.turns.at(-1)!;
    expect(newest.turn_id).toBe('turn-3');
    expect(newest.assistant_truncated).toBe(true);
    expect(newest.assistant).toHaveLength(160_000);

    // turns:5 returns all three in append order, oldest first; older turns are
    // captured whole.
    const all = await service.last('flow', reviewer, 5);
    expect(all.returned_turns).toBe(3);
    expect(all.turns.map((turn) => turn.turn_id)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    expect(all.turns[0]).toMatchObject({
      assistant: 'answer one',
      assistant_truncated: false,
    });
  });

  it('last(turns) evicts older turns beyond the window, keeping the most recent by start order (#188 bounded fold)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const name = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'evict',
        intent: 'work',
        prompt: 'first',
        cwd: root,
      })
    ).teammate.name;
    const runtime = provider.runtimes[0]!;
    // Settle FOUR turns in one session so last(turns=2) must drive the bounded
    // fold's eviction path (recent.size > requestedTurns) more than once.
    runtime.lastText = 'a1';
    runtime.settle('completed', 'turn-1');
    await waitForSettled(service, 1);
    for (const [turnId, text, prompt] of [
      ['turn-2', 'a2', 'second'],
      ['turn-3', 'a3', 'third'],
      ['turn-4', 'a4', 'fourth'],
    ] as const) {
      await service.send({ dispatcherId: 'flow', name, prompt });
      runtime.lastText = text;
      runtime.settle('completed', turnId);
      await waitForSettled(service, Number(turnId.slice('turn-'.length)));
    }

    // Only the two most-recent-by-start turns survive, in append order.
    const last = await service.last('flow', name, 2);
    expect(last.requested_turns).toBe(2);
    expect(last.returned_turns).toBe(2);
    expect(last.turns.map((turn) => turn.turn_id)).toEqual(['turn-3', 'turn-4']);
    expect(last.turns.map((turn) => turn.assistant)).toEqual(['a3', 'a4']);
    // Default (turns=1) keeps only the newest.
    const latest = await service.last('flow', name);
    expect(latest.turns.map((turn) => turn.turn_id)).toEqual(['turn-4']);
  });

  it('last works on a closed teammate without starting a runtime (#188)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    provider.runtimes[0]!.lastText = 'the captured answer';
    provider.runtimes[0]!.settle('completed', 'turn-1');
    await waitForSettled(service, 1);
    await service.close({ dispatcherId: 'flow', name: reviewer, note: 'done' });

    const runtimesBefore = provider.runtimes.length;
    const last = await service.last('flow', reviewer);
    // No new runtime was launched to serve the read.
    expect(provider.runtimes).toHaveLength(runtimesBefore);
    expect(last.teammate.status).toBe('closed');
    expect(last.turns.at(-1)).toMatchObject({
      turn_id: 'turn-1',
      assistant: 'the captured answer',
      settle_status: 'completed',
    });
  });

  it('concrete names are never reused, even after close (#188)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const first = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'dup',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    await service.close({ dispatcherId: 'flow', name: first, note: 'done' });
    // Re-spawning the same requested label allocates a DISTINCT concrete name —
    // the closed identity's name is never handed out again.
    const second = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'dup',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    expect(second).not.toBe(first);
    expect(first).toMatch(/^dup-[a-z0-9]{8}$/);
    expect(second).toMatch(/^dup-[a-z0-9]{8}$/);
    // Both identities persist; the closed one is still addressable by its name.
    const names = (await service.history({ dispatcherId: 'flow' })).items.map((i) => i.name);
    expect(names).toContain(first);
    expect(names).toContain(second);
  });

  it('createTeamLeader fails loud on a reused concrete name, even after close (#188 P1)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const leaderInput = {
      dispatcherId: 'flow',
      teamId: 'alpha',
      name: 'tl-alpha-fixedaaa',
      displayName: 'alpha-leader',
      prompt: 'lead',
      agentRuntime: 'flow',
      sourceCwd: root,
      sourceRepo: null,
      runtimeCwd: root,
      worktree: {
        mode: 'reuse-cwd' as const,
        slug: null,
        path: root,
        branch: null,
        base_ref: null,
        cleanup: 'keep' as const,
        cleanup_state: 'not-managed' as const,
        cleanup_error: null,
      },
      intent: 'work',
    };
    await service.createTeamLeader(leaderInput);
    // The public service seam must not rebind a concrete name to a new session —
    // not even for a CLOSED leader. #188: concrete names are never reused, and
    // the duplicate check includes closed identities.
    await service.close({ dispatcherId: 'flow', name: 'tl-alpha-fixedaaa', note: 'done' });
    await expect(service.createTeamLeader(leaderInput)).rejects.toThrow(
      /already exists/,
    );
  });
});

/** Poll the durable ledger until it has captured `count` settled turns. */
async function waitForSettled(
  service: TeamMateAgentService,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const events = await service.sessions().read('flow');
    if (events.filter((e) => e.type === 'settled').length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} settled events`);
}

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
