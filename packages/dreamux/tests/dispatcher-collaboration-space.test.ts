import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  ChannelSession,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import {
  handleCollaborationTargetLifecycle,
  routeTeamOrCollaborationChannelInput,
} from '../src/service/dispatcher-service/collaboration-routing.js';
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
    root = mkdtempSync(join('/tmp', 'dx-'));
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
    const accepted = deferred<{ provision: () => Promise<unknown> } | null>();
    const provisioned = deferred<unknown>();
    let returned = false;
    let provisionCalled = false;
    const channels = {
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
      collaborationSpaceConfig() {
        return {
          defaultBinding: {
            enabled: false,
            repo: null,
            identity: null,
          },
        };
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async acceptTargetCreatedForProvision(input: unknown, options: unknown) {
        expect(input).toMatchObject({
          channelId: 'primary',
          provider: CHANNEL_REF,
          target: { target_key: 'topic-1' },
        });
        expect(options).toMatchObject({ allowMissing: true });
        return accepted.promise;
      },
      startAcceptedTargetProvision(value: { provision: () => Promise<unknown> }) {
        void value.provision();
      },
      trackLifecycleTask(_kind: string, _task: Promise<unknown>) {
        /* test double: no-op */
      },
    } as unknown as CollaborationSpaceService;

    const running = handleCollaborationTargetLifecycle({
      dispatcherId: 'flow',
      dispatcherAgentRuntime: 'dispatcher-runtime',
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

    accepted.resolve({
      provision() {
        provisionCalled = true;
        return provisioned.promise;
      },
    });
    await running;

    expect(returned).toBe(true);
    expect(provisionCalled).toBe(true);
    provisioned.resolve({});
  });

  it('ignores target_created lifecycle events for missing collaboration spaces', async () => {
    const channels = {
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
      collaborationSpaceConfig() {
        return {
          defaultBinding: {
            enabled: false,
            repo: null,
            identity: null,
          },
        };
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async acceptTargetCreatedForProvision(input: unknown, options: unknown) {
        expect(input).toMatchObject({
          channelId: 'primary',
          provider: CHANNEL_REF,
          target: { target_key: 'topic-missing' },
        });
        expect(options).toMatchObject({ allowMissing: true });
        return null;
      },
      trackLifecycleTask(_kind: string, _task: Promise<unknown>) {
        /* test double: no-op */
      },
    } as unknown as CollaborationSpaceService;

    await expect(
      handleCollaborationTargetLifecycle({
        dispatcherId: 'flow',
        dispatcherAgentRuntime: 'dispatcher-runtime',
        channelId: 'primary',
        event: {
          kind: 'target_created',
          container: { container_type: 'topic_group', container_key: 'container-missing' },
          target: { target_type: 'topic', target_key: 'topic-missing', bindable: true },
        },
        channels,
        collaborationSpaces,
        log: noopLog(),
      }),
    ).resolves.toBeUndefined();
  });

  it('does not fall back to the dispatcher when collaboration provisioning fails', async () => {
    const fallback = vi.fn(async (): Promise<AgentRuntimeTurnResult> => ({
      status: 'submitted',
      turnId: 'fallback',
    }));
    const channels = {
      async resolveInboundBinding() {
        return null;
      },
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
      collaborationSpaceConfig() {
        return {
          defaultBinding: {
            enabled: false,
            repo: null,
            identity: null,
          },
        };
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async acceptAndProvisionTarget() {
        throw new Error('simulated provision failure');
      },
    } as unknown as CollaborationSpaceService;
    const teams = {
      async isOpenTeam() {
        return false;
      },
    } as unknown as TeamCollection;

    const result = await routeTeamOrCollaborationChannelInput({
      channelId: 'primary',
      dispatcherAgentRuntime: 'dispatcher-runtime',
      turn: {
        text: 'needs a target Team',
        body: 'needs a target Team',
        sourceId: 'msg-fail',
      },
      envelope: {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: {
          target_type: 'topic',
          target_key: 'topic-fail',
          bindable: true,
        },
      },
      channels,
      teams,
      collaborationSpaces,
      fallback,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('simulated provision failure');
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('routes an existing durable claim even when the inbound envelope has no container', async () => {
    const fallback = vi.fn(async (): Promise<AgentRuntimeTurnResult> => ({
      status: 'submitted',
      turnId: 'fallback',
    }));
    const delivered: InboundTurnInput[] = [];
    const routeOwner = {
      kind: 'team' as const,
      teamName: 'space-topic-team',
      leaderName: 'space-topic-leader',
    };
    let resolveCalls = 0;
    let claimCalls = 0;
    const channels = {
      async resolveInboundBinding(input: { target: { target_key: string } }) {
        resolveCalls += 1;
        return input.target.target_key === 'topic-claimed' && resolveCalls > 1
          ? { binding: { active: true }, owner: routeOwner }
          : null;
      },
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async provisionClaimedTarget(input: unknown) {
        claimCalls += 1;
        expect(input).toMatchObject({
          channelId: 'primary',
          provider: CHANNEL_REF,
          target: { target_key: 'topic-claimed' },
        });
        return {
          lifecycle_status: 'active',
          target_key: 'topic-claimed',
          team_name: routeOwner.teamName,
        };
      },
    } as unknown as CollaborationSpaceService;
    const teams = {
      async isOpenTeam(teamName: string) {
        return teamName === routeOwner.teamName;
      },
      async get(teamName: string) {
        expect(teamName).toBe(routeOwner.teamName);
        return {
          async deliverToLeader(turn: InboundTurnInput) {
            delivered.push(turn);
            return { status: 'submitted' as const, turnId: 'team-turn' };
          },
        };
      },
    } as unknown as TeamCollection;

    const result = await routeTeamOrCollaborationChannelInput({
      channelId: 'primary',
      dispatcherAgentRuntime: 'dispatcher-runtime',
      turn: {
        text: 'claim-only',
        body: 'claim-only',
        sourceId: 'msg-claim-only',
      },
      envelope: {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        target: {
          target_type: 'topic',
          target_key: 'topic-claimed',
          bindable: true,
        },
      },
      channels,
      teams,
      collaborationSpaces,
      fallback,
    });

    expect(result).toEqual({ status: 'submitted', turnId: 'team-turn' });
    expect(resolveCalls).toBe(2);
    expect(claimCalls).toBe(1);
    expect(delivered).toEqual([
      { text: 'claim-only', body: 'claim-only', sourceId: 'msg-claim-only' },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('auto-binds collaboration spaces from channel config on first inbound', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const dispatcherConfig = testDispatcherConfig({
      id: 'flow',
      cwd: workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      channelProvider: CHANNEL_REF,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repo: null,
        identity: 'Auto topic leader',
      },
    };
    const config = testDreamuxConfig([dispatcherConfig], {
      workspaceEnabled: false,
    });
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

    const result = await dispatcher.routeChannelInput(
      'primary',
      { text: 'auto topic', body: 'auto topic', sourceId: 'msg-auto' },
      {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'container-auto',
        },
        target: {
          target_type: 'topic',
          target_key: 'topic-auto',
          bindable: true,
        },
        event_id: 'msg-auto',
      },
    );

    if (result.status === 'failed') throw result.error;
    expect(result).toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(contexts[0]?.cwd).toMatch(/\/workspace\/space-/);
    const list = await dispatcher.listCollaborationSpaces();
    expect(list.spaces).toMatchObject([
      {
        status: 'bound',
        container_key: 'container-auto',
        current_binding: {
          worktree: { mode: 'default' },
          has_identity: true,
        },
      },
    ]);
  });

  it('does not auto-bind a known unbound collaboration space', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const dispatcherConfig = testDispatcherConfig({
      id: 'flow',
      cwd: workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      channelProvider: CHANNEL_REF,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repo: null,
        identity: 'Auto topic leader',
      },
    };
    const config = testDreamuxConfig([dispatcherConfig], {
      workspaceEnabled: false,
    });
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
      spaceName: 'space-known',
      channelId: 'primary',
      container: {
        container_type: 'topic_group',
        container_key: 'container-known',
      },
      leaderAgentRuntime: 'dispatcher-runtime',
    });
    await dispatcher.dissolveCollaborationSpace({
      spaceName: 'space-known',
      note: 'release default-bound space',
    });
    await dispatcher.prepareChannels();

    const result = await dispatcher.routeChannelInput(
      'primary',
      { text: 'known unbound', body: 'known unbound', sourceId: 'msg-known' },
      {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'container-known',
        },
        target: {
          target_type: 'topic',
          target_key: 'topic-known',
          bindable: true,
        },
        event_id: 'msg-known',
      },
    );

    expect(result).toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.submitted).toEqual([
      { text: 'known unbound', body: 'known unbound', sourceId: 'msg-known' },
    ]);
    await expect(dispatcher.listCollaborationSpaces()).resolves.toMatchObject({
      spaces: [
        {
          space_name: 'space-known',
          status: 'unbound',
          current_binding: null,
          target_counts: {},
        },
      ],
    });
  });

  it('falls back to dispatcher runtime when channel auto-binding is disabled', async () => {
    const workspace = join(root, 'workspace');
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
    await dispatcher.prepareChannels();

    const result = await dispatcher.routeChannelInput(
      'primary',
      { text: 'plain topic', body: 'plain topic', sourceId: 'msg-plain' },
      {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'container-plain',
        },
        target: {
          target_type: 'topic',
          target_key: 'topic-plain',
          bindable: true,
        },
      },
    );

    expect(result).toMatchObject({ status: 'submitted' });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.submitted).toEqual([
      { text: 'plain topic', body: 'plain topic', sourceId: 'msg-plain' },
    ]);
    await expect(dispatcher.listCollaborationSpaces()).resolves.toEqual({
      spaces: [],
    });
  });
});
