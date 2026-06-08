import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  type AgentRuntimeTurnInput,
  type AgentRuntimeTurnResult,
} from '../src/agent-runtime/index.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDreamuxConfig } from './helpers/config.js';

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private resumed = false;
  private turns = 0;
  readonly submitted: AgentRuntimeTurnInput[] = [];

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

  async submitTurn(input: AgentRuntimeTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    this.turns += 1;
    return { status: 'submitted', turnId: `turn-${this.turns}` };
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
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref = 'builtin:codex';
  readonly runtimes: FakeRuntime[] = [];

  constructor(readonly descriptor: AgentRuntimeProvider['descriptor']) {}

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
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
      provider_ref: 'builtin:codex',
      status: 'running',
      checkpoint: { kind: 'codexThread', id: expect.stringContaining('thread') },
    });

    await service.send({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Check tests too.',
    });
    const resumed = await service.resume({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Continue from prior context.',
    });
    expect(resumed.turn).toEqual({ status: 'submitted', turn_id: 'turn-3' });
    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0]?.submitted).toHaveLength(3);

    const history = await service.history('flow', 'reviewer');
    expect(history.events.map((event) => event.type)).toEqual([
      'state',
      'spawn',
      'send',
      'resume',
      'send',
    ]);
    expect(history.events.map((event) => event.prompt_preview)).toEqual([
      null,
      'Review the change.',
      'Check tests too.',
      'Continue from prior context.',
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
    await expect(
      service.send({
        dispatcherId: 'flow',
        name: 'closer',
        prompt: 'Should fail.',
      }),
    ).rejects.toThrow(/closed/);

    const historyFile = await readFile(
      join(root, 'home', '.dreamux', 'state', 'flow', 'teammate', 'history', 'closer.jsonl'),
      'utf8',
    );
    expect(historyFile).toContain('"type":"spawn"');
    expect(historyFile).toContain('"type":"close"');
  });
});
