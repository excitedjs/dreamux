import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Server } from '../src/server.js';
import {
  buildToolCatalog,
} from '@excitedjs/feishu-channel';
import { sendAdminRequest } from '../src/admin/client.js';
import {
  loadDispatcherAccess,
  saveDispatcherAccess,
} from '@excitedjs/feishu-channel';
import { CodexWsClient } from '@excitedjs/agent-runtime-codex';
import {
  CodexProcess,
  type CodexProcessOptions,
} from '@excitedjs/agent-runtime-codex';
import {
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import { feishuChannelCatalog } from './helpers/fake-channel.js';
import { codexAgentRuntimeCatalog } from './helpers/fake-agent-runtime.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';
import { runChannelMcp } from '../src/mcp/channel-mcp.js';
import { BUILT_IN_DEFAULTS, type DreamuxConfig } from '../src/config/config.js';
import { defaultDispatcherCwd, dispatcherDir } from '../src/platform/paths.js';
import { dispatcherCodexHome } from '@excitedjs/agent-runtime-codex';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';
import { testDispatcherConfig } from './helpers/config.js';
import { callTool, connectMcpClient } from './helpers/mcp-client.js';

class NoopCodexProcess extends CodexProcess {
  constructor(opts: CodexProcessOptions) {
    super(opts);
  }

  override async start(): Promise<void> {
    // No child process; e2e tests connect the runtime to fake Codex.
  }

  override async reap(): Promise<void> {
    // Nothing to reap.
  }
}

function configWithDispatcher(): DreamuxConfig {
  const dispatcher = testDispatcherConfig({
    id: 'flow',
    // Explicit workspace cwd (issue #182 PR-4): no state-dir fallback. The
    // e2e flow runs no managed worktree, so the per-dispatcher dir works.
    cwd: defaultDispatcherCwd('flow'),
    enabled: true,
    feishu: {
      app_id: 'app-e2e',
      app_secret: 'secret-server-only',
    },
    codex: {
      bin: 'codex',
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      extra_env: {},
      initialize_timeout_ms: 10000,
    },
  });
  return {
    ...BUILT_IN_DEFAULTS,
    agents: {
      [dispatcher.agentRuntime]: {
        provider: dispatcher.runtime.provider,
        config: dispatcher.runtime.config,
      },
    },
    dispatchers: [dispatcher],
  };
}

function buildServer(opts: {
  runtimeDir: string;
  fake: FakeCodex;
  bot: FakeFeishuBot;
}): Server {
  return new Server({
    config: configWithDispatcher(),
    adminSocketPath: join(opts.runtimeDir, 'admin.sock'),
    channelProviderCatalog: feishuChannelCatalog(() => opts.bot),
    // Codex construction seams live on the provider implementation now, injected
    // via the AgentRuntime catalog rather than as Server options.
    agentRuntimeProviderCatalog: codexAgentRuntimeCatalog({
      codexProcessFactory: (o) => new NoopCodexProcess(o),
      codexClientFactory: () => new CodexWsClient({ url: opts.fake.url }),
      codexHomeDoctor: () => {
        /* fake Codex tests do not require real operator Codex auth */
      },
    }),
  });
}

function fakeInbound(
  chatId: string,
  text: string,
  messageId: string,
): FeishuInboundEvent {
  return {
    messageId,
    chatId,
    chatType: 'group',
    senderId: 'sender-test',
    senderType: 'user',
    senderName: 'Ada',
    messageType: 'text',
    rawContent: JSON.stringify({ text }),
    parsedText: text,
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-e2e' },
        name: 'Dispatcher',
      },
    ],
    createTime: '1710000000000',
    raw: { event: { message: { chat_id: chatId, message_id: messageId } } },
  };
}

function captureCodexInputs(inputs: string[]): (input: string) => string {
  return (input) => {
    inputs.push(input);
    return 'assistant text must not be sent automatically';
  };
}

async function callFeishuMcpTool(
  runtimeDir: string,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const mcp = await connectMcpClient(
    (transport) =>
      runChannelMcp({
        dispatcherId: 'flow',
        adminSocketPath: join(runtimeDir, 'admin.sock'),
        tools: buildToolCatalog(),
        transport,
        log: () => {},
      }),
    '2025-06-18',
  );
  try {
    return await callTool(
      mcp.client,
      params.name,
      params.arguments,
    ) as Record<string, unknown>;
  } finally {
    await mcp.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

function writeReadyDispatcherWorkspace(dispatcherId: string): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
    mode: 0o600,
  });
  mkdirSync(defaultDispatcherCwd(dispatcherId), { recursive: true });
}

describe('dreamux cross-module e2e', () => {
  let runtimeDir: string;
  let previousHome: string | undefined;
  let fake: FakeCodex;
  let bot: FakeFeishuBot;
  let server: Server | null;
  let codexInputs: string[];

  beforeEach(async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'dreamux-e2e-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(runtimeDir, 'home');
    process.env['DREAMUX_ROOT'] = join(runtimeDir, 'dreamux');
    writeReadyDispatcherWorkspace('flow');
    // Onboard the canonical sender onto the global allow-user list so a
    // mentioned group message is delivered (empty `allow_users` authorizes
    // nobody under the follow-user gate).
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-test'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    codexInputs = [];
    fake = await startFakeCodex({
      replyFor: captureCodexInputs(codexInputs),
    });
    bot = createFakeFeishuBot('app-e2e');
    server = null;
  });

  afterEach(async () => {
    try {
      await server?.shutdown();
    } catch {
      /* best-effort cleanup */
    }
    await fake?.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('delivers fake Feishu inbound to Codex and replies through the stdio MCP shim', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'please reply', 'msg-e2e-1'));

    await waitFor(() => codexInputs.length === 1);
    expect(codexInputs[0]).toContain('<channel source="feishu"');
    expect(codexInputs[0]).toContain('sender_name="Ada"');
    expect(codexInputs[0]).toContain('please reply');
    // Every delivered inbound ends with the standing channel-reminder so the
    // agent is reminded to answer through the channel reply tool. It rides the
    // body (text alone is discarded for channel turns), so it reaches the model.
    expect(codexInputs[0]).toContain('<channel-reminder>');
    expect(codexInputs[0]).toContain('channel reply tool');
    expect(bot.reactions).toEqual([]);

    const response = await callFeishuMcpTool(runtimeDir, {
      name: 'reply',
      arguments: {
        chat_id: 'chat-group-a',
        message_id: 'msg-e2e-1',
        text: 'reply from MCP',
        mention_user_ids: ['sender-test'],
      },
    });

    expect(response).toEqual({
      content: [],
      structuredContent: { message_ids: ['message-fake-1'] },
    });
    expect(bot.sentMessages).toEqual([
      {
        chatId: 'chat-group-a',
        messageIds: ['message-fake-1'],
        target: {
          chatId: 'chat-group-a',
          replyToMessageId: 'msg-e2e-1',
          mentionUserIds: ['sender-test'],
        },
        text: 'reply from MCP',
      },
    ]);
    expect(bot.reactionOps).toEqual([]);
  });

  it('keeps automatic reactions absent across a server restart', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', 'restart before reply', 'msg-restart'),
    );
    await waitFor(() => codexInputs.length === 1);
    expect((await loadDispatcherAccess(dispatcherDir('flow'))).observed_chats).toEqual([
      'chat-group-a',
    ]);

    await server.shutdown();
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    const response = await callFeishuMcpTool(runtimeDir, {
      name: 'reply',
      arguments: {
        chat_id: 'chat-group-a',
        message_id: 'msg-restart',
        text: 'late reply',
      },
    });

    expect(response).toEqual({
      content: [],
      structuredContent: { message_ids: ['message-fake-1'] },
    });
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.reactions).toEqual([]);
    expect(bot.reactionOps).toEqual([]);
  });

  it('surfaces server status without leaking Feishu secrets', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    const status = await sendAdminRequest(
      'server.status',
      {},
      { socketPath: join(runtimeDir, 'admin.sock') },
    );

    expect(JSON.stringify(status)).toContain('flow');
    expect(JSON.stringify(status)).not.toContain('secret-server-only');
  });
});
