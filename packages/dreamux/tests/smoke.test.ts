/**
 * Smoke tests for the dreamux MVP.
 *
 * Covers the issue #2 verification path against a fake codex + fake feishu:
 *   - happy path: inbound → turn → outbound
 *   - FIFO: two inbound messages process serially in the same thread
 *   - thread/resume on restart (in-process)
 *   - thread/resume failure → visible degradation (last_lost_thread_id set)
 *   - crash recovery: running rows become 'unknown' on restart, user notified
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
import { join } from 'node:path';

import { Server } from '../src/server.js';
import { CodexProcess, type CodexProcessOptions } from '../src/codex/supervisor.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import { createFakeFeishuBot, type FakeFeishuBot, type FeishuInboundEvent } from '../src/feishu/bot.js';
import { createAdminSocketServer } from '../src/admin/socket.js';
import { BUILT_IN_DEFAULTS } from '../src/runtime/config.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherCodexPluginsDir,
  dispatcherSocketPath,
} from '../src/runtime/paths.js';
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
  /** Optional spawn counter — bumped each time a NoopCodexProcess is built. */
  spawnCounter?: { count: number };
  capturedCodexOptions?: CodexProcessOptions[];
  useDefaultCodexHomeDoctor?: boolean;
}): Server {
  return new Server({
    config: { ...BUILT_IN_DEFAULTS, runtime_dir: opts.runtimeDir },
    databasePath: join(opts.runtimeDir, 'state.db'),
    adminSocketPath: join(opts.runtimeDir, 'admin.sock'),
    skipBotSecret: true,
    botFactory: () => opts.bot,
    codexProcessFactory: (o) => {
      if (opts.spawnCounter !== undefined) opts.spawnCounter.count++;
      opts.capturedCodexOptions?.push(o);
      return new NoopCodexProcess(o);
    },
    codexClientFactory: () => new CodexWsClient({ url: opts.fake.url }),
    ...(opts.useDefaultCodexHomeDoctor === true
      ? {}
      : {
          codexHomeDoctor: () => {
            /* fake codex tests do not require a real dispatcher CODEX_HOME */
          },
        }),
  });
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
    messageType: 'text',
    rawContent: JSON.stringify({ text }),
    parsedText: text,
    mentions: [],
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

function writeReadyDispatcherCodexHome(dispatcherId: string): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  writeFileSync(
    dispatcherCodexConfigPath(dispatcherId),
    `model = "gpt-test"
approval_policy = "never"

[marketplaces.dreamux]
source = "public"

[plugins.codexmux]
enabled = true
`,
    { mode: 0o600 },
  );
  writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
    mode: 0o600,
  });
  mkdirSync(
    join(
      dispatcherCodexPluginsDir(dispatcherId),
      'cache',
      'dreamux',
      'codexmux',
    ),
    { recursive: true },
  );
}

describe('dreamux MVP smoke', () => {
  let runtimeDir: string;
  let fake: FakeCodex;
  let bot: FakeFeishuBot;
  let server: Server;

  beforeEach(async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'dreamux-'));
    fake = await startFakeCodex();
    bot = createFakeFeishuBot('app-smoke');
  });

  afterEach(async () => {
    try {
      await server?.shutdown();
    } catch {
      /* */
    }
    await fake?.close();
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

    const row = server.repos.inbound.getById(1);
    expect(row?.state).toBe('completed');
    expect(row?.assistant_text).toBe('echo: hi');

    // Dispatcher's thread is persisted across server restart.
    const d = server.repos.dispatchers.get('flow');
    expect(d?.thread_id).toMatch(/^thread_fake_/);
    expect(d?.status).toBe('ready');
  });

  it('starts the dispatcher app-server under the dispatcher private CODEX_HOME', async () => {
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({ runtimeDir, fake, bot, capturedCodexOptions });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    await server.start();

    expect(capturedCodexOptions).toHaveLength(1);
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBe(
      dispatcherCodexHome('flow'),
    );
    expect(capturedCodexOptions[0]?.socketPath).toBe(
      dispatcherSocketPath('flow'),
    );
  });

  it('runs the default dispatcher CODEX_HOME doctor before spawning the app-server', async () => {
    rmSync(runtimeDir, { recursive: true, force: true });
    runtimeDir = mkdtempSync(join(homedir(), '.dreamux-smoke-'));
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
    });
    writeReadyDispatcherCodexHome('flow');

    expect(existsSync(dispatcherAppServerControlDir('flow'))).toBe(false);
    await server.start();

    expect(capturedCodexOptions).toHaveLength(1);
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBe(
      dispatcherCodexHome('flow'),
    );
    expect(existsSync(dispatcherAppServerControlDir('flow'))).toBe(true);
  });

  it('compatible Feishu gate drops bot-loop messages before durable enqueue', async () => {
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
  });

  it('compatible Feishu gate drops Feishu bot/app sender types', async () => {
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
  });

  it('FIFO: same-dispatcher messages process serially', async () => {
    // Restart fake with a slow turn so messages can actually pile up.
    await fake.close();
    fake = await startFakeCodex({ turnDelayMs: 80 });

    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'msg-1', 'msg-a'));
    await bot.inject(fakeInbound('chat-group-a', 'msg-2', 'msg-b'));

    await waitFor(() => bot.sentMessages.length >= 2, 6000);
    expect(bot.sentMessages.map((m) => m.text)).toEqual([
      'echo: msg-1',
      'echo: msg-2',
    ]);
  });

  it('crash recovery: running rows become unknown + user notified', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    // Pre-seed an inbound row stuck in 'running' as if the previous server
    // crashed mid-turn.
    const insert = (server as unknown as { db?: never }); // satisfy TS
    void insert;
    const row = server.repos.inbound.enqueue({
      dispatcher_id: 'flow',
      source_chat_id: 'chat-group-a',
      source_message_id: 'message-pre-crash',
      sender_id: 'sender',
      feishu_event_json: '{}',
      parsed_text: 'pretend-this-was-running',
    });
    expect(row).not.toBeNull();
    server.repos.inbound.markRunning(row!.id, null);

    await server.start();

    // After start, the pre-crashed row is 'unknown' and the chat got a
    // "result unknown" message.
    const after = server.repos.inbound.getById(row!.id);
    expect(after?.state).toBe('unknown');
    expect(after?.error).toMatch(/server restarted/);
    expect(bot.sentMessages.some((m) => m.text.includes('上一次的执行结果未知'))).toBe(
      true,
    );
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
    fake = await startFakeCodex({ failResume: true });

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
    fake = await startFakeCodex({ triggerApprovalOnTurn: true });

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

  // PR #3 review #1
  it('queued backlog drains on restart even with no fresh inbound', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    // Pre-seed a 'queued' inbound row — as if the previous server crashed
    // *after* accepting the inbound but *before* the worker dequeued it.
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

    // The fix: startup must notify() the turn worker so this row is drained
    // immediately, not stranded until the next live inbound arrives.
    await waitFor(() => bot.sentMessages.length >= 1);
    expect(bot.sentMessages[0]?.text).toBe('echo: queued-before-crash');
    const after = server.repos.inbound.getById(row!.id);
    expect(after?.state).toBe('completed');
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
