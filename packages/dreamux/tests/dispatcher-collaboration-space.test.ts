import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import {
  saveDispatcherAccess,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import { canonicalTaskIdentity } from '../src/service/channel-task-host/identity.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import {
  handleCollaborationTargetLifecycle,
  routeTeamOrCollaborationChannelInput,
} from '../src/service/dispatcher-service/collaboration-routing.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { Server } from '../src/server.js';
import { dispatcherDir, resetRuntimeConfig } from '../src/platform/paths.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { feishuChannelCatalog } from './helpers/fake-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

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
  } as unknown as AgentRuntimeProviderCatalog;
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

function fakeTaskChannelCatalog(): ChannelProviderCatalog {
  const provider: ChannelProvider = {
    ref: 'test:task-channel',
    descriptor: {
      id: 'test-task-channel',
      kind: 'channel',
      ref: { source: 'builtin', id: 'test-task-channel', raw: 'test:task-channel' },
    },
    taskChannel: {
      protocol: 'task_channel_host_v1',
      schema_versions: [1],
      capabilities: ['durable_task_submission_v1', 'host_event_stream_v1'],
    },
    createSession(context) {
      return {
        provider: context.provider,
        channel_id: context.channel_id,
        taskHostEvents: {
          async acceptHostEvents(batch) {
            return { acknowledged_through: batch.last_sequence ?? 0 };
          },
        },
        async start() {},
        async close() {},
        async resolveTarget() {
          throw new Error('task session does not resolve conversational targets');
        },
      } satisfies ChannelSession;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== provider.ref) throw new Error(`unexpected provider ${ref}`);
      return provider;
    },
  } as ChannelProviderCatalog;
}

function fakeDurableRuntimeCatalog(
  runtimes: FakeRuntime[],
  contexts: AgentRuntimeCreateContext[],
): AgentRuntimeProviderCatalog {
  const capabilities: AgentRuntimeCapabilities = {
    resume: { supported: false },
    durableTaskSubmission: {
      supported: true,
      protocol: 'durable_task_submission_v1',
    },
    durableTaskToolInvocation: {
      supported: true,
      protocol: 'durable_task_mcp_invocation_v1',
    },
  };
  const provider: AgentRuntimeProvider = {
    ref: RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: RUNTIME_REF },
    },
    getCapabilities: () => capabilities,
    createRuntime(context) {
      contexts.push(context);
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve: () => provider,
  } as unknown as AgentRuntimeProviderCatalog;
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

  it('routes a non-collaboration topic group through its existing group binding', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const bot = createFakeFeishuBot('app-topic');
    bot.setChatMode('chat-topic', 'topic');
    const { dispatcher, runtimes } = realFeishuDispatcher({ workspace, bot });
    await allowFeishuTestSender();

    try {
      await dispatcher.startInputSources();
      await dispatcher.createTeam({
        name: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the existing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: 'group-team',
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
      await dispatcher.createTeam({
        name: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the enclosing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: 'group-team',
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
      await dispatcher.createTeam({
        name: 'group-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own the enclosing group route',
      });
      await dispatcher.bindTeamChannel({
        teamId: 'group-team',
        channelId: 'primary',
        meta: { chat_id: 'chat-topic' },
      });
      await bot.inject(feishuTopicEvent({
        messageId: 'msg-topic-root',
        chatId: 'chat-topic',
        threadId: 'topic-a',
      }));

      await dispatcher.createTeam({
        name: 'exact-topic-team',
        leaderAgentRuntime: 'dispatcher-runtime',
        intent: 'own one exact topic route',
      });
      await dispatcher.bindTeamChannel({
        teamId: 'exact-topic-team',
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

  it('does not cross an unavailable exact binding to a broader fallback binding', async () => {
    const fallback = vi.fn(async (): Promise<AgentRuntimeTurnResult> => ({
      status: 'submitted',
      turnId: 'fallback',
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
    const groupDelivery = vi.fn(async (): Promise<AgentRuntimeTurnResult> => ({
      status: 'submitted',
      turnId: 'group-turn',
    }));
    const teams = {
      async isOpenTeam(teamName: string) {
        return teamName === groupOwner.teamName;
      },
      async get() {
        return { deliverToLeader: groupDelivery };
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

    expect(result).toEqual({ status: 'submitted', turnId: 'fallback' });
    expect(resolvedTargetKeys).toEqual(['topic-a']);
    expect(groupDelivery).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('falls back when an explicitly detached collaboration target is inbound', async () => {
    const fallback = vi.fn(async (): Promise<AgentRuntimeTurnResult> => ({
      status: 'submitted',
      turnId: 'fallback',
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

    expect(result).toEqual({ status: 'submitted', turnId: 'fallback' });
    expect(fallback).toHaveBeenCalledOnce();
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
      workspaceEnabled: false,
    });
    dispatcherConfig.channels[0]!.collaborationSpace = {
      defaultBinding: {
        enabled: true,
        repositorySource: 'static',
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
        repositorySource: 'static',
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
    const teams = (dispatcher as unknown as {
      teams: { create: (input: unknown) => Promise<unknown> };
    }).teams;
    teams.create = async () => {
      accepted.resolve();
      await release.promise;
      return {
        team: {},
        leader: {},
        member_count: 0,
        turn: null,
      };
    };

    const create = dispatcher.createTeam({
      name: 'admitted-create',
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
    await expect(dispatcher.createTeam({
      name: 'late-create',
      leaderAgentRuntime: 'dispatcher-runtime',
      intent: 'too late',
    })).rejects.toThrow(/shutting down/);

    release.resolve();
    await Promise.all([create, stop]);
    expect(stopped).toBe(true);
  });

  it('continues dispatcher shutdown cleanup after an earlier stop failure', async () => {
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
    const mutable = dispatcher as unknown as {
      stop: () => Promise<void>;
      _teammates: { stopAll: () => Promise<void> };
      teams: { stopAll: () => Promise<void> };
    };
    mutable.stop = async () => {
      calls.push('stop');
      throw stopError;
    };
    mutable._teammates = {
      stopAll: async () => {
        calls.push('teammates');
      },
    };
    mutable.teams = {
      stopAll: async () => {
        calls.push('teams');
        throw teamError;
      },
    };

    await expect(dispatcher.shutdown()).rejects.toMatchObject({
      errors: [stopError, teamError],
    });
    expect(calls).toEqual(['stop', 'teammates', 'teams']);
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
      dispatchers: { shutdown: () => Promise<void> };
      admin: { close: () => Promise<void> } | null;
    };
    mutable.dispatchers = {
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
    expect(calls).toEqual(['dispatchers', 'admin']);
    expect(mutable.admin).toBeNull();

    mutable.dispatchers = {
      shutdown: async () => {
        calls.push('dispatchers-retry');
      },
    };
    await expect(server.shutdown()).resolves.toBeUndefined();
    expect(calls).toEqual(['dispatchers', 'admin', 'dispatchers-retry']);
  });

  it('drains accepted admin requests before dispatcher shutdown and rejects late requests', async () => {
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
      dispatchers: { shutdown: () => Promise<void> };
      admin: { close: () => Promise<void> } | null;
    };
    mutable.dispatchers = {
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
    expect(calls).toEqual(['request-start']);

    release.resolve();
    await expect(request).resolves.toBe('ok');
    await expect(shutdown).resolves.toBeUndefined();
    expect(calls).toEqual(['request-start', 'request-done', 'dispatchers', 'admin']);
  });

  it('loads durable task ownership before a persisted Team is materialized', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const channelId = 'remote-tasks';
    const provider = 'test:task-channel';
    const dispatcherConfig = testDispatcherConfig({
      id: 'flow',
      cwd: workspace,
      agentRuntime: 'dispatcher-runtime',
      runtimeProvider: RUNTIME_REF,
      channels: [{
        id: channelId,
        provider,
        collaborationSpace: {
          defaultBinding: {
            enabled: true,
            repositorySource: 'static',
            repo: { cwd: workspace, baseRef: null },
            identity: null,
          },
        },
        config: {},
        identity: 'remote-task-platform',
      }],
      workspaceEnabled: false,
    });
    const config = testDreamuxConfig([dispatcherConfig]);
    const attempt = { task_key: 'task-a', attempt_key: 'attempt-1' };
    const taskIdentity = canonicalTaskIdentity({
      dispatcherId: 'flow',
      channelId,
      containerType: 'task-space',
      containerKey: 'space-a',
      attempt,
    });
    const leaderName = 'task-leader';
    const worktree = {
      mode: 'reuse-cwd' as const,
      slug: null,
      path: workspace,
      branch: null,
      base_ref: null,
      cleanup: 'keep' as const,
      cleanup_state: 'not-managed' as const,
      cleanup_error: null,
    };
    await new TeamStore().create({
      dispatcher_id: 'flow',
      team_id: taskIdentity.teamName,
      name: taskIdentity.teamName,
      repo_cwd: workspace,
      source_repo: null,
      leader_name: leaderName,
      leader_agent_runtime: 'dispatcher-runtime',
      runtime_cwd: workspace,
      worktree,
      status: 'running',
      intent: 'durable remote task',
      closed_at: null,
      close_note: null,
    });
    await new AgentIdentityStore(noopLog()).create({
      dispatcherId: 'flow',
      name: leaderName,
      role: 'team_leader',
      teamId: taskIdentity.teamName,
      agentRuntime: 'dispatcher-runtime',
      sourceCwd: workspace,
      sourceRepo: null,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree,
      intent: 'durable remote task',
      status: 'running',
    });
    const taskStore = await TaskHostStore.open({
      dispatcherId: 'flow',
      channelId,
      providerRef: provider,
    });
    const repository = {
      source: 'static' as const,
      logical_key: '@static',
      binding_revision: 'static-v1',
      fingerprint: 'a'.repeat(64),
      repo_cwd: workspace,
      base_ref: null,
      base_commit: '0'.repeat(40),
    };
    await taskStore.claim({
      dispatcherId: 'flow',
      channelId,
      provider,
      targetId: taskIdentity.targetId,
      canonicalTargetKey: taskIdentity.targetKey,
      attempt,
      container: { container_type: 'task-space', container_key: 'space-a' },
      logicalRepository: null,
      resolvedRepository: repository,
      requestFingerprint: 'request-fingerprint',
      receipt: {
        receipt_id: taskIdentity.receiptId,
        target_id: taskIdentity.targetId,
        attempt,
        revision: 1,
        accepted_at: 1,
      },
      title: 'Task A',
      turn: { sourceId: 'delivery-a', text: 'Execute task A' },
      teamName: taskIdentity.teamName,
      worktreeSlug: taskIdentity.worktreeSlug,
      routeClaimId: taskIdentity.routeClaimId,
    });
    await taskStore.updateTarget(
      taskIdentity.targetId,
      null,
      (target) => {
        target.phase = 'blocked';
        target.binding = {
          space_name: 'space-a',
          generation: 1,
          repository,
          leader_agent_runtime: 'dispatcher-runtime',
          identity: null,
        };
        target.team.leader_name = leaderName;
        target.blocked = {
          from_phase: 'ready',
          code: 'TASK_SUBMISSION_IN_DOUBT',
          retryable: false,
          at: 1,
        };
      },
      [{
        payload: {
          kind: 'task.lifecycle',
          phase: 'blocked',
          blocked_code: 'TASK_SUBMISSION_IN_DOUBT',
          retryable: false,
        },
      }],
    );
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const dispatcher = new DispatcherService({
      id: 'flow',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeDurableRuntimeCatalog(runtimes, contexts),
      channelProviders: fakeTaskChannelCatalog(),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });

    await expect(dispatcher.getTeamStatus(taskIdentity.teamName)).resolves.toMatchObject({
      team: { team_name: taskIdentity.teamName },
    });
    await expect(dispatcher.sendTeamLeader({
      teamId: taskIdentity.teamName,
      prompt: 'must remain strict task delivery',
    })).rejects.toThrow(/requires a durable invocation identity/);
    expect(runtimes).toHaveLength(0);
    await dispatcher.stop();
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
      name: 'stop-sweep',
      leaderAgentRuntime: 'dispatcher-runtime',
      intent: 'verify Team runtime shutdown',
    });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.getStatus()).toBe('ready');

    await dispatcher.stop();

    expect(runtimes[0]?.getStatus()).toBe('stopped');
  });
});
