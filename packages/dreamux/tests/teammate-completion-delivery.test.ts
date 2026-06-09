import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCreateContext,
  type AgentRuntimeProvider,
  type CompletionEnvelope,
  type TeamMateCompletionDeliveryResult,
} from '../src/agent-runtime/index.js';
import { createFakeFeishuBot } from '../src/channel/feishu/bot.js';
import { DispatcherAgentService } from '../src/dispatcher-service/dispatcher/service.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDreamuxConfig } from './helpers/config.js';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [{ kind: 'codexInboxTurn', description: 'inbox turn' }],
};

/**
 * Scripted dispatcher runtime: `completionInput` returns the next queued result
 * (defaulting to accepted) and counts every call, so Seam ③ retry behavior is
 * observable. `omitCompletionInput` models a runtime that declares no completion
 * delivery at all.
 */
interface DeliveryBehavior {
  results: TeamMateCompletionDeliveryResult[];
  calls: number;
  omitCompletionInput: boolean;
}

function makeRuntime(behavior: DeliveryBehavior): AgentRuntime {
  let status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  const runtime: AgentRuntime = {
    providerRef: 'builtin:codex',
    async start() {
      status = 'ready';
    },
    async resume() {
      status = 'ready';
    },
    async stop() {
      status = 'stopped';
    },
    async channelInput() {
      return { status: 'submitted', turnId: 'turn-1' };
    },
    async systemInput() {
      return { status: 'skipped' };
    },
    getStatus: () => status,
    getThreadId: () => 'thread-1',
    wasThreadResumed: () => false,
    async getLast() {
      return { text: null };
    },
    async getContext() {
      return { usedTokens: null, windowTokens: null };
    },
    getCapabilities: () => CAPABILITIES,
  };
  if (!behavior.omitCompletionInput) {
    runtime.completionInput = async (): Promise<TeamMateCompletionDeliveryResult> => {
      behavior.calls += 1;
      return behavior.results.shift() ?? { status: 'accepted' };
    };
  }
  return runtime;
}

class ScriptedProvider implements AgentRuntimeProvider {
  readonly ref = 'builtin:codex';

  constructor(
    readonly descriptor: AgentRuntimeProvider['descriptor'],
    private readonly behavior: DeliveryBehavior,
  ) {}

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }

  createRuntime(_context: AgentRuntimeCreateContext): AgentRuntime {
    return makeRuntime(this.behavior);
  }
}

function buildService(
  behavior: DeliveryBehavior,
  adminSocketPath: string,
): DispatcherAgentService {
  const config = testDreamuxConfig();
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  registry.registerImplementation(
    descriptor.id,
    new ScriptedProvider(descriptor, behavior),
  );
  return new DispatcherAgentService({
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

function envelope(): CompletionEnvelope {
  return { source: 'reviewer', id: 'reviewer:turn-1', status: 'completed', result: 'done' };
}

describe('DispatcherAgentService.deliverCompletion (Seam ③)', () => {
  let root: string;
  let adminSocketPath: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dx-'));
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

  it('retries a failed delivery until accepted', async () => {
    const behavior: DeliveryBehavior = {
      results: [
        { status: 'failed', error: new Error('boom 1') },
        { status: 'failed', error: new Error('boom 2') },
        { status: 'accepted' },
      ],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');

    await expect(service.deliverCompletion('flow', envelope())).resolves.toBeUndefined();
    expect(behavior.calls).toBe(3);

    await service.shutdown();
  });

  it('coalesces duplicate completion delivery calls while one is in flight', async () => {
    const behavior: DeliveryBehavior = {
      results: [{ status: 'accepted' }],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');
    const completion = envelope();

    await expect(
      Promise.all([
        service.deliverCompletion('flow', completion),
        service.deliverCompletion('flow', completion),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(behavior.calls).toBe(1);

    await service.shutdown();
  });

  it('does not redeliver a completion id after acceptance', async () => {
    const behavior: DeliveryBehavior = {
      results: [{ status: 'accepted' }, { status: 'accepted' }],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');
    const completion = envelope();

    await service.deliverCompletion('flow', completion);
    await service.deliverCompletion('flow', completion);
    expect(behavior.calls).toBe(1);

    await service.shutdown();
  });

  it('retries a completion id on a later call after an exhausted failed call', async () => {
    const behavior: DeliveryBehavior = {
      results: [
        { status: 'failed', error: new Error('boom 1') },
        { status: 'failed', error: new Error('boom 2') },
        { status: 'failed', error: new Error('boom 3') },
        { status: 'accepted' },
      ],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');
    const completion = envelope();

    await service.deliverCompletion('flow', completion);
    expect(behavior.calls).toBe(3);

    await service.deliverCompletion('flow', completion);
    expect(behavior.calls).toBe(4);

    await service.deliverCompletion('flow', completion);
    expect(behavior.calls).toBe(4);

    await service.shutdown();
  });

  it('stops after exhausting retries without throwing', async () => {
    const behavior: DeliveryBehavior = {
      results: [
        { status: 'failed', error: new Error('boom 1') },
        { status: 'failed', error: new Error('boom 2') },
        { status: 'failed', error: new Error('boom 3') },
        { status: 'failed', error: new Error('boom 4') },
      ],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');

    await expect(service.deliverCompletion('flow', envelope())).resolves.toBeUndefined();
    expect(behavior.calls).toBe(3);

    await service.shutdown();
  });

  it('drops a single time on an unsupported result', async () => {
    const behavior: DeliveryBehavior = {
      results: [{ status: 'unsupported', reason: 'runtime stopped' }],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');

    await expect(service.deliverCompletion('flow', envelope())).resolves.toBeUndefined();
    expect(behavior.calls).toBe(1);

    await service.shutdown();
  });

  it('drops when the dispatcher is not running', async () => {
    const behavior: DeliveryBehavior = {
      results: [],
      calls: 0,
      omitCompletionInput: false,
    };
    const service = buildService(behavior, adminSocketPath);
    // Never started: no live slot.
    await expect(service.deliverCompletion('flow', envelope())).resolves.toBeUndefined();
    expect(behavior.calls).toBe(0);
  });

  it('drops when the runtime declares no completion delivery', async () => {
    const behavior: DeliveryBehavior = {
      results: [],
      calls: 0,
      omitCompletionInput: true,
    };
    const service = buildService(behavior, adminSocketPath);
    await service.startDispatcher('flow');

    await expect(service.deliverCompletion('flow', envelope())).resolves.toBeUndefined();
    expect(behavior.calls).toBe(0);

    await service.shutdown();
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
