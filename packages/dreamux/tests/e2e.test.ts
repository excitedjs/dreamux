import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
  Server,
} from '../src/server.js';
import { sendAdminRequest } from '../src/admin/client.js';
import {
  loadDispatcherAccess,
  saveDispatcherAccess,
} from '../src/channel/feishu-gate.js';
import { builtinFeishuChannelProvider } from '../src/channel/feishu-provider.js';
import {
  CHANNEL_CAPABILITY,
  ChannelCapabilityError,
  type ChannelProvider,
} from '../src/channel/provider.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from '../src/codex/supervisor.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
  type FeishuInboundEvent,
} from '../src/feishu/bot.js';
import { runFeishuMcp } from '../src/mcp/feishu-mcp.js';
import { BUILT_IN_DEFAULTS, type DreamuxConfig } from '../src/runtime/config.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import {
  dispatcherCodexCwd,
  dispatcherCodexHome,
} from '../src/runtime/paths.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';
import { testDispatcherConfig } from './helpers/config.js';

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

class JsonLineReader {
  private buffer = '';
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(stream: PassThrough) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  next(): Promise<unknown> {
    const line = this.shiftLine();
    if (line !== null) return Promise.resolve(JSON.parse(line));
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const line = this.shiftLine();
      if (line === null) return;
      this.waiters.shift()!(JSON.parse(line));
    }
  }

  private shiftLine(): string | null {
    const idx = this.buffer.indexOf('\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    return line;
  }
}

function configWithDispatcher(): DreamuxConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    dispatchers: [
      testDispatcherConfig({
        id: 'flow',
        cwd: null,
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
      }),
    ],
  };
}

function buildServer(opts: {
  runtimeDir: string;
  fake: FakeCodex;
  bot: FakeFeishuBot;
  channelProviderResolver?: (ref: string) => ChannelProvider;
}): Server {
  return new Server({
    config: configWithDispatcher(),
    adminSocketPath: join(opts.runtimeDir, 'admin.sock'),
    skipBotSecret: true,
    botFactory: () => opts.bot,
    ...(opts.channelProviderResolver !== undefined
      ? { channelProviderResolver: opts.channelProviderResolver }
      : {}),
    codexProcessFactory: (o) => new NoopCodexProcess(o),
    codexClientFactory: () => new CodexWsClient({ url: opts.fake.url }),
    codexHomeDoctor: () => {
      /* fake Codex tests do not require real operator Codex auth */
    },
  });
}

/**
 * A channel provider that exposes no reply/react capability (an inbound-only
 * channel). It wraps the real Feishu provider so the dispatcher still starts and
 * gates inbound, but core must refuse model-driven outbound through it.
 */
function inboundOnlyChannelProvider(): ChannelProvider {
  const registry = createBuiltinProviderRegistry();
  const base = builtinFeishuChannelProvider(registry.resolve('builtin:feishu'));
  return {
    ref: base.ref,
    descriptor: base.descriptor,
    hasCapability: (kind) =>
      kind !== CHANNEL_CAPABILITY.reply &&
      kind !== CHANNEL_CAPABILITY.react &&
      base.hasCapability(kind),
    mcpServerDescriptors: base.mcpServerDescriptors,
    createConnection: base.createConnection,
    access: base.access,
  };
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
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runFeishuMcp({
    dispatcherId: 'flow',
    adminSocketPath: join(runtimeDir, 'admin.sock'),
    input,
    output,
    log: () => {},
  });

  writeJson(input, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  expect(await reader.next()).toMatchObject({
    id: 1,
    result: { protocolVersion: '2025-06-18' },
  });

  writeJson(input, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params,
  });
  const response = await reader.next() as Record<string, unknown>;
  input.end();
  await run;
  return response;
}

function writeJson(input: PassThrough, value: unknown): void {
  input.write(`${JSON.stringify(value)}\n`);
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
  mkdirSync(dispatcherCodexCwd(dispatcherId), { recursive: true });
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
    writeReadyDispatcherWorkspace('flow');
    // Onboard the canonical sender onto the global allow-user list so a
    // mentioned group message is delivered (empty `allow_users` authorizes
    // nobody under the follow-user gate).
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      observed_chats: [],
      warnings: [],
      last_gate: null,
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
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('refuses model-driven reply/react when the channel provider exposes no such capability', async () => {
    // An inbound-only channel provider starts the dispatcher and gates inbound,
    // but core must not assume it is two-way: reply/react fail loudly with
    // ChannelCapabilityError rather than calling a missing capability.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelProviderResolver: () => inboundOnlyChannelProvider(),
    });
    await server.start();

    await expect(
      server.replyFromMcp({
        dispatcherId: 'flow',
        chatId: 'chat-group-a',
        text: 'should be refused',
      }),
    ).rejects.toThrow(ChannelCapabilityError);
    await expect(
      server.reactFromMcp({
        dispatcherId: 'flow',
        messageId: 'msg-e2e-1',
        emoji: 'OK',
      }),
    ).rejects.toThrow(ChannelCapabilityError);
    expect(bot.sentMessages).toHaveLength(0);
    expect(bot.reactions).toHaveLength(0);
  });

  it('delivers a TeamMate completion into the Codex dispatcher thread, then is pull-able', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    const scheduled = await server.scheduleTeamMateFromMcp({
      dispatcherId: 'flow',
      callerKind: 'dispatcher',
      title: 'Summarize',
      prompt: 'summarize the issue',
      teammateId: 'reviewer-1',
    });
    const report = await server.reportTeamMateCompletion({
      dispatcherId: 'flow',
      taskId: scheduled.task_id,
      outcome: 'completed',
      finalText: 'TEAMMATE-RESULT-MARKER',
    });
    expect(report.status).toBe('delivered');

    // Codex delivery = inbox + turn trigger: the completion arrives as a turn.
    await waitFor(() =>
      codexInputs.some((input) => input.includes('TEAMMATE-RESULT-MARKER')),
    );
    expect(
      codexInputs.some((input) => input.includes('<teammate_task_completion')),
    ).toBe(true);

    // And it is retrievable via the pull path.
    const pulled = await server.pullTeamMateResultFromMcp('flow', scheduled.task_id);
    expect(pulled).toMatchObject({
      task_id: scheduled.task_id,
      status: 'delivered',
      outcome: 'completed',
      text: 'TEAMMATE-RESULT-MARKER',
      delivered: true,
    });
  });

  it('delivers fake Feishu inbound to Codex and replies through the stdio MCP shim', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'please reply', 'msg-e2e-1'));

    await waitFor(() => codexInputs.length === 1);
    await waitFor(() => bot.reactions.length === 2);
    expect(codexInputs[0]).toContain('<feishu_message');
    expect(codexInputs[0]).toContain('sender_name="Ada"');
    expect(codexInputs[0]).toContain('please reply');
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-e2e-1',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
      {
        messageId: 'msg-e2e-1',
        emoji: IN_PROGRESS_REACTION_EMOJI,
        reactionId: 'reaction-fake-2',
      },
    ]);

    const response = await callFeishuMcpTool(runtimeDir, {
      name: 'reply',
      arguments: {
        chat_id: 'chat-group-a',
        message_id: 'msg-e2e-1',
        text: 'reply from MCP',
        mention_user_ids: ['sender-test'],
      },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        structuredContent: { message_ids: ['message-fake-1'] },
      },
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
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-e2e-1',
        reactionId: 'reaction-fake-1',
      },
      {
        messageId: 'msg-e2e-1',
        reactionId: 'reaction-fake-2',
      },
    ]);
  });

  it('keeps received-reaction cleanup process-local across a server restart', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', 'restart before reply', 'msg-restart'),
    );
    await waitFor(() => codexInputs.length === 1);
    await waitFor(() => bot.reactions.length === 2);
    expect((await loadDispatcherAccess('flow')).observed_chats).toEqual([
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

    expect(response).toMatchObject({
      result: {
        structuredContent: { message_ids: ['message-fake-1'] },
      },
    });
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-restart',
        reactionId: 'reaction-fake-1',
      },
    ]);
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-restart',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
      {
        messageId: 'msg-restart',
        emoji: IN_PROGRESS_REACTION_EMOJI,
        reactionId: 'reaction-fake-2',
      },
    ]);
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
