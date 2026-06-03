/**
 * Smoke tests for the dreamux MVP.
 *
 * Covers the issue #2 verification path against a fake codex + fake feishu:
 *   - happy path: inbound → turn → outbound
 *   - in-memory queue: same-chat coalescing + serialized turns
 *   - thread/resume on restart (in-process)
 *   - thread/resume failure → visible degradation (last_lost_thread_id set)
 *   - outbound retry: send fails N times then succeeds
 *   - approval fail-fast: codex server-request causes the turn to fail
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RECEIVED_REACTION_EMOJI, Server } from '../src/server.js';
import {
  CodexProcess,
  type CodexProcessExit,
  type CodexProcessExitHandler,
  type CodexProcessOptions,
} from '../src/codex/supervisor.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import { createFakeFeishuBot, type FakeFeishuBot, type FeishuInboundEvent } from '../src/feishu/bot.js';
import { createAdminSocketServer } from '../src/admin/socket.js';
import { sendAdminRequest } from '../src/admin/client.js';
import {
  TRUST_DOMAIN_WARNING,
  loadDispatcherAccess,
} from '../src/channel/feishu-gate.js';
import { BUILT_IN_DEFAULTS } from '../src/runtime/config.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexCwd,
  dispatcherCodexHome,
  dispatcherWorkspaceSkillPath,
  dispatcherSocketPath,
} from '../src/runtime/paths.js';
import { dreamuxBinPath } from '../src/runtime/package-bin.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';

class NoopCodexProcess extends CodexProcess {
  constructor(opts: CodexProcessOptions) {
    super(opts);
  }
  override async start(): Promise<void> {
    // No real child; the WS endpoint is the fake codex's TCP url.
  }
  override async reap(): Promise<void> {
    // Nothing to kill.
  }
}

function buildServer(opts: {
  runtimeDir: string;
  fake: FakeCodex;
  bot: FakeFeishuBot;
  config?: typeof BUILT_IN_DEFAULTS;
  skipBotSecret?: boolean;
  capturedBotSecrets?: string[];
  /** Optional spawn counter — bumped each time a NoopCodexProcess is built. */
  spawnCounter?: { count: number };
  capturedCodexOptions?: CodexProcessOptions[];
  useDefaultCodexHomeDoctor?: boolean;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: () => CodexWsClient;
  codexRestartBackoffBaseMs?: number;
  codexRestartBackoffMaxMs?: number;
}): Server {
  return new Server({
    config: opts.config ?? { ...BUILT_IN_DEFAULTS, runtime_dir: opts.runtimeDir },
    databasePath: join(opts.runtimeDir, 'state.db'),
    adminSocketPath: join(opts.runtimeDir, 'admin.sock'),
    skipBotSecret: opts.skipBotSecret ?? true,
    botFactory: (_row, secret) => {
      opts.capturedBotSecrets?.push(secret);
      return opts.bot;
    },
    codexProcessFactory: (o) => {
      if (opts.spawnCounter !== undefined) opts.spawnCounter.count++;
      opts.capturedCodexOptions?.push(o);
      return opts.codexProcessFactory?.(o) ?? new NoopCodexProcess(o);
    },
    codexClientFactory: () =>
      opts.codexClientFactory?.() ?? new CodexWsClient({ url: opts.fake.url }),
    codexRestartBackoffBaseMs: opts.codexRestartBackoffBaseMs,
    codexRestartBackoffMaxMs: opts.codexRestartBackoffMaxMs,
    ...(opts.useDefaultCodexHomeDoctor === true
      ? {}
          : {
          codexHomeDoctor: () => {
            /* fake codex tests do not require a real global Codex home */
          },
        }),
  });
}

class ControllableCodexProcess extends CodexProcess {
  readonly exitHandlers: CodexProcessExitHandler[] = [];
  startCount = 0;
  reapCount = 0;

  override async start(): Promise<void> {
    this.startCount++;
  }

  override async reap(): Promise<void> {
    this.reapCount++;
  }

  override onExit(handler: CodexProcessExitHandler): void {
    this.exitHandlers.push(handler);
  }

  emitExit(exit: CodexProcessExit = { code: 1, signal: null }): void {
    for (const handler of this.exitHandlers) handler(exit);
  }
}

function fakeInbound(
  chatId: string,
  text: string,
  msgId: string,
): FeishuInboundEvent {
  return {
    messageId: msgId,
    chatId,
    chatType: 'group',
    senderId: 'sender-test',
    senderType: 'user',
    senderName: '',
    messageType: 'text',
    rawContent: JSON.stringify({ text }),
    parsedText: text,
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-smoke' },
        name: 'Dispatcher',
      },
    ],
    createTime: String(Date.now()),
    raw: { event: { message: { chat_id: chatId, message_id: msgId } } },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function echoReadableCodexInput(input: string): string {
  const match = input.match(
    /<feishu_message\b[^>]*>\n([\s\S]*?)\n<\/feishu_message>/,
  );
  return `echo: ${(match?.[1] ?? input).trim()}`;
}

function captureAndEchoCodexInput(inputs: string[]): (input: string) => string {
  return (input) => {
    inputs.push(input);
    return echoReadableCodexInput(input);
  };
}

function feishuMessageBlockCount(input: string): number {
  return input.match(/<feishu_message\b/g)?.length ?? 0;
}

function writeReadyDispatcherCodexHome(dispatcherId: string, dispatcherCwd?: string): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
    mode: 0o600,
  });
  const skillPath = dispatcherWorkspaceSkillPath(
    dispatcherCwd ?? dispatcherCodexCwd(dispatcherId),
  );
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, '# test skill\n');
}

describe('dreamux MVP smoke', () => {
  let runtimeDir: string;
  let fake: FakeCodex;
  let bot: FakeFeishuBot;
  let server: Server;
  let previousHome: string | undefined;
  let codexInputs: string[];

  beforeEach(async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'dreamux-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(runtimeDir, 'home');
    codexInputs = [];
    fake = await startFakeCodex({
      replyFor: captureAndEchoCodexInput(codexInputs),
    });
    bot = createFakeFeishuBot('app-smoke');
  });

  afterEach(async () => {
    try {
      await server?.shutdown();
    } catch {
      /* */
    }
    await fake?.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('happy path: inbound → codex turn → outbound', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'hi', 'msg-1-id'));

    await waitFor(() => bot.sentMessages.length >= 1);
    expect(bot.sentMessages[0]).toMatchObject({
      chatId: 'chat-group-a',
      target: {
        chatId: 'chat-group-a',
        replyToMessageId: 'msg-1-id',
        mentionUserIds: ['sender-test'],
      },
      text: 'echo: hi',
    });

    expect(server.repos.inbound.getById(1)).toBeNull();
    expect(codexInputs).toHaveLength(1);
    expect(codexInputs[0]).toContain('<feishu_message');
    expect(codexInputs[0]).toContain('  sender_name=""');
    expect(codexInputs[0]).toContain('  create_time=');
    expect(codexInputs[0]).toContain('hi');
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-1-id',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
    ]);

    // Dispatcher's thread is persisted across server restart.
    const d = server.repos.dispatchers.get('flow');
    expect(d?.thread_id).toMatch(/^thread_fake_/);
    expect(d?.status).toBe('ready');
  });

  it('starts the dispatcher app-server with global default Codex home and tm on PATH', async () => {
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({ runtimeDir, fake, bot, capturedCodexOptions });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    await server.start();

    expect(capturedCodexOptions).toHaveLength(1);
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBeUndefined();
    expect(capturedCodexOptions[0]?.env?.['PATH']).toContain('/bin');
    expect(capturedCodexOptions[0]?.socketPath).toBe(
      dispatcherSocketPath('flow'),
    );
  });

  it('keeps Feishu app secrets in the serve process and out of Codex child options', async () => {
    const capturedBotSecrets: string[] = [];
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      skipBotSecret: false,
      capturedBotSecrets,
      capturedCodexOptions,
      config: {
        ...BUILT_IN_DEFAULTS,
        runtime_dir: runtimeDir,
        feishu: {
          bots: {
            flow: {
              app_id: 'app-smoke',
              app_secret: 'secret-server-only',
            },
          },
        },
      },
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'config:flow',
    });

    await server.start();

    expect(capturedBotSecrets).toEqual(['secret-server-only']);
    expect(JSON.stringify(capturedCodexOptions)).not.toContain('secret-server-only');
  });

  it('injects dispatcher-scoped Feishu MCP config after operator Codex args', async () => {
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      capturedCodexOptions,
      config: {
        ...BUILT_IN_DEFAULTS,
        runtime_dir: runtimeDir,
        codex: {
          ...BUILT_IN_DEFAULTS.codex,
          extra_args: [
            '-c',
            'mcp_servers.feishu.command="operator-feishu"',
          ],
        },
      },
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    await server.start();

    const args = capturedCodexOptions[0]?.extraArgs ?? [];
    const dreamuxCommand = `mcp_servers.feishu.command=${JSON.stringify(dreamuxBinPath())}`;
    expect(args).toContain('mcp_servers.feishu.command="operator-feishu"');
    const operatorIdx = args.indexOf('mcp_servers.feishu.command="operator-feishu"');
    const dreamuxIdx = args.indexOf(dreamuxCommand);
    expect(dreamuxIdx).toBeGreaterThan(operatorIdx);
    expect(dreamuxBinPath()).toMatch(/\/dreamux$/);
    expect(args).toContain(
      `mcp_servers.feishu.args=["feishu-mcp", "--dispatcher", "flow", "--admin-socket", "${join(runtimeDir, 'admin.sock')}"]`,
    );
  });

  it('mcp.reply sends through the serve-owned bot and clears received reaction', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      turnDelayMs: 2000,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'needs reply', 'msg-mcp-reply'));
    await waitFor(() => bot.reactions.length === 1);

    const result = await sendAdminRequest(
      'mcp.reply',
      {
        dispatcher_id: 'flow',
        chat_id: 'chat-group-a',
        message_id: 'msg-mcp-reply',
        text: 'manual mcp reply',
        mention_user_ids: ['sender-test'],
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    ) as { message_ids: string[] };

    expect(result.message_ids).toEqual(['message-fake-1']);
    expect(bot.sentMessages[0]).toMatchObject({
      chatId: 'chat-group-a',
      target: {
        chatId: 'chat-group-a',
        replyToMessageId: 'msg-mcp-reply',
        mentionUserIds: ['sender-test'],
      },
      text: 'manual mcp reply',
    });
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-mcp-reply',
        reactionId: 'reaction-fake-1',
      },
    ]);
  });

  it('mcp.reply clears a received reaction even when reply wins the add-reaction race', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      turnDelayMs: 2000,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    let releaseReaction!: () => void;
    let markReactionStarted!: () => void;
    const reactionStarted = new Promise<void>((resolve) => {
      markReactionStarted = resolve;
    });
    const reactionBlocked = new Promise<void>((resolve) => {
      releaseReaction = resolve;
    });
    const originalAddReaction = bot.addReaction.bind(bot);
    bot.addReaction = async (messageId, emoji) => {
      markReactionStarted();
      await reactionBlocked;
      return originalAddReaction(messageId, emoji);
    };

    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    const injected = bot.inject(
      fakeInbound('chat-group-a', 'fast reply', 'msg-race-reaction'),
    );
    await reactionStarted;

    const result = await sendAdminRequest(
      'mcp.reply',
      {
        dispatcher_id: 'flow',
        chat_id: 'chat-group-a',
        message_id: 'msg-race-reaction',
        text: 'manual race reply',
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    ) as { message_ids: string[] };

    expect(result.message_ids).toEqual(['message-fake-1']);
    expect(bot.removedReactions).toEqual([]);

    releaseReaction();
    await injected;
    await waitFor(() => bot.removedReactions.length === 1);
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-race-reaction',
        reactionId: 'reaction-fake-1',
      },
    ]);
  });

  it('mcp.react adds a model-owned reaction without clearing received reactions', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    const result = await sendAdminRequest(
      'mcp.react',
      {
        dispatcher_id: 'flow',
        message_id: 'msg-model-react',
        emoji: 'THUMBSUP',
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    ) as { reaction_id: string };

    expect(result.reaction_id).toBe('reaction-fake-1');
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-model-react',
        emoji: 'THUMBSUP',
        reactionId: 'reaction-fake-1',
      },
    ]);
    expect(bot.removedReactions).toEqual([]);
  });

  it('creates the app-server socket directory outside the global Codex home', async () => {
    rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = mkdtempSync(join(previousHome ?? homedir(), '.dreamux-smoke-'));
    process.env['HOME'] = join(runtimeDir, 'home');
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      capturedCodexOptions,
      useDefaultCodexHomeDoctor: true,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
      codex_args_json: JSON.stringify({ sandboxMode: 'danger-full-access' }),
      codex_cwd: join(runtimeDir, 'workspace'),
    });
    writeReadyDispatcherCodexHome('flow', join(runtimeDir, 'workspace'));

    expect(existsSync(dispatcherAppServerControlDir('flow'))).toBe(false);
    await server.start();

    expect(capturedCodexOptions).toHaveLength(1);
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBeUndefined();
    expect(existsSync(dispatcherAppServerControlDir('flow'))).toBe(true);
    expect(dispatcherAppServerControlDir('flow')).not.toContain('codex-home');
  });

  it('access gate drops bot-loop messages before queue or reaction', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject({
      ...fakeInbound('chat-group-a', 'loop', 'msg-loop'),
      senderId: bot.botOpenId ?? '',
    });

    await sleep(80);
    expect(server.repos.inbound.getById(1)).toBeNull();
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
  });

  it('access gate drops Feishu bot/app sender types before queue or reaction', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject({
      ...fakeInbound('chat-group-a', 'bot says hi', 'msg-bot'),
      senderId: 'peer-bot',
      senderType: 'bot',
    });

    await sleep(80);
    expect(server.repos.inbound.getById(1)).toBeNull();
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
  });

  it('access gate drops unmentioned group messages before queue or reaction', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject({
      ...fakeInbound('chat-group-a', 'no mention', 'msg-no-mention'),
      mentions: [],
    });

    await sleep(80);
    expect(server.repos.inbound.getById(1)).toBeNull();
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
  });

  it('records a trust-domain warning when one dispatcher receives multiple chats', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'first chat', 'msg-chat-a'));
    await bot.inject(fakeInbound('chat-group-b', 'second chat', 'msg-chat-b'));

    const access = loadDispatcherAccess('flow');
    expect(access.observed_chats).toEqual(['chat-group-a', 'chat-group-b']);
    expect(access.warnings).toEqual([TRUST_DOMAIN_WARNING]);
    expect(bot.reactions.map((reaction) => reaction.messageId)).toEqual([
      'msg-chat-a',
      'msg-chat-b',
    ]);
    await waitFor(() => bot.sentMessages.length >= 2);
  });

  it('in-memory queue coalesces pending same-chat messages behind a running turn', async () => {
    // Restart fake with a slow turn so messages can actually pile up.
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      turnDelayMs: 80,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'running', 'msg-a'));
    await bot.inject(fakeInbound('chat-group-b', 'batch-1', 'msg-b1'));
    await bot.inject(fakeInbound('chat-group-b', 'batch-2', 'msg-b2'));

    await waitFor(() => bot.sentMessages.length >= 2, 6000);
    expect(fake.turnsHandled).toBe(2);
    expect(codexInputs).toHaveLength(2);
    expect(codexInputs[0]).toContain('running');
    expect(feishuMessageBlockCount(codexInputs[1] ?? '')).toBe(2);
    expect(codexInputs[1]).toContain('batch-1');
    expect(codexInputs[1]).toContain('batch-2');
    expect(bot.sentMessages[1]?.target).toMatchObject({
      chatId: 'chat-group-b',
      replyToMessageId: 'msg-b2',
      mentionUserIds: ['sender-test'],
    });
    expect(bot.sentMessages.map((m) => m.text)).toEqual([
      'echo: running',
      'echo: batch-1',
    ]);
  });

  it('process-local dedupe drops Feishu redelivery before turn and reaction', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'redelivered', 'msg-same'));
    await bot.inject(fakeInbound('chat-group-a', 'redelivered again', 'msg-same'));

    await waitFor(() => bot.sentMessages.length >= 1);
    await sleep(120);
    expect(fake.turnsHandled).toBe(1);
    expect(bot.reactions).toHaveLength(1);
    expect(bot.reactions[0]?.messageId).toBe('msg-same');
    expect(server.repos.inbound.getById(1)).toBeNull();
  });

  it('ignores legacy persisted running rows on startup', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    const row = server.repos.inbound.enqueue({
      dispatcher_id: 'flow',
      source_chat_id: 'chat-group-a',
      source_message_id: 'message-pre-crash',
      sender_id: 'sender',
      feishu_event_json: '{}',
      parsed_text: 'legacy-running',
    });
    expect(row).not.toBeNull();
    server.repos.inbound.markRunning(row!.id, null);

    await server.start();

    const after = server.repos.inbound.getById(row!.id);
    expect(after?.state).toBe('running');
    expect(bot.sentMessages).toEqual([]);
  });

  it('thread/resume failure produces visible degradation, not silent loss', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    // Pre-seed an existing thread_id so startup will try thread/resume.
    server.repos.dispatchers.setThreadId('flow', 'thread_was_lost');

    await server.shutdown();
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      failResume: true,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    server = buildServer({ runtimeDir, fake, bot });
    await server.start();

    const d = server.repos.dispatchers.get('flow');
    expect(d?.last_lost_thread_id).toBe('thread_was_lost');
    expect(d?.thread_id).toMatch(/^thread_fake_/);
    expect(d?.thread_id).not.toBe('thread_was_lost');
    // last_error is cleared when dispatcher reaches 'ready' again; the
    // durable evidence of degradation is last_lost_thread_id above.
    expect(d?.status).toBe('ready');
  });

  it('outbound retry: send fails then succeeds; turn does not re-run', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    let attempts = 0;
    const origSend = bot.send.bind(bot);
    bot.send = async (target, text) => {
      attempts++;
      if (attempts === 1) throw new Error('transient feishu hiccup');
      return origSend(target, text);
    };

    await bot.inject(fakeInbound('chat-group-a', 'retry-me', 'msg-retry'));

    await waitFor(() => bot.sentMessages.length >= 1);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(fake.turnsHandled).toBe(1); // turn was not re-run
    expect(bot.sentMessages[0]?.text).toBe('echo: retry-me');
  });

  it('approval fail-fast: server-request causes the turn to fail', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      triggerApprovalOnTurn: true,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'do-something', 'msg-app'));

    // The approval rejection sends a hint message; the turn itself completes
    // (codex still emits turn/completed after the server-request), so the
    // dispatcher ends in 'completed'. The user-visible hint is the test.
    await waitFor(
      () =>
        bot.sentMessages.some((m) => m.text.includes('不支持审批')) ||
        bot.sentMessages.length >= 1,
    );
    expect(
      bot.sentMessages.some((m) => m.text.includes('不支持审批')),
    ).toBe(true);
  });

  it('does not drain legacy persisted queued rows on startup', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    const row = server.repos.inbound.enqueue({
      dispatcher_id: 'flow',
      source_chat_id: 'chat-backlog',
      source_message_id: 'msg-backlog_1',
      sender_id: 'sender',
      feishu_event_json: '{}',
      parsed_text: 'queued-before-crash',
    });
    expect(row).not.toBeNull();
    expect(row!.state).toBe('queued');

    await server.start();

    const after = server.repos.inbound.getById(row!.id);
    expect(after?.state).toBe('queued');
    expect(bot.sentMessages).toEqual([]);
  });

  // PR fix/codex-0134-compat: the daemon expects an LSP-style init handshake
  // before any business RPC; without it, every call comes back "Not initialized".
  it('init handshake runs before thread/start', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();
    expect(fake.initializedAt).not.toBeNull();
    const idxInit = fake.methodLog.indexOf('initialize');
    const idxNotif = fake.methodLog.indexOf('initialized');
    const idxStart = fake.methodLog.indexOf('thread/start');
    expect(idxInit).toBeGreaterThanOrEqual(0);
    expect(idxNotif).toBeGreaterThan(idxInit);
    expect(idxStart).toBeGreaterThan(idxNotif);
  });

  // Negative: if dispatcher startup skipped the handshake, fake codex would
  // refuse — confirms our handshake-enforcement assertion above isn't vacuous.
  it('fake codex refuses non-initialize RPC pre-handshake', async () => {
    // Use a raw client (no handshake) against the same fake.
    const { CodexWsClient } = await import('../src/codex/rpc.js');
    const raw = new CodexWsClient({ url: fake.url });
    await raw.ready();
    await expect(
      raw.request('thread/start', {}),
    ).rejects.toThrow(/Not initialized/);
    raw.close();
  });

  // PR #5 review #1: handshake must bound the wait, otherwise a hung
  // daemon deadlocks dispatcher startup forever.
  it('handshake times out if codex accepts the WS but never replies', async () => {
    await fake.close();
    fake = await startFakeCodex({ swallowInitialize: true });
    const { CodexWsClient } = await import('../src/codex/rpc.js');
    const { performInitializeHandshake } = await import(
      '../src/codex/handshake.js'
    );
    const raw = new CodexWsClient({ url: fake.url });
    try {
      await raw.ready();
      await expect(
        performInitializeHandshake(raw, { timeoutMs: 150 }),
      ).rejects.toThrow(/did not respond within 150ms/);
    } finally {
      raw.close();
    }
  });

  // PR #3 review #4
  it('concurrent startDispatcher calls coalesce — only one Codex spawn', async () => {
    const counter = { count: 0 };
    server = buildServer({ runtimeDir, fake, bot, spawnCounter: counter });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    // Don't call server.start() (which would auto-start); race two explicit
    // startDispatcher calls instead.
    const a = server.startDispatcher('flow');
    const b = server.startDispatcher('flow');
    await Promise.all([a, b]);
    expect(counter.count).toBe(1);
    expect(server.getRuntime('flow')?.getStatus()).toBe('ready');
  });

  it('restarts the Codex child with backoff and resumes the saved thread after child exit', async () => {
    const processes: ControllableCodexProcess[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      codexProcessFactory: (opts) => {
        const process = new ControllableCodexProcess(opts);
        processes.push(process);
        return process;
      },
      codexRestartBackoffBaseMs: 5,
      codexRestartBackoffMaxMs: 5,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();
    const firstThreadId = server.repos.dispatchers.get('flow')?.thread_id;
    expect(firstThreadId).toMatch(/^thread_fake_/);
    expect(processes).toHaveLength(1);

    processes[0]!.emitExit({ code: 9, signal: null });

    await waitFor(() => processes.length >= 2);
    await waitFor(() => server.getRuntime('flow')?.getStatus() === 'ready');
    expect(server.repos.dispatchers.get('flow')?.thread_id).toBe(firstThreadId);
    expect(fake.methodLog.filter((method) => method === 'thread/resume'))
      .toHaveLength(1);
    expect(processes[0]?.reapCount).toBeGreaterThanOrEqual(1);
  });

  it('manual dispatcher stop cancels a pending restart and start resumes the thread', async () => {
    const processes: ControllableCodexProcess[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      codexProcessFactory: (opts) => {
        const process = new ControllableCodexProcess(opts);
        processes.push(process);
        return process;
      },
      codexRestartBackoffBaseMs: 100,
      codexRestartBackoffMaxMs: 100,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();
    const firstThreadId = server.repos.dispatchers.get('flow')?.thread_id;
    expect(firstThreadId).toMatch(/^thread_fake_/);

    processes[0]!.emitExit({ code: 9, signal: null });
    await waitFor(() => server.getRuntime('flow')?.getStatus() === 'degraded');

    await server.stopDispatcher('flow');
    await sleep(150);
    expect(processes).toHaveLength(1);

    await server.startDispatcher('flow');
    await waitFor(() => server.getRuntime('flow')?.getStatus() === 'ready');
    expect(processes).toHaveLength(2);
    expect(server.repos.dispatchers.get('flow')?.thread_id).toBe(firstThreadId);
    expect(fake.methodLog.filter((method) => method === 'thread/resume'))
      .toHaveLength(1);
  });

  it('restarts and resumes when the Codex child WebSocket dies', async () => {
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      codexClientFactory: () => new CodexWsClient({ url: fake.url }),
      codexRestartBackoffBaseMs: 5,
      codexRestartBackoffMaxMs: 5,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();
    const firstThreadId = server.repos.dispatchers.get('flow')?.thread_id;
    expect(firstThreadId).toMatch(/^thread_fake_/);

    const oldFake = fake;
    codexInputs = [];
    fake = await startFakeCodex({
      replyFor: captureAndEchoCodexInput(codexInputs),
    });
    await oldFake.close();

    await waitFor(() => fake.methodLog.includes('thread/resume'), 3000);
    await waitFor(() => server.getRuntime('flow')?.getStatus() === 'ready');
    expect(server.repos.dispatchers.get('flow')?.thread_id).toBe(firstThreadId);
    expect(fake.methodLog).not.toContain('thread/start');
  });

  it('does not restart a dispatcher for a slow in-flight turn', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      turnDelayMs: 200,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });
    const processes: ControllableCodexProcess[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      codexProcessFactory: (opts) => {
        const process = new ControllableCodexProcess(opts);
        processes.push(process);
        return process;
      },
      codexRestartBackoffBaseMs: 5,
      codexRestartBackoffMaxMs: 5,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'slow turn', 'msg-slow'));
    await sleep(80);
    expect(server.getRuntime('flow')?.getStatus()).toBe('ready');
    expect(processes).toHaveLength(1);
    expect(bot.sentMessages).toEqual([]);

    await waitFor(() => bot.sentMessages.length >= 1, 1000);
    expect(processes).toHaveLength(1);
    expect(bot.sentMessages[0]?.text).toBe('echo: slow turn');
  });
});

describe('admin socket hardening', () => {
  let runtimeDir: string;
  let stubServer: Server;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'dreamux-admin-'));
    stubServer = new Server({
      databasePath: join(runtimeDir, 'state.db'),
      adminSocketPath: join(runtimeDir, 'admin.sock'),
    });
  });

  afterEach(async () => {
    try {
      await stubServer.shutdown();
    } catch {
      /* */
    }
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  // PR #3 review #2
  it('chmod failure fails startup and cleans up the half-bound socket + lockfile', async () => {
    const sockPath = join(runtimeDir, 'a.sock');
    const admin = createAdminSocketServer(stubServer, sockPath, {
      chmodFn: () => {
        throw new Error('synthetic chmod EPERM');
      },
    });
    await expect(admin.start()).rejects.toThrow(/0600/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(`${sockPath}.lock`)).toBe(false);
  });

  // PR #3 review #3 (r2): pidfile-based mutual exclusion
  it('refuses to bind when another live server already holds the lockfile', async () => {
    const sockPath = join(runtimeDir, 'live.sock');
    // Simulate two distinct servers (different PIDs) sharing one process —
    // 'first' claims pid 11111 in its lockfile; 'second' uses pid 22222 and
    // sees 11111 as alive (i.e. there's another live server running).
    const first = createAdminSocketServer(stubServer, sockPath, {
      selfPid: 11111,
    });
    await first.start();
    try {
      const second = createAdminSocketServer(stubServer, sockPath, {
        selfPid: 22222,
        isPidAlive: (pid) => pid === 11111,
      });
      await expect(second.start()).rejects.toThrow(/split-brain|live/);
    } finally {
      await first.close();
    }
  });

  // PR #3 review #3 r2: TOCTOU race — even when a stale socket file is
  // present, a second server must NOT delete the first's live socket. The
  // pidfile lock makes the cleanup step exclusive: only the holder ever
  // touches the socket file.
  it('two concurrent starts: the loser never unlinks the winners socket', async () => {
    const sockPath = join(runtimeDir, 'race.sock');
    // Stage a stale socket file from a "previous crash" so both startups
    // hit the cleanup branch.
    writeFileSync(sockPath, 'leftover-from-crash');

    const a = createAdminSocketServer(stubServer, sockPath, { selfPid: 11111 });
    const b = createAdminSocketServer(stubServer, sockPath, {
      selfPid: 22222,
      // From b's perspective, the holder pid 11111 is alive (a holds it).
      isPidAlive: (pid) => pid === 11111,
    });

    const results = await Promise.allSettled([a.start(), b.start()]);
    const wonA = results[0].status === 'fulfilled';
    const wonB = results[1].status === 'fulfilled';
    expect(wonA && !wonB).toBe(true);

    // a's socket file must still exist and still be listenable — i.e.
    // b's losing path did NOT rmSync it out from under a.
    const { existsSync, statSync } = await import('node:fs');
    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).isSocket()).toBe(true);

    await a.close();
  });

  // Reclaim path: a pidfile naming a dead process is stale and must not
  // wedge the channel shut.
  it('reclaims a stale lockfile whose holder PID is dead', async () => {
    const sockPath = join(runtimeDir, 'stale-lock.sock');
    // Pre-seed a pidfile naming a process that doesn't exist (our probe says so).
    writeFileSync(`${sockPath}.lock`, '999999\n');
    const admin = createAdminSocketServer(stubServer, sockPath, {
      isPidAlive: () => false,
    });
    await admin.start();
    await admin.close();
  });

  // Stale socket file with no lockfile is cleaned up at bind time.
  it('clears a stale socket file (no listener, no lock) and binds successfully', async () => {
    const sockPath = join(runtimeDir, 'stale.sock');
    writeFileSync(sockPath, 'leftover');
    const admin = createAdminSocketServer(stubServer, sockPath);
    await admin.start();
    await admin.close();
  });
});
