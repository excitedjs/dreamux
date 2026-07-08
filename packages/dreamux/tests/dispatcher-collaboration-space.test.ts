import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { handleCollaborationTargetLifecycle } from '../src/service/dispatcher-service/collaboration-routing.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const RUNTIME_REF = 'test:runtime';
const CHANNEL_REF = 'test:channel';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
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

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    return { status: 'submitted', turnId: `turn-${this.submitted.length}` };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turnId: `text-${this.textSubmitted.length}` };
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
    createSession() {
      throw new Error('test channel sessions are not constructed here');
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('DispatcherService collaboration-space routing', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-dispatcher-collab-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('provisions from neutral inbound container before delivery', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const repo = process.cwd();
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'flow',
        cwd: workspace,
        agentRuntime: 'dispatcher-runtime',
        runtimeProvider: RUNTIME_REF,
        channelProvider: CHANNEL_REF,
      }),
    ]);
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });

    await dispatcher.bindCollaborationSpace({
      spaceName: 'space-alpha',
      channelId: 'primary',
      container: {
        container_type: 'topic_group',
        container_key: 'container-1',
      },
      repo: { cwd: repo },
      leaderAgentRuntime: 'dispatcher-runtime',
      identity: 'Default TeamLeader identity',
    });
    const targetKey = `target-${root.slice(-6)}`;

    const result = await dispatcher.routeChannelInput(
      'primary',
      {
        text: 'first target message',
        body: 'first target message',
        sourceId: 'msg-1',
      },
      {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'container-1',
        },
        target: {
          target_type: 'topic',
          target_key: targetKey,
          bindable: true,
          display: 'Fix checkout',
          meta: { thread_id: 'provider-owned-value-that-core-must-ignore' },
        },
        event_id: 'msg-1',
      },
    );

    if (result.status === 'failed') throw result.error;
    expect(result).toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted).toEqual([
      { text: 'first target message', body: 'first target message', sourceId: 'msg-1' },
    ]);
    const prompt = contexts[0]?.systemPrompt?.append?.join('\n') ?? '';
    expect(prompt).toContain('TeamLeader');
    expect(prompt).toContain('Default TeamLeader identity');

    const status = await dispatcher.getCollaborationSpaceStatus({
      spaceName: 'space-alpha',
    });
    expect(status.targets).toMatchObject([
      {
        target_key: targetKey,
        lifecycle_status: 'active',
        phase: 'bound',
      },
    ]);
  });

  it('awaits target lifecycle accept but not heavy provisioning', async () => {
    const accepted = deferred<boolean>();
    const provisioned = deferred<unknown>();
    let returned = false;
    let provisionCalled = false;
    const channels = {
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async acceptTargetCreated(input: unknown) {
        expect(input).toMatchObject({
          channelId: 'primary',
          provider: CHANNEL_REF,
          target: { target_key: 'topic-1' },
        });
        return accepted.promise;
      },
      provisionTarget(input: unknown) {
        provisionCalled = true;
        expect(input).toMatchObject({
          channelId: 'primary',
          provider: CHANNEL_REF,
          target: { target_key: 'topic-1' },
        });
        return provisioned.promise;
      },
    } as unknown as CollaborationSpaceService;

    const running = handleCollaborationTargetLifecycle({
      dispatcherId: 'flow',
      channelId: 'primary',
      event: {
        kind: 'target_created',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: { target_type: 'topic', target_key: 'topic-1', bindable: true },
      },
      channels,
      collaborationSpaces,
      log: noopLog(),
    }).then(() => {
      returned = true;
    });

    await Promise.resolve();
    expect(returned).toBe(false);
    expect(provisionCalled).toBe(false);

    accepted.resolve(true);
    await running;

    expect(returned).toBe(true);
    expect(provisionCalled).toBe(true);
    provisioned.resolve({});
  });
});
