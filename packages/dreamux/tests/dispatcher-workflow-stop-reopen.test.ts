import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  ChannelProvider,
  ChannelSession,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { WorkflowStopInterruptedError } from '../src/service/workflow-service/run-terminal.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const RUNTIME_REF = 'test:runtime';
const CHANNEL_REF = 'test:channel';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = RUNTIME_REF;
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

  async waitIdle(): Promise<void> {}

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: `turn-${input.sourceId ?? 'x'}` };
  }

  async completionInput(
    input: AgentRuntimeTextInput,
  ): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: `text-${input.text.length}` };
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
    return { text: 'fake last' };
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
  contexts: AgentRuntimeCreateContext[],
): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(context: AgentRuntimeCreateContext) {
      contexts.push(context);
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== RUNTIME_REF) {
        throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as AgentRuntimeProviderCatalog;
}

function fakeChannelCatalog(): ChannelProviderCatalog {
  const provider: ChannelProvider = {
    ref: CHANNEL_REF,
    descriptor: {
      id: 'test-channel',
      kind: 'channel',
      ref: { source: 'builtin', id: 'test-channel', raw: CHANNEL_REF },
    },
    createSession(context) {
      return {
        provider: context.provider,
        channel_id: context.channel_id,
        async start() {},
        async close() {},
        async resolveTarget() {
          throw new Error('test session does not resolve targets');
        },
      } satisfies ChannelSession;
    },
    tools: () => [],
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== CHANNEL_REF) {
        throw new Error(`unexpected channel provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as ChannelProviderCatalog;
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

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dreamux-dispatcher-workflow-stop-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = join(home, 'home');
  process.env['DREAMUX_ROOT'] = join(home, 'dreamux');
  mkdirSync(process.env['HOME'], { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['DREAMUX_ROOT'];
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function startedDispatcher(input: {
  runtimes: FakeRuntime[];
}): Promise<DispatcherService> {
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = testDreamuxConfig([
    testDispatcherConfig({
      id: 'flow',
      cwd: workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      channelProvider: CHANNEL_REF,
    }),
  ]);
  const dispatcher = new DispatcherService({
    id: 'flow',
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: fakeRuntimeCatalog(input.runtimes, []),
    channelProviders: fakeChannelCatalog(),
    channelLoggerFactory: () => noopLog(),
    log: noopLog(),
  });
  await dispatcher.start();
  return dispatcher;
}

describe('dispatcher workflow stop after ordinary dispatcher stop', () => {
  it('returns the durable terminal status once the collection sweep succeeds and admission reopens', async () => {
    const runtimes: FakeRuntime[] = [];
    const dispatcher = await startedDispatcher({ runtimes });
    const accepted = await dispatcher.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    });
    // Wait until the workflow's agent call spawned its owned teammate.
    await vi.waitFor(async () => {
      expect((await dispatcher.teammates.list()).length).toBe(1);
    });

    await dispatcher.stop();
    // The per-run shutdown takeover record resolved with the successful
    // collection-wide sweep: the idempotent stop reads the durable record.
    await expect(dispatcher.workflows.stop({ run_id: accepted.run_id }))
      .resolves.toEqual({ run_id: accepted.run_id, status: 'stopped' });
  });

  it('keeps the takeover rejection loud when the collection sweep fails', async () => {
    const runtimes: FakeRuntime[] = [];
    const dispatcher = await startedDispatcher({ runtimes });
    const accepted = await dispatcher.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    });
    await vi.waitFor(async () => {
      expect((await dispatcher.teammates.list()).length).toBe(1);
    });

    vi.spyOn(TeammateCollection.prototype, 'releaseAllOwned').mockRejectedValue(
      new Error('owned release failed'),
    );
    await expect(dispatcher.stop()).rejects.toThrow(/owned release failed/);
    // The sweep failed: the takeover record stays, so the idempotent stop
    // keeps rejecting instead of reporting an unproven barrier.
    await expect(dispatcher.workflows.stop({ run_id: accepted.run_id }))
      .rejects.toBeInstanceOf(WorkflowStopInterruptedError);
  });



});
