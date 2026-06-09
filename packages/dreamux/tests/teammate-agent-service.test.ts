import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    root = mkdtempSync(join(tmpdir(), 'dreamux-teammate-agent-'));
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

  it('spawns a named resumable teammate and records forward-only history', async () => {
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
      agent_runtime: 'flow',
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

    const history = await service.history('flow', 'reviewer');
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
    const received: Array<{ id: string; env: CompletionEnvelope }> = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (id, env) => {
        received.push({ id, env });
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
        env: {
          source: 'reviewer',
          id: 'reviewer:turn-1',
          status: 'completed',
          result: 'last fake result',
        },
      },
    ]);
  });

  it('delivers terminal failure/stop settlements with status failed', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig();
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, env) => {
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
        status: 'failed',
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
      onTeamMateCompletion: (_id, env) => {
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
      onTeamMateCompletion: (_id, env) => {
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
