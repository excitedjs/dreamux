import { mkdtempSync, rmSync } from 'node:fs';
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
  type TeamMateCompletionDeliveryResult,
} from '../src/agent-runtime/index.js';
import type { InboundTurnInput, TurnSettledSignal } from '../src/agent-runtime/turn.js';
import { createFakeFeishuBot } from '../src/channel/feishu/bot.js';
import { DispatcherService } from '../src/dispatcher-service/service.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDreamuxConfig } from './helpers/config.js';

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
  readonly delivered: CompletionEnvelope[] = [];

  constructor(private readonly context: AgentRuntimeCreateContext) {}

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
    this.turns += 1;
    return { status: 'submitted', turnId: `turn-${this.turns}` };
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
    return { text: 'reviewer final answer' };
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

function buildFacade(
  provider: FakeProvider,
  adminSocketPath: string,
): DispatcherService {
  const config = testDreamuxConfig();
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dx-reverse-e2e-'));
    adminSocketPath = join(root, 'a.sock');
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

  it("settles a teammate turn and reaches the dispatcher runtime's completionInput", async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'reviewer',
      prompt: 'Review the change.',
      cwd: root,
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;

    // Self-delivery guard: only the teammate runtime carries the settle hook.
    expect(dispatcherRuntime.hasSettleHook()).toBe(false);
    expect(teammateRuntime.hasSettleHook()).toBe(true);

    teammateRuntime.settle('completed', 'turn-1');
    await flush();

    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: 'reviewer',
        id: 'reviewer:turn-1',
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
    await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'breaker',
      prompt: 'Run.',
      cwd: root,
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateRuntime = provider.runtimes[1]!;

    teammateRuntime.settle('failed', 'turn-3');
    teammateRuntime.settle('stopped', null);
    await flush();

    expect(dispatcherRuntime.delivered).toEqual([
      {
        source: 'breaker',
        id: 'breaker:turn-3',
        status: 'failed',
        result: 'reviewer final answer',
      },
      {
        source: 'breaker',
        id: 'breaker',
        status: 'failed',
        result: 'reviewer final answer',
      },
    ]);

    await facade.shutdown();
  });

  it('delivers two concurrent teammate completions without a busy-loop', async () => {
    const descriptor = createBuiltinProviderRegistry().resolve('builtin:codex');
    const provider = new FakeProvider(descriptor);
    const facade = buildFacade(provider, adminSocketPath);

    await facade.startDispatcher('flow');
    await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'one',
      prompt: 'A.',
      cwd: root,
    });
    await facade.spawnTeamMate({
      dispatcherId: 'flow',
      name: 'two',
      prompt: 'B.',
      cwd: root,
    });

    const dispatcherRuntime = provider.runtimes[0]!;
    const teammateOne = provider.runtimes[1]!;
    const teammateTwo = provider.runtimes[2]!;

    teammateOne.settle('completed', 'turn-1');
    teammateTwo.settle('completed', 'turn-1');
    await flush();

    // Both delivered exactly once each: accepted submit never retries.
    expect(dispatcherRuntime.delivered.map((env) => env.source).sort()).toEqual([
      'one',
      'two',
    ]);
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
