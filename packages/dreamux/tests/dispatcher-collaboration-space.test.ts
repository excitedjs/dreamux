import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  RuntimeAdmission,
  RuntimeTurnOutcome,
  ChannelCollaborationTargetEnsureResult,
  ChannelCoreEvent,
  ChannelCoreEventSource,
  ChannelCoreEventSubscription,
  ChannelProvider,
  ChannelRoutes,
  ChannelSession,
  ChannelTeamStateEvent,
  DreamuxLogger,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  saveDispatcherAccess,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import type { TeamCreateAtNameInput } from '../src/service/team-collection/types.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { TeamUnavailableError } from '../src/service/team-collection/errors.js';
import { TeammateService } from '../src/service/teammate-service/index.js';
import type { TeammateCollection } from '../src/service/teammate-collection/index.js';
import {
  deliverExactCollaborationTarget,
  handleCollaborationTargetLifecycle,
  routeTeamOrCollaborationChannelInput,
} from '../src/service/dispatcher-service/collaboration-routing.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { Server } from '../src/server.js';
import { dispatcherDir, resetRuntimeConfig } from '../src/platform/paths.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { defaultWorkspaceWorkPath } from '../src/service/worktree/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { feishuChannelCatalog } from './helpers/fake-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  completedRuntimeTurn,
  controllableRuntimeTurn,
  type ControllableRuntimeTurn,
} from './helpers/runtime-turn.js';

const RUNTIME_REF = 'test:runtime';
const CHANNEL_REF = 'test:channel';
const execFileAsync = promisify(execFile);

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  readonly channelTurns: ControllableRuntimeTurn[] = [];
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

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    this.submitted.push(input);
    const turn = controllableRuntimeTurn();
    this.channelTurns.push(turn);
    return { status: 'submitted', turn: turn.turn };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turn: completedRuntimeTurn('fake last') };
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

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }

  settle(outcome: RuntimeTurnOutcome, index = 0): void {
    if (!this.channelTurns[index]?.settle(outcome)) {
      throw new Error(`channel Turn ${index} is missing or already settled`);
    }
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
    async readTranscript() {
      return { turns: [], nextCursor: null, truncated: false };
    },
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

function fakeChannelCatalog(
  onStart?: (routes: ChannelRoutes) => void | Promise<void>,
): ChannelProviderCatalog {
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
        async start(routes) {
          await onStart?.(routes);
        },
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

function strictChannelDispatcher(input: {
  workspace: string;
  workspaceEnabled: boolean;
  defaultBindingEnabled?: boolean;
  onStart?: (routes: ChannelRoutes) => void | Promise<void>;
}) {
  const dispatcherConfig = testDispatcherConfig({
    id: 'strict-dispatcher',
    cwd: input.workspace,
    agentRuntime: 'dispatcher-runtime',
    runtimeProvider: RUNTIME_REF,
    channelProvider: CHANNEL_REF,
    workspaceEnabled: input.workspaceEnabled,
  });
  const primaryChannel = dispatcherConfig.channels[0];
  if (primaryChannel === undefined) throw new Error('missing primary Channel');
  primaryChannel.collaborationSpace = {
    defaultBinding: {
      enabled: input.defaultBindingEnabled ?? true,
      repo: null,
      identity: null,
    },
  };
  const config = testDreamuxConfig([dispatcherConfig]);
  const runtimes: FakeRuntime[] = [];
  const contexts: AgentRuntimeCreateContext[] = [];
  const routeGenerations: ChannelRoutes[] = [];
  let routes: ChannelRoutes | null = null;
  const dispatcher = new DispatcherService({
    id: 'strict-dispatcher',
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
    channelProviders: fakeChannelCatalog(async (startedRoutes) => {
      routeGenerations.push(startedRoutes);
      routes = startedRoutes;
      await input.onStart?.(startedRoutes);
    }),
    channelLoggerFactory: () => noopLog(),
    log: noopLog(),
  });
  return {
    dispatcher,
    runtimes,
    contexts,
    routeGenerations,
    routes(): ChannelRoutes {
      if (routes === null) throw new Error('test channel has not started');
      return routes;
    },
  };
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

function feishuTopicEvent(input: {
  messageId: string;
  chatId: string;
  threadId: string;
}): FeishuInboundEvent {
  return {
    messageId: input.messageId,
    chatId: input.chatId,
    chatType: 'group',
    threadId: input.threadId,
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@bot work on this' }),
    parsedText: '@Bot work on this',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-topic' },
        name: 'Bot',
      },
    ],
    createTime: '1782660000000',
    raw: {},
  };
}

function realFeishuDispatcher(input: {
  workspace: string;
  bot: ReturnType<typeof createFakeFeishuBot>;
}) {
  const config = testDreamuxConfig([
    testDispatcherConfig({
      id: 'flow',
      cwd: input.workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      workspaceEnabled: false,
    }),
  ]);
  const runtimes: FakeRuntime[] = [];
  const contexts: AgentRuntimeCreateContext[] = [];
  const dispatcher = new DispatcherService({
    id: 'flow',
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
    channelProviders: feishuChannelCatalog(() => input.bot),
    channelLoggerFactory: () => noopLog(),
    log: noopLog(),
  });
  return { dispatcher, runtimes, contexts };
}

async function allowFeishuTestSender(): Promise<void> {
  await saveDispatcherAccess(dispatcherDir('flow'), {
    version: 3,
    dm_policy: 'pairing',
    allow_users: ['sender-1'],
    group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    pending: {},
    observed_chats: [],
    warnings: [],
    last_gate: { at: 0 },
  });
}

describe('DispatcherService collaboration-space routing', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join('/tmp', 'dx-')));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([true, false])(
    'strict ensure follows dispatcher-local workspace policy (enabled=%s)',
    async (workspaceEnabled) => {
      const workspace = join(root, `strict-workspace-${String(workspaceEnabled)}`);
      mkdirSync(workspace, { recursive: true });
      const harness = strictChannelDispatcher({ workspace, workspaceEnabled });

      try {
        await harness.dispatcher.start();
        const routes = harness.routes();
        expect(routes.ensureCollaborationTarget).toBeTypeOf('function');
        const request = {
          container: {
            container_type: 'conversation',
            container_key: `container-${String(workspaceEnabled)}`,
          },
          target: {
            target_type: 'thread',
            target_key: `target-${String(workspaceEnabled)}`,
            bindable: true,
          },
        } as const;

        const [first, concurrent] = await Promise.all([
          routes.ensureCollaborationTarget!(request),
          routes.ensureCollaborationTarget!(request),
        ]);
        if (first.status !== 'ready') throw new Error(first.rejection.code);
        expect(Object.keys(first).sort()).toEqual(['status', 'team_name']);
        expect(concurrent).toEqual(first);
        await expect(routes.ensureCollaborationTarget!(request)).resolves.toEqual(
          first,
        );

        expect(harness.runtimes).toHaveLength(1);
        expect(harness.contexts).toHaveLength(1);
        expect(harness.contexts[0]?.identity.runtime_id).not.toBe(
          'strict-dispatcher',
        );
        expect(harness.contexts[0]?.cwd).toBe(
          workspaceEnabled
            ? defaultWorkspaceWorkPath({
                dispatcherWorkspace: workspace,
                slug: first.team_name,
              })
            : workspace,
        );
        expect(harness.runtimes[0]?.submitted).toEqual([]);
      } finally {
        await harness.dispatcher.stop();
      }
    },
  );

  it('makes the live event source usable before session start triggers ensure', async () => {
    const workspace = join(root, 'start-time-ensure-workspace');
    mkdirSync(workspace, { recursive: true });
    const events: ChannelTeamStateEvent[] = [];
    const observed: { ready?: ChannelCollaborationTargetEnsureResult } = {};
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: true,
      onStart: async (routes) => {
        routes.coreEvents!.on('team.state', (event) => {
          events.push(event);
        });
        observed.ready = await routes.ensureCollaborationTarget!({
          container: {
            container_type: 'conversation',
            container_key: 'start-time-container',
          },
          target: {
            target_type: 'thread',
            target_key: 'start-time-target',
            bindable: true,
          },
        });
      },
    });

    try {
      await harness.dispatcher.start();
      const ready = observed.ready;
      if (ready?.status !== 'ready') throw new Error('target was not ready');
      expect(events.map((event) => event.status)).toEqual([
        'starting',
        'running',
      ]);
      expect(new Set(events.map((event) => event.team_name))).toEqual(
        new Set([ready.team_name]),
      );
    } finally {
      await harness.dispatcher.stop();
    }
  });

  it('revokes the event source when Channel session start fails', async () => {
    const workspace = join(root, 'failed-start-workspace');
    mkdirSync(workspace, { recursive: true });
    const captured: {
      source?: ChannelCoreEventSource;
      subscription?: ChannelCoreEventSubscription;
    } = {};
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: false,
      onStart: (routes) => {
        captured.source = routes.coreEvents!;
        captured.subscription = captured.source.on(
          'team.state',
          () => undefined,
        );
        throw new Error('intentional Channel start failure');
      },
    });

    await expect(harness.dispatcher.start()).rejects.toThrow(
      'intentional Channel start failure',
    );
    const source = captured.source;
    const subscription = captured.subscription;
    if (source === undefined || subscription === undefined) {
      throw new Error('Channel did not receive the event source');
    }
    expect(() => source.on('team.state', () => undefined)).toThrow(
      'no longer active',
    );
    subscription.unsubscribe();
    subscription.unsubscribe();
    await harness.dispatcher.stop();
  });

  it('retains the same Dispatcher Agent when failed-start rollback cannot prove close', async () => {
    const workspace = join(root, 'failed-start-close-proof-workspace');
    mkdirSync(workspace, { recursive: true });
    let channelStartCount = 0;
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: false,
      onStart: () => {
        channelStartCount += 1;
        throw new Error('intentional Channel start failure');
      },
    });
    const closedEntities: TeammateService[] = [];
    const originalClose = TeammateService.prototype.close;
    let failClose = true;
    vi.spyOn(TeammateService.prototype, 'close').mockImplementation(
      function (this: TeammateService, input) {
        closedEntities.push(this);
        if (failClose) {
          return Promise.reject(new Error('runtime termination proof failed'));
        }
        return originalClose.call(this, input);
      },
    );

    const firstFailure = await harness.dispatcher.start().catch(
      (error: unknown) => error,
    );
    expect(firstFailure).toBeInstanceOf(AggregateError);
    const firstErrors = (firstFailure as AggregateError).errors;
    expect(firstErrors[0]).toMatchObject({
      message: 'intentional Channel start failure',
    });
    expect(firstErrors[1]).toBeInstanceOf(AggregateError);
    expect((firstErrors[1] as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'runtime termination proof failed' }),
      expect.objectContaining({ message: 'runtime termination proof failed' }),
    ]);
    expect(channelStartCount).toBe(1);
    expect(closedEntities).toHaveLength(2);
    expect(closedEntities[1]).toBe(closedEntities[0]);

    await expect(harness.dispatcher.start()).rejects.toThrow(
      /prior teardown is incomplete/u,
    );
    expect(channelStartCount).toBe(1);
    expect(closedEntities).toHaveLength(2);

    failClose = false;
    await harness.dispatcher.stop();
    expect(closedEntities).toHaveLength(4);
    expect(closedEntities.every((entity) => entity === closedEntities[0])).toBe(true);
  });

  it('revokes old strict routes across stop and restart generations', async () => {
    const workspace = join(root, 'strict-route-generation-workspace');
    mkdirSync(workspace, { recursive: true });
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: false,
    });
    const request = {
      container: {
        container_type: 'conversation',
        container_key: 'route-generation-container',
      },
      target: {
        target_type: 'thread',
        target_key: 'route-generation-target',
        bindable: true,
      },
    } as const;
    const unavailable = {
      status: 'rejected',
      rejection: { code: 'dispatcher_unavailable', retryable: true },
    } as const;
    const failedDelivery = { status: 'failed' } as const;

    try {
      await harness.dispatcher.start();
      const oldRoutes = harness.routes();
      const ready = await oldRoutes.ensureCollaborationTarget!(request);
      if (ready.status !== 'ready') throw new Error(ready.rejection.code);
      expect(harness.runtimes).toHaveLength(1);

      await harness.dispatcher.stop();
      expect(harness.runtimes[0]?.getStatus()).toBe('stopped');
      await expect(
        oldRoutes.ensureCollaborationTarget!(request),
      ).resolves.toEqual(unavailable);
      await expect(
        oldRoutes.deliverExact!({
          target: request.target,
          expected_team_name: ready.team_name,
          turn: { text: 'old stopped route', sourceId: 'old-stopped-route' },
        }),
      ).resolves.toEqual(failedDelivery);
      expect(harness.runtimes).toHaveLength(1);
      expect(harness.runtimes[0]?.getStatus()).toBe('stopped');

      await harness.dispatcher.start();
      const newRoutes = harness.routes();
      expect(newRoutes).not.toBe(oldRoutes);
      expect(harness.routeGenerations).toEqual([oldRoutes, newRoutes]);
      await expect(
        oldRoutes.ensureCollaborationTarget!(request),
      ).resolves.toEqual(unavailable);
      await expect(
        oldRoutes.deliverExact!({
          target: request.target,
          expected_team_name: ready.team_name,
          turn: { text: 'old restarted route', sourceId: 'old-restarted-route' },
        }),
      ).resolves.toEqual(failedDelivery);
      expect(harness.runtimes).toHaveLength(1);
      expect(harness.runtimes[0]?.getStatus()).toBe('stopped');

      await expect(
        newRoutes.ensureCollaborationTarget!(request),
      ).resolves.toEqual(ready);
      expect(harness.runtimes).toHaveLength(2);
      await expect(
        newRoutes.deliverExact!({
          target: request.target,
          expected_team_name: ready.team_name,
          turn: { text: 'new route', sourceId: 'new-route' },
        }),
      ).resolves.toEqual({ status: 'submitted' });
      expect(harness.runtimes[1]?.submitted).toEqual([
        { text: 'new route', sourceId: 'new-route' },
      ]);
    } finally {
      await harness.dispatcher.stop();
    }
  });

  it('rolls back Team runtimes materialized before Channel start fails', async () => {
    const workspace = join(root, 'strict-start-rollback-workspace');
    mkdirSync(workspace, { recursive: true });
    const request = {
      container: {
        container_type: 'conversation',
        container_key: 'start-rollback-container',
      },
      target: {
        target_type: 'thread',
        target_key: 'start-rollback-target',
        bindable: true,
      },
    } as const;
    let ready: ChannelCollaborationTargetEnsureResult | undefined;
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: false,
      onStart: async (routes) => {
        ready = await routes.ensureCollaborationTarget!(request);
        if (ready.status !== 'ready') throw new Error(ready.rejection.code);
        throw new Error('intentional failure after strict ensure');
      },
    });
    const unavailable = {
      status: 'rejected',
      rejection: { code: 'dispatcher_unavailable', retryable: true },
    } as const;
    const failedDelivery = { status: 'failed' } as const;

    await expect(harness.dispatcher.start()).rejects.toThrow(
      'intentional failure after strict ensure',
    );
    if (ready?.status !== 'ready') throw new Error('target was not ready');
    const oldRoutes = harness.routes();
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.runtimes[0]?.getStatus()).toBe('stopped');
    await expect(
      oldRoutes.ensureCollaborationTarget!(request),
    ).resolves.toEqual(unavailable);
    await expect(
      oldRoutes.deliverExact!({
        target: request.target,
        expected_team_name: ready.team_name,
        turn: { text: 'must stay stopped', sourceId: 'failed-start-route' },
      }),
    ).resolves.toEqual(failedDelivery);
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.runtimes[0]?.getStatus()).toBe('stopped');
    expect(harness.runtimes[0]?.submitted).toEqual([]);
    await harness.dispatcher.stop();
  });

  it('fails strict ensure closed when no collaboration binding is available', async () => {
    const workspace = join(root, 'missing-binding-workspace');
    mkdirSync(workspace, { recursive: true });
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: true,
      defaultBindingEnabled: false,
    });

    try {
      await harness.dispatcher.start();
      await expect(
        harness.routes().ensureCollaborationTarget!({
          container: {
            container_type: 'conversation',
            container_key: 'missing-binding-container',
          },
          target: {
            target_type: 'thread',
            target_key: 'missing-binding-target',
            bindable: true,
          },
        }),
      ).resolves.toEqual({
        status: 'rejected',
        rejection: {
          code: 'collaboration_space_unavailable',
          retryable: true,
        },
      });
      expect(harness.runtimes).toEqual([]);
    } finally {
      await harness.dispatcher.stop();
    }
  });

  it('uses the exact authoritative TeamLeader route and publishes scoped live facts', async () => {
    const workspace = join(root, 'strict-route-workspace');
    mkdirSync(workspace, { recursive: true });
    const harness = strictChannelDispatcher({
      workspace,
      workspaceEnabled: false,
    });
    let stopped = false;

    try {
      await harness.dispatcher.start();
      const routes = harness.routes();
      expect(routes.deliverExact).toBeTypeOf('function');
      expect(routes.coreEvents).toBeDefined();
      const events: ChannelCoreEvent[] = [];
      const subscriptions = [
        routes.coreEvents!.on('team.state', (event) => {
          events.push(event);
        }),
        routes.coreEvents!.on('agent.state', (event) => {
          events.push(event);
        }),
        routes.coreEvents!.on('binding.collaboration_space', (event) => {
          events.push(event);
        }),
        routes.coreEvents!.on('binding.route', (event) => {
          events.push(event);
        }),
      ];
      const container = {
        container_type: 'conversation',
        container_key: 'container-strict-route',
      } as const;
      const target = {
        target_type: 'thread',
        target_key: 'target-strict-route',
        bindable: true,
        meta: { provider_private: 'ignored' },
      } as const;

      const ensured = await routes.ensureCollaborationTarget!({
        container,
        target,
        title: 'Strict route',
      });
      if (ensured.status !== 'ready') throw new Error(ensured.rejection.code);
      expect(harness.runtimes).toHaveLength(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'binding.collaboration_space',
            action: 'bound',
            transition: 'bound',
            container: expect.objectContaining({
              provider: CHANNEL_REF,
              endpoint_key: 'container-strict-route',
            }),
          }),
          expect.objectContaining({
            kind: 'binding.route',
            action: 'bound',
            transition: 'bound',
            endpoint: expect.objectContaining({
              provider: CHANNEL_REF,
              endpoint_key: 'target-strict-route',
            }),
            current_team: expect.objectContaining({
              team_name: ensured.team_name,
              leader_agent_runtime: 'dispatcher-runtime',
              runtime_cwd: workspace,
            }),
          }),
        ]),
      );
      await expect(
        routes.ensureCollaborationTarget!({
          container,
          target: {
            target_type: 'thread',
            target_key: 'not-bindable',
            bindable: false,
          },
        }),
      ).resolves.toEqual({
        status: 'rejected',
        rejection: { code: 'invalid_input', retryable: false },
      });

      await expect(
        routes.deliverExact!({
          target,
          expected_team_name: ensured.team_name,
          turn: {
            text: 'strict delivery',
            body: 'strict delivery',
            sourceId: 'runtime-local-source',
          },
        }),
      ).resolves.toEqual({ status: 'submitted' });
      expect(harness.runtimes[0]?.submitted).toEqual([
        {
          text: 'strict delivery',
          body: 'strict delivery',
          sourceId: 'runtime-local-source',
        },
      ]);

      await expect(
        routes.deliverExact!({
          target,
          expected_team_name: 'stale-team-owner',
          turn: { text: 'must not deliver', sourceId: 'stale-source' },
        }),
      ).resolves.toEqual({ status: 'failed' });
      await expect(
        routes.deliverExact!({
          target: {
            target_type: 'thread',
            target_key: 'missing-exact-target',
            bindable: true,
            binding_fallbacks: [target],
          },
          expected_team_name: ensured.team_name,
          turn: { text: 'must not fallback', sourceId: 'fallback-source' },
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(harness.runtimes[0]?.submitted).toHaveLength(1);

      await expect(
        routes.ensureCollaborationTarget!({
          container: {
            container_type: 'conversation',
            container_key: 'different-container',
          },
          target,
        }),
      ).resolves.toEqual({
        status: 'rejected',
        rejection: { code: 'target_conflict', retryable: false },
      });
      await expect(
        routes.ensureCollaborationTarget!({
          container: { ...container, container_type: 'different-container-type' },
          target,
        }),
      ).resolves.toEqual({
        status: 'rejected',
        rejection: { code: 'target_conflict', retryable: false },
      });
      await expect(
        routes.ensureCollaborationTarget!({
          container,
          target: { ...target, target_type: 'different-target-type' },
        }),
      ).resolves.toEqual({
        status: 'rejected',
        rejection: { code: 'target_conflict', retryable: false },
      });
      expect(harness.runtimes).toHaveLength(1);

      harness.runtimes[0]!.settle({
        status: 'completed',
        resultText: 'strict answer',
        truncated: true,
      });
      await expect(
        harness.runtimes[0]!.channelTurns[0]!.turn.settled,
      ).resolves.toMatchObject({ status: 'completed' });

      const leaderName = events.find(
        (event) => event.kind === 'team.state',
      )?.leader_name;
      if (leaderName === undefined) throw new Error('missing Team state event');
      expect(events).toContainEqual({
        schema_version: 1,
        kind: 'team.state',
        occurred_at: expect.any(Number),
        team_name: ensured.team_name,
        leader_name: leaderName,
        status: 'running',
      });
      expect(events).toContainEqual({
        schema_version: 1,
        kind: 'agent.state',
        occurred_at: expect.any(Number),
        team_name: ensured.team_name,
        agent_name: leaderName,
        role: 'team_leader',
        status: 'starting',
      });
      const liveFactEvents = events.filter(
        (event) =>
          event.kind === 'team.state' ||
          event.kind === 'agent.state',
      );
      expect(
        liveFactEvents.every(
          (event) =>
            event.team_name === ensured.team_name &&
            (event.kind === 'team.state' || event.agent_name === leaderName),
        ),
      ).toBe(true);

      const idle = deferred<void>();
      vi.spyOn(harness.runtimes[0]!, 'waitIdle')
        .mockImplementation(() => idle.promise);
      const dissolving = harness.dispatcher.dissolveTeam({
        teamId: ensured.team_name,
        note: 'Verify exact delivery fails closed after Team dissolution.',
      });
      await expect(dissolving).resolves.toEqual({
        accepted: true,
        team_name: ensured.team_name,
        status: 'closing',
      });
      await vi.waitFor(async () => {
        await expect(
          harness.dispatcher.getTeamStatus(ensured.team_name),
        ).resolves.toMatchObject({
          team: { dissolve_phase: 'waiting_for_team_idle' },
        });
      });
      await expect(
        routes.deliverExact!({
          target,
          expected_team_name: ensured.team_name,
          turn: {
            text: 'must not pass an accepted Team fence',
            sourceId: 'closing-source',
          },
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(harness.runtimes[0]?.submitted).toHaveLength(1);
      idle.resolve();
      await vi.waitFor(async () => {
        await expect(
          harness.dispatcher.getTeamStatus(ensured.team_name),
        ).resolves.toMatchObject({
          team: { status: 'closed', dissolve_phase: 'complete' },
        });
      });
      await expect(
        routes.deliverExact!({
          target,
          expected_team_name: ensured.team_name,
          turn: {
            text: 'must not reach a closed Team',
            sourceId: 'closed-source',
          },
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(harness.runtimes[0]?.submitted).toHaveLength(1);

      await harness.dispatcher.stop();
      stopped = true;
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
        subscription.unsubscribe();
      }
      expect(() =>
        routes.coreEvents!.on('team.state', () => undefined),
      ).toThrow('no longer active');
    } finally {
      if (!stopped) await harness.dispatcher.stop();
    }
  });

  it('provisions from neutral inbound container before delivery', async () => {
    const sourceRepoPath = join(root, 'source');
    mkdirSync(sourceRepoPath, { recursive: true });
    const repo = realpathSync(sourceRepoPath);
    const git = async (args: string[]) => execFileAsync('git', args, { cwd: repo });
    await git(['init', '--initial-branch=main', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
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

  it('routes a non-collaboration topic group through its existing group binding', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-topic', 'topic');
    const { dispatcher, runtimes } = realFeishuDispatcher({ workspace, bot });
    await allowFeishuTestSender();

    try {
      await dispatcher.startInputSources();
      const groupTeam = await dispatcher.createTeam({
        namePrefix: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the existing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: groupTeam.team.team_name,
        channelId: 'primary',
        meta: { chat_id: 'chat-topic' },
      });

      await bot.inject(feishuTopicEvent({
        messageId: 'msg-group-fallback',
        chatId: 'chat-topic',
        threadId: 'topic-a',
      }));

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.submitted).toHaveLength(1);
      expect(runtimes[0]?.submitted[0]?.attrs).toContainEqual([
        'thread_id',
        'topic-a',
      ]);
      await expect(dispatcher.listCollaborationSpaces()).resolves.toEqual({
        spaces: [],
      });
      await expect(dispatcher.listTeams()).resolves.toHaveLength(1);
    } finally {
      await dispatcher.stop();
    }
  });

  it('auto-provisions ahead of a group fallback and reuses the topic Team', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'flow',
        cwd: workspace,
        agentRuntime: 'dispatcher-runtime',
        runtimeProvider: RUNTIME_REF,
        workspaceEnabled: false,
      }),
    ]);
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-topic', 'topic');
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
      channelProviders: feishuChannelCatalog(() => bot),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    try {
      await dispatcher.startInputSources();
      const groupTeam = await dispatcher.createTeam({
        namePrefix: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the enclosing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: groupTeam.team.team_name,
        channelId: 'primary',
        meta: { chat_id: 'chat-topic' },
      });
      await dispatcher.bindCollaborationSpace({
        spaceName: 'feishu-space',
        channelId: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-topic',
        },
        leaderAgentRuntime: 'dispatcher-runtime',
      });
      await bot.inject(feishuTopicEvent({
        messageId: 'msg-topic-root',
        chatId: 'chat-topic',
        threadId: 'topic-a',
      }));
      await bot.inject({
        ...feishuTopicEvent({
          messageId: 'msg-topic-reply',
          chatId: 'chat-topic',
          threadId: 'topic-a',
        }),
        rootId: 'msg-topic-root',
        parentId: 'msg-topic-root',
      });

      expect(runtimes).toHaveLength(2);
      expect(runtimes[0]?.submitted).toHaveLength(0);
      expect(runtimes[1]?.submitted).toHaveLength(2);
      expect(runtimes[1]?.submitted.map((turn) =>
        turn.attrs?.find(([key]) => key === 'thread_id')?.[1],
      )).toEqual(['topic-a', 'topic-a']);
      await vi.waitFor(() => {
        expect(bot.sentCards).toHaveLength(3);
      });
      expect(bot.sentCards[2]?.target).toMatchObject({
        chatId: 'chat-topic',
        replyToMessageId: 'msg-topic-root',
      });
      await expect(dispatcher.getCollaborationSpaceStatus({
        spaceName: 'feishu-space',
      })).resolves.toMatchObject({
        space: { status: 'bound' },
        targets: [
          {
            target_key: 'topic-a',
            lifecycle_status: 'active',
            phase: 'bound',
          },
        ],
      });
    } finally {
      await dispatcher.stop();
    }
  });

  it('keeps Dispatcher fallback for a topic group with no accepted route', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-topic', 'topic');
    const { dispatcher, runtimes } = realFeishuDispatcher({ workspace, bot });
    await allowFeishuTestSender();

    try {
      await dispatcher.startInputSources();
      await bot.inject(feishuTopicEvent({
        messageId: 'msg-dispatcher-fallback',
        chatId: 'chat-topic',
        threadId: 'topic-a',
      }));

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.submitted).toHaveLength(1);
      expect(runtimes[0]?.submitted[0]?.attrs).toContainEqual([
        'thread_id',
        'topic-a',
      ]);
      await expect(dispatcher.listTeams()).resolves.toEqual([]);
      await expect(dispatcher.listCollaborationSpaces()).resolves.toEqual({
        spaces: [],
      });
    } finally {
      await dispatcher.stop();
    }
  });

  it('keeps an exact topic binding ahead of collaboration and group routes', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-topic', 'topic');
    const { dispatcher, runtimes } = realFeishuDispatcher({ workspace, bot });
    await allowFeishuTestSender();

    try {
      await dispatcher.startInputSources();
      const groupTeam = await dispatcher.createTeam({
        namePrefix: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the enclosing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: groupTeam.team.team_name,
        channelId: 'primary',
        meta: { chat_id: 'chat-topic' },
      });
      await bot.inject(feishuTopicEvent({
        messageId: 'msg-topic-root',
        chatId: 'chat-topic',
        threadId: 'topic-a',
      }));

      const exactTopicTeam = await dispatcher.createTeam({
        namePrefix: 'exact-topic-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own one exact topic route',
      });
      await dispatcher.bindTeamChannel({
        teamId: exactTopicTeam.team.team_name,
        channelId: 'primary',
        meta: {
          chat_id: 'chat-topic',
          message_id: 'msg-topic-root',
        },
      });
      await dispatcher.bindCollaborationSpace({
        spaceName: 'feishu-space',
        channelId: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-topic',
        },
        leaderAgentRuntime: 'dispatcher-runtime',
      });
      await bot.inject({
        ...feishuTopicEvent({
          messageId: 'msg-topic-reply',
          chatId: 'chat-topic',
          threadId: 'topic-a',
        }),
        rootId: 'msg-topic-root',
        parentId: 'msg-topic-root',
      });

      expect(runtimes).toHaveLength(2);
      expect(runtimes[0]?.submitted.map((turn) => turn.sourceId)).toEqual([
        'msg-topic-root',
      ]);
      expect(runtimes[1]?.submitted.map((turn) => turn.sourceId)).toEqual([
        'msg-topic-reply',
      ]);
      await vi.waitFor(() => {
        expect(bot.sentCards).toHaveLength(3);
      });
      expect(bot.sentCards[0]?.target).toMatchObject({ chatId: 'chat-topic' });
      expect(bot.sentCards[0]?.target.replyToMessageId).toBeUndefined();
      expect(bot.sentCards[1]?.target).toMatchObject({
        chatId: 'chat-topic',
        replyToMessageId: 'msg-topic-root',
      });
      expect(bot.sentCards[2]?.target).toMatchObject({ chatId: 'chat-topic' });
      expect(bot.sentCards[2]?.target.replyToMessageId).toBeUndefined();
      await expect(dispatcher.getCollaborationSpaceStatus({
        spaceName: 'feishu-space',
      })).resolves.toMatchObject({
        space: { status: 'bound' },
        targets: [],
      });
    } finally {
      await dispatcher.stop();
    }
  });

  it('does not provision an ordinary group thread through the real Feishu provider', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'flow',
        cwd: workspace,
        agentRuntime: 'dispatcher-runtime',
        runtimeProvider: RUNTIME_REF,
        workspaceEnabled: false,
      }),
    ]);
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-normal', 'group');
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, contexts),
      channelProviders: feishuChannelCatalog(() => bot),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    await dispatcher.bindCollaborationSpace({
      spaceName: 'ordinary-space',
      channelId: 'primary',
      container: {
        container_type: 'topic_group',
        container_key: 'chat-normal',
      },
      leaderAgentRuntime: 'dispatcher-runtime',
    });

    try {
      await dispatcher.startInputSources();
      await bot.inject(feishuTopicEvent({
        messageId: 'msg-normal-thread',
        chatId: 'chat-normal',
        threadId: 'ordinary-thread',
      }));

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.submitted).toHaveLength(1);
      expect(runtimes[0]?.submitted[0]?.attrs).toContainEqual([
        'thread_id',
        'ordinary-thread',
      ]);
      await expect(dispatcher.getCollaborationSpaceStatus({
        spaceName: 'ordinary-space',
      })).resolves.toMatchObject({
        space: { status: 'bound' },
        targets: [],
      });
    } finally {
      await dispatcher.stop();
    }
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

  it('fails loud for an unknown target lifecycle kind without closing a target', async () => {
    let closeAccepts = 0;
    const collaborationSpaces = {
      async acceptTargetClosedForClose() {
        closeAccepts += 1;
        return null;
      },
      trackLifecycleTask(_kind: string, _task: Promise<unknown>) {
        /* test double: no-op */
      },
    } as unknown as CollaborationSpaceService;

    await expect(handleCollaborationTargetLifecycle({
      dispatcherId: 'flow',
      dispatcherAgentRuntime: 'dispatcher-runtime',
      channelId: 'primary',
      event: {
        kind: 'target_renamed',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: { target_type: 'topic', target_key: 'topic-1', bindable: true },
      } as never,
      channels: {} as ChannelService,
      collaborationSpaces,
      log: noopLog(),
    })).rejects.toThrow(/unknown channel target lifecycle event kind.*target_renamed/);
    expect(closeAccepts).toBe(0);
  });

  it('does not fall back to the dispatcher when collaboration provisioning fails', async () => {
    const fallback = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
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
      async reconcileInboundTargetRoute() {
        return null;
      },
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

  it('preserves an untyped exact-delivery rejection as admission-ambiguous', async () => {
    const deliverExact = vi.fn(async () => {
      throw new Error('response lost after exact delivery');
    });

    await expect(deliverExactCollaborationTarget({
      channelId: 'primary',
      request: {
        target: {
          target_type: 'topic',
          target_key: 'topic-ambiguous',
          bindable: true,
        },
        expected_team_name: 'team-ambiguous',
        turn: {
          text: 'deliver at most once',
          sourceId: 'provider-private-source',
        },
      },
      collaborationSpaces: { deliverExact } as unknown as CollaborationSpaceService,
      log: noopLog(),
    })).resolves.toEqual({ status: 'ambiguous' });
    expect(deliverExact).toHaveBeenCalledTimes(1);
  });

  it('does not cross an unavailable exact binding to a broader fallback binding', async () => {
    const fallback = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const resolvedTargetKeys: string[] = [];
    const exactOwner = {
      kind: 'team' as const,
      teamName: 'exact-team',
      leaderName: 'exact-leader',
    };
    const groupOwner = {
      kind: 'team' as const,
      teamName: 'group-team',
      leaderName: 'group-leader',
    };
    const channels = {
      async resolveInboundBinding(input: { target: { target_key: string } }) {
        resolvedTargetKeys.push(input.target.target_key);
        if (input.target.target_key === 'topic-a') {
          return { binding: { active: true }, owner: exactOwner };
        }
        if (input.target.target_key === 'chat-topic') {
          return { binding: { active: true }, owner: groupOwner };
        }
        return null;
      },
      channelProviderRef() {
        return CHANNEL_REF;
      },
      collaborationSpaceConfig() {
        return {
          defaultBinding: { enabled: false, repo: null, identity: null },
        };
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async reconcileInboundTargetRoute() {
        return null;
      },
      async acceptAndProvisionTarget() {
        return null;
      },
      async provisionClaimedTarget() {
        return null;
      },
    } as unknown as CollaborationSpaceService;
    const groupDelivery = vi.fn(async (
      _turn: InboundTurnInput,
    ): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const teams = {
      async isOpenTeam(teamName: string) {
        return teamName === groupOwner.teamName;
      },
      async deliverToLeader(teamName: string, turn: InboundTurnInput) {
        if (teamName === exactOwner.teamName) {
          throw new TeamUnavailableError('exact Team route is unavailable');
        }
        return groupDelivery(turn);
      },
    } as unknown as TeamCollection;

    const result = await routeTeamOrCollaborationChannelInput({
      channelId: 'primary',
      dispatcherAgentRuntime: 'dispatcher-runtime',
      turn: {
        text: 'exact route is unavailable',
        body: 'exact route is unavailable',
        sourceId: 'msg-unavailable',
      },
      envelope: {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-topic',
        },
        target: {
          target_type: 'topic',
          target_key: 'topic-a',
          bindable: true,
          binding_fallbacks: [
            {
              target_type: 'group',
              target_key: 'chat-topic',
              bindable: true,
            },
          ],
        },
      },
      channels,
      teams,
      collaborationSpaces,
      fallback,
    });

    expect(result).toEqual({ status: 'submitted' });
    expect(resolvedTargetKeys).toEqual(['topic-a']);
    expect(groupDelivery).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('falls back when an explicitly detached collaboration target is inbound', async () => {
    const fallback = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const channels = {
      async resolveInboundBinding() {
        return null;
      },
      channelProviderRef() {
        return CHANNEL_REF;
      },
      collaborationSpaceConfig() {
        return {
          defaultBinding: { enabled: false, repo: null, identity: null },
        };
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async reconcileInboundTargetRoute() {
        return { lifecycle_status: 'detached' };
      },
      async acceptAndProvisionTarget() {
        return { lifecycle_status: 'detached' };
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
      turn: { text: 'detached', body: 'detached', sourceId: 'msg-detached' },
      envelope: {
        provider: CHANNEL_REF,
        channel_id: 'primary',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: { target_type: 'topic', target_key: 'topic-detached', bindable: true },
      },
      channels,
      teams,
      collaborationSpaces,
      fallback,
    });

    expect(result).toEqual({ status: 'submitted' });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('routes an existing durable claim even when the inbound envelope has no container', async () => {
    const fallback = vi.fn(async (): Promise<InboundDeliveryResult> => ({
      status: 'submitted',
    }));
    const delivered: InboundTurnInput[] = [];
    const routeOwner = {
      kind: 'team' as const,
      teamName: 'space-topic-team',
      leaderName: 'space-topic-leader',
    };
    let resolveCalls = 0;
    let claimCalls = 0;
    let claimed = false;
    const channels = {
      async resolveInboundBinding(input: { target: { target_key: string } }) {
        resolveCalls += 1;
        return input.target.target_key === 'topic-claimed' && claimed
          ? { binding: { active: true }, owner: routeOwner }
          : null;
      },
      channelProviderRef(channelId: string) {
        expect(channelId).toBe('primary');
        return CHANNEL_REF;
      },
    } as unknown as ChannelService;
    const collaborationSpaces = {
      async reconcileInboundTargetRoute() {
        return null;
      },
      async provisionClaimedTarget(input: unknown) {
        claimCalls += 1;
        claimed = true;
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
      async deliverToLeader(teamName: string, turn: InboundTurnInput) {
        expect(teamName).toBe(routeOwner.teamName);
        delivered.push(turn);
        return { status: 'submitted' as const };
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

    expect(result).toEqual({ status: 'submitted' });
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
      workspaceEnabled: false,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repo: null,
        identity: 'Auto topic leader',
      },
    };
    const config = testDreamuxConfig([dispatcherConfig]);
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
    expect(contexts[0]?.cwd).toBe(workspace);
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

  it('publishes one space event across concurrent default auto-bind', async () => {
    const workspace = join(root, 'workspace-concurrent-default-bind');
    mkdirSync(workspace, { recursive: true });
    const events: ChannelCoreEvent[] = [];
    const observed: Array<
      Awaited<ReturnType<NonNullable<ChannelRoutes['ensureCollaborationTarget']>>>
    > = [];
    const dispatcherConfig = testDispatcherConfig({
      id: 'flow',
      cwd: workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      channelProvider: CHANNEL_REF,
      workspaceEnabled: false,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repo: null,
        identity: 'Auto topic leader',
      },
    };
    const config = testDreamuxConfig([dispatcherConfig]);
    const runtimes: FakeRuntime[] = [];
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, []),
      channelProviders: fakeChannelCatalog(async (routes) => {
        routes.coreEvents!.on('binding.collaboration_space', (event) => {
          events.push(event);
        });
        const request = {
          container: {
            container_type: 'topic_group',
            container_key: 'container-auto-concurrent',
          },
          target: {
            target_type: 'topic',
            target_key: 'topic-auto-concurrent',
            bindable: true,
          },
        } as const;
        observed.push(...await Promise.all([
          routes.ensureCollaborationTarget!(request),
          routes.ensureCollaborationTarget!(request),
        ]));
      }),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });

    try {
      await dispatcher.start();
      expect(observed.every((result) => result.status === 'ready')).toBe(true);
      expect(runtimes).toHaveLength(1);
      expect(events.filter(
        (event) => event.kind === 'binding.collaboration_space',
      )).toEqual([
        expect.objectContaining({
          action: 'bound',
          transition: 'bound',
          container: expect.objectContaining({
            endpoint_key: 'container-auto-concurrent',
          }),
        }),
      ]);
    } finally {
      await dispatcher.stop();
    }
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
      workspaceEnabled: false,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repo: null,
        identity: 'Auto topic leader',
      },
    };
    const config = testDreamuxConfig([dispatcherConfig]);
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

  it('single-flights stop and drains direct inbound collaboration provisioning', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    const accepted = deferred<void>();
    const release = deferred<void>();
    const collaborationSpaces = (
      dispatcher as unknown as { collaborationSpaces: CollaborationSpaceService }
    ).collaborationSpaces;
    collaborationSpaces.reconcileInboundTargetRoute = async () => null;
    collaborationSpaces.acceptAndProvisionTarget = async () => {
      accepted.resolve();
      await release.promise;
      return null;
    };
    const envelope = {
      provider: CHANNEL_REF,
      channel_id: 'primary',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: { target_type: 'topic', target_key: 'topic-stop', bindable: true },
    } as const;
    const inbound = dispatcher.routeChannelInput(
      'primary',
      { text: 'in flight', body: 'in flight', sourceId: 'msg-stop' },
      envelope,
    );
    void inbound.catch(() => {});
    await accepted.promise;

    const firstStop = dispatcher.stop();
    const secondStop = dispatcher.stop();
    expect(secondStop).toBe(firstStop);
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(() => dispatcher.routeChannelInput(
      'primary',
      { text: 'late', body: 'late', sourceId: 'msg-late' },
      envelope,
    )).toThrow(/shutting down/);

    release.resolve();
    await Promise.allSettled([inbound, firstStop, secondStop]);
    expect(stopped).toBe(true);
  });

  it('interrupts Team dissolve waits before draining admitted tasks', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    const calls: string[] = [];
    const internals = dispatcher as unknown as {
      teams: TeamCollection;
      admittedTasks: { drain(): Promise<void> };
    };
    vi.spyOn(internals.teams, 'interruptDissolvesForShutdown')
      .mockImplementation(() => {
        calls.push('interrupt');
      });
    vi.spyOn(internals.admittedTasks, 'drain').mockImplementation(async () => {
      calls.push('drain');
    });

    await dispatcher.stop();

    expect(calls).toEqual(['interrupt', 'interrupt', 'drain']);
  });

  it('interrupts Team dissolve waits before awaiting input-source recovery', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    const recovery = deferred<void>();
    const calls: string[] = [];
    const internals = dispatcher as unknown as {
      teams: TeamCollection;
      admittedTasks: { drain(): Promise<void> };
      inputSources: { waitForSettledStart(): Promise<void> };
    };
    vi.spyOn(internals.inputSources, 'waitForSettledStart')
      .mockReturnValue(recovery.promise);
    vi.spyOn(internals.teams, 'interruptDissolvesForShutdown')
      .mockImplementation(() => {
        calls.push('interrupt');
      });
    vi.spyOn(internals.admittedTasks, 'drain').mockImplementation(async () => {
      calls.push('drain');
    });

    const stop = dispatcher.stop();
    expect(calls).toEqual(['interrupt', 'interrupt']);

    recovery.resolve();
    await stop;
    expect(calls).toEqual(['interrupt', 'interrupt', 'drain']);
  });

  it('closes the canonical Dispatcher Agent before Channel and start drains settle', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await dispatcher.start();
    const channelClose = deferred<void>();
    const calls: string[] = [];
    const internals = dispatcher as unknown as {
      channels: { closeAll(log: DreamuxLogger): Promise<void> };
      inputSources: {
        agent: TeammateService | null;
        waitForSettledStart(): Promise<void>;
      };
    };
    const agent = internals.inputSources.agent;
    if (agent === null) throw new Error('dispatcher Agent was not started');
    const closeAgent = agent.close.bind(agent);
    vi.spyOn(agent, 'close').mockImplementation(async (input) => {
      calls.push('agent-close');
      return closeAgent(input);
    });
    vi.spyOn(internals.channels, 'closeAll').mockImplementation(async () => {
      calls.push('channel-close');
      await channelClose.promise;
    });
    vi.spyOn(internals.inputSources, 'waitForSettledStart')
      .mockImplementation(async () => {
        calls.push('start-drain');
      });

    const stopping = dispatcher.stop();
    await vi.waitFor(() => expect(calls).toContain('channel-close'));
    expect(calls.indexOf('agent-close')).toBeLessThan(
      calls.indexOf('channel-close'),
    );
    expect(calls).not.toContain('start-drain');

    channelClose.resolve();
    await stopping;
    expect(calls).toContain('start-drain');
  });

  it('closes an ordinary TeamMate before the admitted-task drain it releases', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await dispatcher.start();
    const spawned = await dispatcher.teammates.spawn({
      name: 'drain-releaser',
      prompt: 'close me before draining',
      cwd: workspace,
      worktree: { mode: 'reuse-cwd' },
      agentRuntime: 'dispatcher-runtime',
      intent: 'prove close-before-admitted-drain ordering',
    });
    const internals = dispatcher as unknown as {
      _teammates: TeammateCollection;
      admittedTasks: { drain(): Promise<void> };
    };
    const entity = internals._teammates.materializedEntities().find(
      (candidate) => candidate.name === spawned.teammate.name,
    );
    if (entity === undefined) throw new Error('ordinary TeamMate was not materialized');
    const closed = deferred<void>();
    const calls: string[] = [];
    const close = entity.close.bind(entity);
    vi.spyOn(entity, 'close').mockImplementation(async (input) => {
      const result = await close(input);
      calls.push('ordinary-close');
      closed.resolve();
      return result;
    });
    vi.spyOn(internals.admittedTasks, 'drain').mockImplementation(async () => {
      calls.push('admitted-drain');
      await closed.promise;
    });

    await dispatcher.stop();
    expect(calls.indexOf('ordinary-close')).toBeLessThan(
      calls.indexOf('admitted-drain'),
    );
  });

  it('drains an already-admitted Team create before stop completes', async () => {
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
    const accepted = deferred<void>();
    const release = deferred<void>();
    const teams = (dispatcher as unknown as {
      teams: {
        create: TeamCollection['create'];
      };
    }).teams;
    const createTeam = teams.create.bind(teams);
    teams.create = async (input: TeamCreateAtNameInput) => {
      accepted.resolve();
      await release.promise;
      return createTeam(input);
    };

    const create = dispatcher.createTeam({
      namePrefix: 'admitted-create',
      leaderAgentRuntime: 'dispatcher-runtime',
      intent: 'verify dispatcher admission drain',
    });
    void create.catch(() => {});
    await accepted.promise;

    const stop = dispatcher.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(() => dispatcher.createTeam({
      namePrefix: 'late-create',
      leaderAgentRuntime: 'dispatcher-runtime',
      intent: 'too late',
    })).toThrow(/shutting down/);

    release.resolve();
    const [created] = await Promise.all([create, stop]);
    expect(stopped).toBe(true);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.getStatus()).toBe('stopped');
    if (created.leader === null) throw new Error('TeamLeader projection is missing');
    await expect(new AgentIdentityStore(noopLog()).leaderIdentity(
      'flow',
      created.team.team_name,
    )).resolves.toMatchObject({
      name: created.leader.name,
      status: 'closed',
    });
  });

  it('continues the common dispatcher close pipeline after an earlier failure', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    const calls: string[] = [];
    const stopError = new Error('stop failed');
    const teamError = new Error('team stop failed');
    const internals = dispatcher as unknown as {
      workflowOwner: { stopAll: () => Promise<void> };
      teams: TeamCollection;
    };
    vi.spyOn(internals.workflowOwner, 'stopAll')
      .mockRejectedValueOnce(stopError)
      .mockImplementation(async () => {
      calls.push('workflows');
    });
    vi.spyOn(internals.teams, 'stopAll')
      .mockRejectedValueOnce(teamError)
      .mockImplementation(async () => {
      calls.push('teams');
    });

    await expect(dispatcher.shutdown()).rejects.toMatchObject({
      errors: [stopError, teamError],
    });
    expect(calls).toEqual(['workflows', 'teams']);
  });

  it('keeps start fenced until failed Workflow teardown is retried', async () => {
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    const stopError = new Error('workflow termination proof failed');
    const internals = dispatcher as unknown as {
      workflowOwner: { stopAll: () => Promise<void> };
    };
    const stopAll = vi.spyOn(internals.workflowOwner, 'stopAll')
      .mockRejectedValueOnce(stopError)
      .mockResolvedValue(undefined);

    await expect(dispatcher.stop()).rejects.toBe(stopError);
    await expect(dispatcher.start()).rejects.toThrow(
      /prior teardown is incomplete/u,
    );
    expect(stopAll).toHaveBeenCalledTimes(2);

    await dispatcher.stop();
    await expect(dispatcher.prepareChannels()).resolves.toBeUndefined();
    expect(stopAll).toHaveBeenCalledTimes(4);
    await dispatcher.stop();
  });

  it('continues server shutdown to the admin socket after dispatcher cleanup fails', async () => {
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
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog([], []),
      channelProviderCatalog: fakeChannelCatalog(),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });
    const calls: string[] = [];
    const dispatcherError = new Error('dispatcher shutdown failed');
    const mutable = server as unknown as {
      dispatchers: {
        beginShutdown: () => void;
        shutdown: () => Promise<void>;
      };
      admin: { close: () => Promise<void> } | null;
    };
    mutable.dispatchers = {
      beginShutdown: () => {
        calls.push('fence');
      },
      shutdown: async () => {
        calls.push('dispatchers');
        throw dispatcherError;
      },
    };
    mutable.admin = {
      close: async () => {
        calls.push('admin');
      },
    };

    await expect(server.shutdown()).rejects.toBe(dispatcherError);
    expect(calls).toEqual(['fence', 'dispatchers', 'admin']);
    expect(mutable.admin).toBeNull();

    mutable.dispatchers = {
      beginShutdown: () => {
        calls.push('fence-retry');
      },
      shutdown: async () => {
        calls.push('dispatchers-retry');
      },
    };
    await expect(server.shutdown()).resolves.toBeUndefined();
    expect(calls).toEqual([
      'fence',
      'dispatchers',
      'admin',
      'fence-retry',
      'dispatchers-retry',
    ]);
  });

  it('closes dispatcher entities before draining accepted admin requests', async () => {
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
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog([], []),
      channelProviderCatalog: fakeChannelCatalog(),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });
    const accepted = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    const request = server.admitAdminRequest(async () => {
      calls.push('request-start');
      accepted.resolve();
      await release.promise;
      calls.push('request-done');
      return 'ok';
    });
    await accepted.promise;

    const mutable = server as unknown as {
      dispatchers: {
        beginShutdown: () => void;
        shutdown: () => Promise<void>;
      };
      admin: { close: () => Promise<void> } | null;
    };
    mutable.dispatchers = {
      beginShutdown: () => {
        calls.push('fence');
      },
      shutdown: async () => {
        calls.push('dispatchers');
      },
    };
    mutable.admin = {
      close: async () => {
        calls.push('admin');
      },
    };

    const shutdown = server.shutdown();
    await Promise.resolve();
    expect(() => server.admitAdminRequest(async () => 'late')).toThrow(
      /shutting down/,
    );
    expect(calls).toEqual(['request-start', 'fence', 'dispatchers']);

    release.resolve();
    await expect(request).resolves.toBe('ok');
    await expect(shutdown).resolves.toBeUndefined();
    expect(calls).toEqual([
      'request-start',
      'fence',
      'dispatchers',
      'request-done',
      'admin',
    ]);
  });

  it('does not materialize a new dispatcher after dispatcher shutdown starts', async () => {
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
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog([], []),
      channelProviderCatalog: fakeChannelCatalog(),
      logger: noopLog(),
      channelLoggerFactory: () => noopLog(),
    });

    await server.dispatchers.shutdown();

    expect(() => server.getDispatcher('flow')).toThrow(/shutting down/);
  });

  it('stops Team leaders before dispatcher stop completes', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
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
      agentRuntimeProviders: fakeRuntimeCatalog(runtimes, []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await dispatcher.createTeam({
      namePrefix: 'stop-sweep',
      leaderAgentRuntime: 'dispatcher-runtime',
      intent: 'verify Team runtime shutdown',
    });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.getStatus()).toBe('ready');

    await dispatcher.stop();

    expect(runtimes[0]?.getStatus()).toBe('stopped');
  });

  it('materializes and closes a durable cold-cache ordinary TeamMate', async () => {
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
    const initialRuntimes: FakeRuntime[] = [];
    const first = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(initialRuntimes, []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await first.start();
    const spawned = await first.teammates.spawn({
      name: 'cold-helper',
      prompt: 'survive until restart shutdown',
      cwd: workspace,
      worktree: { mode: 'reuse-cwd' },
      agentRuntime: 'dispatcher-runtime',
      intent: 'prove cold closure',
    });
    expect(spawned.teammate.status).not.toBe('closed');

    const recoveredRuntimes: FakeRuntime[] = [];
    const recovered = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog(recoveredRuntimes, []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await recovered.shutdown();

    await expect(new AgentIdentityStore(noopLog()).get(
      'flow',
      spawned.teammate.name,
    )).resolves.toMatchObject({ status: 'closed' });
    expect(recoveredRuntimes).toHaveLength(0);
  });

  it('bounds completion delivery so Dispatcher shutdown cannot wait forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog([], []),
      channelProviders: fakeChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    await dispatcher.start();
    const submit = vi.fn(() => new Promise<never>(() => undefined));
    vi.spyOn(dispatcher, 'initiatorFor').mockResolvedValue({
      prepareCompletion: async () => Object.freeze({ submit }),
    });
    await dispatcher.teammates.spawn({
      name: 'bounded-helper',
      prompt: 'finish before shutdown',
      cwd: workspace,
      worktree: { mode: 'reuse-cwd' },
      agentRuntime: 'dispatcher-runtime',
      intent: 'terminal delivery must not block shutdown',
    });
    await waitForEventLoop(() => submit.mock.calls.length === 1);

    const shutdown = dispatcher.shutdown();
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('event-loop condition was not reached');
}
