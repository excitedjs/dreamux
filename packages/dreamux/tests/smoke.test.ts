/**
 * Smoke tests for the dreamux MVP.
 *
 * Covers the issue #2 verification path against a fake codex + fake feishu:
 *   - happy path: inbound → turn injection, with MCP reply as the only outbound
 *   - inbound delivery: one accepted Feishu message → one turn/start
 *   - thread/resume on restart (in-process)
 *   - thread/resume failure → visible degradation (last_lost_thread_id set)
 *   - MCP reply sends through the serve-owned bot
 *   - approval fail-fast: codex server-request causes the turn to fail
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
  Server,
  type WorkerBinaryProbe,
} from '../src/server.js';
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
  saveDispatcherAccess,
} from '../src/channel/feishu-gate.js';
import { loadChatBots } from '../src/channel/chat-bots-store.js';
import {
  BUILT_IN_DEFAULTS,
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  type DreamuxConfig,
} from '../src/runtime/config.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexCwd,
  dispatcherCodexHome,
  bundledSkillDir,
  dispatcherWorkspaceSkillDir,
  dispatcherSocketPath,
  dispatcherTeamMateLedgerPath,
  dispatcherTeamMateTasksDir,
  restartIntentPath,
} from '../src/runtime/paths.js';
import { writeRestartIntent } from '../src/daemon/restart-intent.js';
import { dreamuxBinPath } from '../src/runtime/package-bin.js';
import { createLogger, type DreamuxLogger } from '../src/runtime/logger.js';
import { DREAMUX_DISPATCHER_BASE_INSTRUCTIONS } from '../src/dispatcher/base-prompt.js';
import { TeamMateWorkerProviderCatalog } from '../src/teammate/worker/catalog.js';
import {
  FakeTeamMateWorkerProvider,
  FAKE_TEAMMATE_WORKER_REF,
} from '../src/teammate/worker/fake-provider.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
} from '../src/agent-runtime/claude-code-session.js';
import type { TurnOutcome } from '../src/runtime/claude-code-stream.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';
import { testDispatcherConfig } from './helpers/config.js';
import { Writable } from 'node:stream';

/** Collect every JSON log line written to an injected logger destination. */
function captureLogger(name: string): {
  logger: DreamuxLogger;
  lines: () => Array<Record<string, unknown>>;
  text: () => string;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ name, destination: sink });
  const text = (): string => chunks.join('');
  return {
    logger,
    text,
    lines: () =>
      text()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

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

/**
 * A fake `claude` resident session for the default `builtin:claude-code` worker
 * (issue #126 PR4). `auto` resolves the single turn asynchronously with a
 * deterministic `echo:` result (so `execute` re-reads `running` first, then the
 * await wakes on completion); without `auto` the turn stays pending (so a
 * run_task assertion of `running` is stable).
 */
class FakeWorkerClaudeSession implements ClaudeCodeSession {
  constructor(private readonly auto: boolean) {}
  async start(): Promise<void> {
    /* no real child */
  }
  submitTurn(prompt: string): Promise<TurnOutcome> {
    if (!this.auto) return new Promise<TurnOutcome>(() => {});
    return new Promise<TurnOutcome>((resolve) => {
      setTimeout(
        () =>
          resolve({
            isError: false,
            text: `echo: ${prompt}`,
            sessionId: 'cc-worker-sess',
            subtype: 'success',
            errors: [],
          }),
        10,
      );
    });
  }
  isAlive(): boolean {
    return true;
  }
  setOnExit(): void {
    /* the one-turn worker relies on submitTurn's promise, not onExit */
  }
  async stop(): Promise<void> {
    /* no real child */
  }
}

function fakeClaudeWorkerSessionFactory(
  opts: { auto: boolean } = { auto: true },
): ClaudeCodeSessionFactory {
  return () => new FakeWorkerClaudeSession(opts.auto);
}

function buildServer(opts: {
  runtimeDir: string;
  fake: FakeCodex;
  bot: FakeFeishuBot;
  config?: DreamuxConfig;
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
  channelLoggerFactory?: (dispatcherId: string) => DreamuxLogger;
  teamMateWorkerProviders?: TeamMateWorkerProviderCatalog;
  workerBinaryProbe?: WorkerBinaryProbe;
  codexBinPath?: string;
  teamMateDeliveryBackoffMs?: (attempt: number) => number;
  claudeCodeWorkerSessionFactory?: ClaudeCodeSessionFactory;
}): Server {
  return new Server({
    config: opts.config ?? BUILT_IN_DEFAULTS,
    adminSocketPath: join(opts.runtimeDir, 'admin.sock'),
    skipBotSecret: opts.skipBotSecret ?? true,
    ...(opts.teamMateWorkerProviders !== undefined
      ? { teamMateWorkerProviders: opts.teamMateWorkerProviders }
      : {}),
    ...(opts.workerBinaryProbe !== undefined
      ? { workerBinaryProbe: opts.workerBinaryProbe }
      : {}),
    ...(opts.codexBinPath !== undefined
      ? { codexBinPath: opts.codexBinPath }
      : {}),
    ...(opts.claudeCodeWorkerSessionFactory !== undefined
      ? { claudeCodeWorkerSessionFactory: opts.claudeCodeWorkerSessionFactory }
      : {}),
    ...(opts.teamMateDeliveryBackoffMs !== undefined
      ? { teamMateDeliveryBackoffMs: opts.teamMateDeliveryBackoffMs }
      : {}),
    ...(opts.channelLoggerFactory !== undefined
      ? { channelLoggerFactory: opts.channelLoggerFactory }
      : {}),
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
  overrides: Partial<FeishuInboundEvent> = {},
): FeishuInboundEvent {
  const base: FeishuInboundEvent = {
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
  return { ...base, ...overrides };
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
  mkdirSync(dispatcherCwd ?? dispatcherCodexCwd(dispatcherId), { recursive: true });
}

interface ConfigDispatcherOverrides {
  id?: string;
  cwd?: string | null;
  enabled?: boolean;
  feishu?: Record<string, unknown>;
  codex?: Record<string, unknown>;
}

function configWithDispatcher(overrides: ConfigDispatcherOverrides = {}): DreamuxConfig {
  return {
    ...BUILT_IN_DEFAULTS,
    dispatchers: [
      testDispatcherConfig({
        id: overrides.id ?? 'flow',
        cwd: overrides.cwd ?? null,
        enabled: overrides.enabled ?? true,
        feishu: overrides.feishu ?? {
          app_id: 'app-smoke',
          app_secret: 'secret-server-only',
        },
        codex: overrides.codex ?? {
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
    mkdirSync(dispatcherCodexCwd('flow'), { recursive: true });
    codexInputs = [];
    fake = await startFakeCodex({
      replyFor: captureAndEchoCodexInput(codexInputs),
    });
    bot = createFakeFeishuBot('app-smoke');
    // Suite baseline: the canonical sender is onboarded onto the global
    // allow-user list, so a mentioned group message from it is delivered.
    // Empty `allow_users` now authorizes nobody (the follow-user fix), so
    // tests that exercise delivery need this seed; tests that assert a drop
    // override it or rely on a different gate reason (no mention, bot sender).
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
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

  it('happy path: inbound reaches Codex, and assistant text is not auto-sent', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'hi', 'msg-1-id'));

    await waitFor(() => codexInputs.length === 1);
    await sleep(80);
    expect(bot.sentMessages).toEqual([]);
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
      {
        messageId: 'msg-1-id',
        emoji: IN_PROGRESS_REACTION_EMOJI,
        reactionId: 'reaction-fake-2',
      },
    ]);
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-1-id',
        reactionId: 'reaction-fake-1',
      },
    ]);

    // Dispatcher's thread is persisted across server restart.
    const d = server.repos.dispatchers.get('flow');
    expect(d?.thread_id).toMatch(/^thread_fake_/);
    expect(d?.status).toBe('ready');
  });

  it('introduce (no @ to us) trusts peer bots; trusted bot inbound requires @ (issue #102)', async () => {
    const self = 'fake-open-id-app-smoke'; // the fake bot's own open_id
    const atUs = [{ key: '@_bot', id: { open_id: self }, name: 'Dispatcher' }];
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // 1) Allow-listed human runs /introduce mentioning two peer bots WITHOUT
    //    @-mentioning us. Both peers are trusted by their mention open_id.
    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-intro', {
        senderId: 'sender-test',
        senderType: 'user',
        mentions: [
          { key: '@_user_1', id: { open_id: 'peer-bee' }, name: 'Bee' },
          { key: '@_user_2', id: { open_id: 'peer-cee' } }, // no name
        ],
      }),
    );

    // list_chat_bots exposes trusted as { open_id, name? }; missing name omitted.
    const listing = await server.listChatBotsFromMcp({
      dispatcherId: 'flow',
      chatId: 'chat-group-a',
    });
    expect(listing.chat_id).toBe('chat-group-a');
    expect(listing.trusted).toEqual([
      { open_id: 'peer-bee', name: 'Bee' },
      { open_id: 'peer-cee' },
    ]);

    // 2) Trusted bot that @-mentions us → delivered to Codex.
    await bot.inject(
      fakeInbound('chat-group-a', 'hello from bee', 'msg-bee', {
        senderId: 'peer-bee',
        senderType: 'bot',
        senderName: 'Bee',
        mentions: atUs,
      }),
    );
    await waitFor(() => codexInputs.length === 1);
    expect(codexInputs[0]).toContain('hello from bee');

    // 3) Trusted bot WITHOUT an @ → dropped (no new Codex turn).
    await bot.inject(
      fakeInbound('chat-group-a', 'no at here', 'msg-bee-noat', {
        senderId: 'peer-bee',
        senderType: 'bot',
        mentions: [],
      }),
    );
    // 4) Untrusted bot WITH an @ → dropped.
    await bot.inject(
      fakeInbound('chat-group-a', 'stranger', 'msg-dee', {
        senderId: 'peer-dee',
        senderType: 'bot',
        mentions: atUs,
      }),
    );
    await sleep(120);
    expect(codexInputs).toHaveLength(1);
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
    expect(server.getRuntime('flow')?.providerRef).toBe('builtin:codex');
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBeUndefined();
    expect(capturedCodexOptions[0]?.env?.['PATH']).toContain('/bin');
    expect(capturedCodexOptions[0]?.socketPath).toBe(
      dispatcherSocketPath('flow'),
    );
    const dispatcherSkillDir = dispatcherWorkspaceSkillDir(
      dispatcherCodexCwd('flow'),
      'dispatcher',
    );
    expect(lstatSync(dispatcherSkillDir).isSymbolicLink()).toBe(true);
    expect(realpathSync(dispatcherSkillDir)).toBe(
      realpathSync(bundledSkillDir('dispatcher')),
    );
  });

  it('starts fresh Codex threads with Dreamux dispatcher base instructions', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });

    await server.start();

    expect(fake.threadStartParams).toHaveLength(1);
    expect(fake.threadStartParams[0]?.['baseInstructions']).toBe(
      DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'Feishu MCP reply tool',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'Delegate repository exploration',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'Respect explicit engine preferences',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'operator-visible communication loop',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'authoritative sources',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'proposal, independent review, operator checkpoint',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'Do not pass dispatcher guesses as facts',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'use update_plan to track phases',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain('`【F:...】`');
    // TeamMate MCP is the default orchestration interface that executes for
    // real (issue #124, updated by #126 PR6).
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain('# TeamMate Delegation');
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'server-hosted TeamMate MCP is the primary interface',
    );
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain('executes work for real');
    // tm survives only as the labeled fallback, not the primary contract.
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).toContain(
      'The tm CLI is the labeled fallback',
    );
    // The stale Phase 1 / not-to-completion caveat must be gone (#126 PR6).
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).not.toContain('Phase 1 boundary');
    expect(DREAMUX_DISPATCHER_BASE_INSTRUCTIONS).not.toContain('# tm Delegation');
  });

  it('resumes Codex threads with Dreamux dispatcher base instructions', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.repos.dispatchers.setThreadId('flow', 'thread_seed');

    await server.start();

    expect(fake.threadStartParams).toHaveLength(0);
    expect(fake.threadResumeParams).toHaveLength(1);
    expect(fake.threadResumeParams[0]?.['threadId']).toBe('thread_seed');
    expect(fake.threadResumeParams[0]?.['baseInstructions']).toBe(
      DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
    );
  });

  it('merges dispatcher extra_env into the Codex child environment', async () => {
    const capturedCodexOptions: CodexProcessOptions[] = [];
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      capturedCodexOptions,
      config: configWithDispatcher({
        codex: {
          bin: 'codex',
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: [],
          extra_env: {
            DREAMUX_EXAMPLE_FLAG: 'enabled',
            PATH: '/custom/bin',
          },
          initialize_timeout_ms: 10000,
        },
      }),
    });

    await server.start();

    expect(capturedCodexOptions).toHaveLength(1);
    expect(capturedCodexOptions[0]?.env?.['DREAMUX_EXAMPLE_FLAG']).toBe(
      'enabled',
    );
    expect(capturedCodexOptions[0]?.env?.['PATH']).toContain('/custom/bin');
    expect(capturedCodexOptions[0]?.env?.['CODEX_HOME']).toBeUndefined();
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
      config: configWithDispatcher({
        feishu: {
          app_id: 'app-smoke',
          app_secret: 'secret-server-only',
        },
      }),
    });

    await server.start();

    expect(capturedBotSecrets).toEqual(['secret-server-only']);
    expect(JSON.stringify(capturedCodexOptions)).not.toContain('secret-server-only');
  });

  it('injects dispatcher-scoped Dreamux MCP config after operator Codex args', async () => {
    const capturedCodexOptions: CodexProcessOptions[] = [];
    // Operator codex args are now a per-dispatcher runtime setting
    // (dispatchers[].runtime.config.extra_args); there is no top-level codex
    // block to carry them.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      capturedCodexOptions,
      config: configWithDispatcher({
        codex: {
          bin: 'codex',
          approval_policy: 'never',
          sandbox_mode: 'workspace-write',
          extra_args: ['-c', 'mcp_servers.feishu.command="operator-feishu"'],
          extra_env: {},
          initialize_timeout_ms: 10000,
        },
      }),
    });

    await server.start();

    const args = capturedCodexOptions[0]?.extraArgs ?? [];
    const feishuCommand = `mcp_servers.feishu.command=${JSON.stringify(dreamuxBinPath())}`;
    const teammateCommand =
      `mcp_servers.teammate.command=${JSON.stringify(dreamuxBinPath())}`;
    expect(args).toContain('mcp_servers.feishu.command="operator-feishu"');
    const operatorIdx = args.indexOf('mcp_servers.feishu.command="operator-feishu"');
    const feishuIdx = args.indexOf(feishuCommand);
    const teammateIdx = args.indexOf(teammateCommand);
    expect(feishuIdx).toBeGreaterThan(operatorIdx);
    expect(teammateIdx).toBeGreaterThan(operatorIdx);
    expect(dreamuxBinPath()).toMatch(/\/dreamux$/);
    expect(args).toContain(
      `mcp_servers.feishu.args=["feishu-mcp", "--dispatcher", "flow", "--admin-socket", "${join(runtimeDir, 'admin.sock')}"]`,
    );
    expect(args).toContain(
      `mcp_servers.teammate.args=["teammate-mcp", "--dispatcher", "flow", "--caller", "dispatcher", "--admin-socket", "${join(runtimeDir, 'admin.sock')}"]`,
    );
  });

  it('launches a dispatcher with its own runtime.config.bin', async () => {
    const previousEnvBin = process.env['CODEX_HOST_CODEX_BIN'];
    delete process.env['CODEX_HOST_CODEX_BIN'];
    try {
      const capturedCodexOptions: CodexProcessOptions[] = [];
      server = buildServer({
        runtimeDir,
        fake,
        bot,
        capturedCodexOptions,
        config: configWithDispatcher({
          codex: {
            bin: '/opt/custom-codex',
            approval_policy: 'never',
            sandbox_mode: 'workspace-write',
            extra_args: [],
            extra_env: {},
            initialize_timeout_ms: 10000,
          },
        }),
      });

      await server.start();

      expect(capturedCodexOptions[0]?.binPath).toBe('/opt/custom-codex');
    } finally {
      if (previousEnvBin === undefined) delete process.env['CODEX_HOST_CODEX_BIN'];
      else process.env['CODEX_HOST_CODEX_BIN'] = previousEnvBin;
    }
  });

  it('CODEX_HOST_CODEX_BIN overrides dispatcher runtime.config.bin at launch', async () => {
    const previousEnvBin = process.env['CODEX_HOST_CODEX_BIN'];
    process.env['CODEX_HOST_CODEX_BIN'] = '/host/override-codex';
    try {
      const capturedCodexOptions: CodexProcessOptions[] = [];
      server = buildServer({
        runtimeDir,
        fake,
        bot,
        capturedCodexOptions,
        config: configWithDispatcher({
          codex: {
            bin: '/opt/custom-codex',
            approval_policy: 'never',
            sandbox_mode: 'workspace-write',
            extra_args: [],
            extra_env: {},
            initialize_timeout_ms: 10000,
          },
        }),
      });

      await server.start();

      expect(capturedCodexOptions[0]?.binPath).toBe('/host/override-codex');
    } finally {
      if (previousEnvBin === undefined) delete process.env['CODEX_HOST_CODEX_BIN'];
      else process.env['CODEX_HOST_CODEX_BIN'] = previousEnvBin;
    }
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
    await waitFor(() => bot.reactions.length === 2);

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
    await waitFor(() => fake.turnsHandled === 1);
    await sleep(2200);
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.removedReactions).toEqual([
      {
        messageId: 'msg-mcp-reply',
        reactionId: 'reaction-fake-1',
      },
      {
        messageId: 'msg-mcp-reply',
        reactionId: 'reaction-fake-2',
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
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-race-reaction',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
    ]);
  });

  it('adds the in-progress reaction before cancelling the received one (add-then-cancel)', async () => {
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'hi', 'msg-order'));

    await waitFor(
      () => bot.reactions.length === 2 && bot.removedReactions.length === 1,
    );
    // The received->in_progress transition must add the new reaction before it
    // removes the previous one, so the message never shows zero reactions.
    const addInProgress = bot.reactionOps.findIndex(
      (op) => op.op === 'add' && op.emoji === IN_PROGRESS_REACTION_EMOJI,
    );
    const removeReceived = bot.reactionOps.findIndex(
      (op) => op.op === 'remove' && op.reactionId === 'reaction-fake-1',
    );
    expect(addInProgress).toBeGreaterThanOrEqual(0);
    expect(removeReceived).toBeGreaterThan(addInProgress);
  });

  it('reply wins the received->in_progress replacement race without leaving a dangling reaction', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      turnDelayMs: 2000,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    let releaseInProgress!: () => void;
    let markInProgressStarted!: () => void;
    const inProgressStarted = new Promise<void>((resolve) => {
      markInProgressStarted = resolve;
    });
    const inProgressBlocked = new Promise<void>((resolve) => {
      releaseInProgress = resolve;
    });
    const originalAddReaction = bot.addReaction.bind(bot);
    bot.addReaction = async (messageId, emoji) => {
      if (emoji === IN_PROGRESS_REACTION_EMOJI) {
        markInProgressStarted();
        await inProgressBlocked;
      }
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
      fakeInbound('chat-group-a', 'fast reply', 'msg-replace-race'),
    );
    // The received reaction is added; the in-progress add is now blocked.
    await inProgressStarted;
    await waitFor(() => bot.reactions.length === 1);

    await sendAdminRequest(
      'mcp.reply',
      {
        dispatcher_id: 'flow',
        chat_id: 'chat-group-a',
        message_id: 'msg-replace-race',
        text: 'manual reply mid-transition',
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    );
    // The reply removed the received reaction (the only one in the ledger).
    expect(bot.removedReactions).toEqual([
      { messageId: 'msg-replace-race', reactionId: 'reaction-fake-1' },
    ]);

    // Now the in-progress add lands; it must be removed (late pending clear),
    // not stored and left dangling.
    releaseInProgress();
    await injected;
    await waitFor(() => bot.removedReactions.length === 2);
    expect(bot.removedReactions).toEqual([
      { messageId: 'msg-replace-race', reactionId: 'reaction-fake-1' },
      { messageId: 'msg-replace-race', reactionId: 'reaction-fake-2' },
    ]);
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-replace-race',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
      {
        messageId: 'msg-replace-race',
        emoji: IN_PROGRESS_REACTION_EMOJI,
        reactionId: 'reaction-fake-2',
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
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
  });

  it('reads access gate configuration from access.json and allows configured DMs', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-dm'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-dm', 'dm hello', 'msg-dm', {
      chatType: 'p2p',
      senderId: 'sender-dm',
      mentions: [],
    }));

    await waitFor(() => fake.turnsHandled === 1);
    const access = await loadDispatcherAccess('flow');
    expect(access.allow_users).toEqual(['sender-dm']);
    expect(access.group.policy).toEqual('allowlist');
    expect(access.group.allow_chats).toEqual(['chat-group-a']);
    expect(access.observed_chats).toEqual(['chat-dm']);
    expect(bot.reactions.map((reaction) => reaction.messageId)).toEqual([
      'msg-dm',
      'msg-dm',
    ]);
    expect(bot.reactions.map((reaction) => reaction.emoji)).toEqual([
      RECEIVED_REACTION_EMOJI,
      IN_PROGRESS_REACTION_EMOJI,
    ]);
  });

  it('consumes a no-@ /introduce from an allowlisted sender and records trust without enqueue or reactions', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // No @-mention of our bot — only the peer bot being introduced is mentioned.
    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce', {
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-1' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    // Consumed before the gate: no Codex turn or reactions. The channel sends
    // one immediate best-effort ack to the group, not a threaded reply.
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([
      {
        chatId: 'chat-group-a',
        target: { chatId: 'chat-group-a' },
        text: '✅ 已认识本群 1 个伙伴：@Peer',
        messageIds: ['message-fake-1'],
      },
    ]);
    expect(bot.reactions).toEqual([]);
    // The peer bot is now trusted for this chat (and known), but not the sender.
    const entry = (await loadChatBots('flow')).chats['chat-group-a'];
    expect(entry?.trusted).toEqual(['peer-bot-1']);
    expect(entry?.known).toEqual(['peer-bot-1']);
  });

  it('follow-user: consumes a bare /introduce from an allow_user in an UNCONFIGURED group', async () => {
    // The reported bug (#89): under follow-user the delivery gate ignores
    // allow_chats, but introduce used to demand the chat be named — so an
    // allow_user in a group not in allow_chats could never /introduce. This
    // reproduces the literal runtime state: allow_chats names ANOTHER group, the
    // current chat is absent, yet the command must consume, trust, and ack.
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'follow-user',
        allow_chats: ['chat-group-other'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // No @-mention of our bot — only the peer bot being introduced is mentioned.
    await bot.inject(
      fakeInbound('chat-group-new', '/introduce', 'msg-introduce-fu-bare', {
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-fu-1' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([
      {
        chatId: 'chat-group-new',
        target: { chatId: 'chat-group-new' },
        text: '✅ 已认识本群 1 个伙伴：@Peer',
        messageIds: ['message-fake-1'],
      },
    ]);
    expect(bot.reactions).toEqual([]);
    const entry = (await loadChatBots('flow')).chats['chat-group-new'];
    expect(entry?.trusted).toEqual(['peer-bot-fu-1']);
    expect(entry?.known).toEqual(['peer-bot-fu-1']);
  });

  it('follow-user: consumes an @-bot /introduce from an allow_user in an UNCONFIGURED group', async () => {
    // Mentioning our bot must not change the introduce path — it still consumes,
    // trusts, and acks without reaching Codex (the mention requirement is waived
    // for introduce, not required).
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'follow-user',
        allow_chats: [],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // @ our bot AND the peer bot being introduced.
    await bot.inject(
      fakeInbound('chat-group-new', '/introduce', 'msg-introduce-fu-at', {
        mentions: [
          { key: '@_user_1', id: { open_id: 'fake-open-id-app-smoke' }, name: 'Dispatcher' },
          { key: '@_user_9', id: { open_id: 'peer-bot-fu-2' }, name: 'Peer' },
        ],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([
      {
        chatId: 'chat-group-new',
        target: { chatId: 'chat-group-new' },
        text: '✅ 已认识本群 1 个伙伴：@Peer',
        messageIds: ['message-fake-1'],
      },
    ]);
    expect(bot.reactions).toEqual([]);
    const entry = (await loadChatBots('flow')).chats['chat-group-new'];
    expect(entry?.trusted).toEqual(['peer-bot-fu-2']);
    expect(entry?.known).toEqual(['peer-bot-fu-2']);
  });

  it('follow-user: does NOT consume /introduce from a non-allow_user in an UNCONFIGURED group', async () => {
    // The regression guard: a stranger in an unconfigured follow-user group must
    // be denied for being off the allowlist (`sender_not_followed`), NEVER for
    // the chat being unlisted — that proves the chat check is skipped under
    // follow-user. Normal gate behavior is preserved: it still falls through and
    // drops as `bot not mentioned`.
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'follow-user',
        allow_chats: [],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-new', '/introduce', 'msg-introduce-fu-stranger', {
        senderId: 'stranger',
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-fu-3' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
    expect((await loadChatBots('flow')).chats['chat-group-new']?.trusted ?? []).not.toContain(
      'peer-bot-fu-3',
    );

    const lines = channel.lines();
    expect(lines.find((l) => l['msg'] === 'introduce detected but not authorized')).toMatchObject({
      chat_id: 'chat-group-new',
      sender_id: 'stranger',
      message_id: 'msg-introduce-fu-stranger',
      // Must be sender-scoped, not chat-scoped — the whole point of the fix.
      reason: 'sender_not_followed',
    });
    // Normal follow-user gate still runs and drops the stranger's message.
    expect(
      lines.some(
        (l) => l['msg'] === 'feishu inbound dropped' && l['reason'] === 'bot not mentioned',
      ),
    ).toBe(true);
  });

  it('does not ack an authorized /introduce with no external peer', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce-self-only', {
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'fake-open-id-app-smoke' },
            name: 'Dispatcher',
          },
        ],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted ?? []).toEqual([]);
  });

  it('keeps /introduce trust when the best-effort ack send fails', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    bot.setSendError(new Error('feishu send boom'));
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await expect(
      bot.inject(
        fakeInbound('chat-group-a', '/introduce', 'msg-introduce-ack-fails', {
          mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-ack-fail' }, name: 'Peer' }],
        }),
      ),
    ).resolves.toBeUndefined();

    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted).toEqual([
      'peer-bot-ack-fail',
    ]);
    const failed = channel.lines().find((l) => l['msg'] === 'introduce ack failed');
    expect(failed).toMatchObject({
      dispatcher_id: 'flow',
      chat_id: 'chat-group-a',
      message_id: 'msg-introduce-ack-fails',
      peer_count: 1,
    });
    expect((failed?.['err'] as { message: string }).message).toBe('feishu send boom');
    expect(channel.lines().some((l) => l['msg'] === 'introduce consumed')).toBe(true);
  });

  it('acks already-trusted peers when they are reintroduced', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    const intro = (messageId: string): FeishuInboundEvent =>
      fakeInbound('chat-group-a', '/introduce', messageId, {
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-repeat' }, name: 'Peer Bot' }],
      });
    await bot.inject(intro('msg-introduce-repeat-1'));
    await bot.inject(intro('msg-introduce-repeat-2'));

    expect(fake.turnsHandled).toBe(0);
    expect(bot.reactions).toEqual([]);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted).toEqual([
      'peer-bot-repeat',
    ]);
    expect(bot.sentMessages.map((message) => message.text)).toEqual([
      '✅ 已认识本群 1 个伙伴：@Peer Bot',
      '✅ 已认识本群 1 个伙伴：@Peer Bot',
    ]);
  });

  it('injects a one-shot group_bots context on the next group message after /introduce', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // /introduce trusts the peer bot and arms the one-shot context.
    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-intro', {
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-1' }, name: 'Peer Bot' }],
      }),
    );
    await sleep(40);
    expect(fake.turnsHandled).toBe(0);

    // Next delivered group message carries the trusted bots once.
    await bot.inject(fakeInbound('chat-group-a', 'hello again', 'msg-after-1'));
    await waitFor(() => codexInputs.length === 1);
    expect(codexInputs[0]).toContain('<group_bots');
    expect(codexInputs[0]).toContain('open_id="peer-bot-1"');
    expect(codexInputs[0]).toContain('name="Peer Bot"');

    // The message after that does NOT — it was a one-shot, cleared after submit.
    await bot.inject(fakeInbound('chat-group-a', 'and again', 'msg-after-2'));
    await waitFor(() => codexInputs.length === 2);
    expect(codexInputs[1]).not.toContain('<group_bots');
    expect((await loadChatBots('flow')).chats['chat-group-a']?.needsBaseline).toBe(false);
  });

  it('mcp.list_chat_bots returns the chat known + trusted bots with names', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // Trust one bot via /introduce, and passively observe another bot sender.
    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-intro-list', {
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-1' }, name: 'Peer Bot' }],
      }),
    );
    await bot.inject(
      fakeInbound('chat-group-a', 'ambient bot chatter', 'msg-bot-obs', {
        senderId: 'known-bot-2',
        senderType: 'bot',
        senderName: 'Ambient Bot',
      }),
    );
    await sleep(40);

    const result = (await sendAdminRequest(
      'mcp.list_chat_bots',
      { dispatcher_id: 'flow', chat_id: 'chat-group-a' },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      chat_id: string;
      known: Array<{ open_id: string; name?: string }>;
      trusted: Array<{ open_id: string; name?: string }>;
    };

    expect(result.chat_id).toBe('chat-group-a');
    expect(result.trusted).toEqual([{ open_id: 'peer-bot-1', name: 'Peer Bot' }]);
    expect(result.known).toEqual(
      expect.arrayContaining([
        { open_id: 'peer-bot-1', name: 'Peer Bot' },
        { open_id: 'known-bot-2', name: 'Ambient Bot' },
      ]),
    );
  });

  it('mcp.teammate.schedule accepts immediately and writes the server ledger', async () => {
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher(),
    });
    await server.start();

    const result = (await sendAdminRequest(
      'mcp.teammate.schedule',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Review task',
        prompt: 'Review the current change and report blockers.',
        teammate_id: 'reviewer-1',
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      status: 'accepted';
      task_id: string;
      dispatcher_id: string;
      created_at: number;
      teammate_id: string;
    };

    expect(result).toMatchObject({
      status: 'accepted',
      dispatcher_id: 'flow',
      teammate_id: 'reviewer-1',
    });
    expect(result.task_id).toMatch(/^tmtsk_/);

    const rootFile = JSON.parse(
      await readFile(dispatcherTeamMateLedgerPath('flow'), 'utf8'),
    ) as Record<string, unknown>;
    expect(rootFile).toMatchObject({
      version: 1,
      dispatcher_id: 'flow',
    });
    expect(await readdir(dispatcherTeamMateTasksDir('flow'))).toEqual([
      `${result.task_id}.json`,
    ]);
    const taskFile = JSON.parse(
      await readFile(
        join(dispatcherTeamMateTasksDir('flow'), `${result.task_id}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(taskFile).toMatchObject({
      version: 2,
      task_id: result.task_id,
      dispatcher_id: 'flow',
      lifecycle_status: 'accepted',
      delivery_status: 'none',
      title: 'Review task',
      prompt: 'Review the current change and report blockers.',
      teammate_id: 'reviewer-1',
      scheduled_by: { kind: 'dispatcher' },
    });

    await expect(
      sendAdminRequest(
        'mcp.teammate.schedule',
        {
          dispatcher_id: 'flow',
          caller_kind: 'teammate',
          title: 'Nested',
          prompt: 'Nested scheduling attempt.',
        },
        { socketPath: join(runtimeDir, 'admin.sock') },
      ),
    ).rejects.toMatchObject({
      code: 'TEAMMATE_NESTED_DISPATCH_REJECTED',
    });
  });

  it('mcp.teammate.run reports execution unavailable when no worker is wired', async () => {
    // Production now wires the real Codex worker by default (issue #126 PR3);
    // an explicitly empty catalog is the deliberate no-worker state, and it must
    // still create the task durably and surface a retryable provider_unavailable.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog(),
    });
    await server.start();

    const result = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Run task',
        prompt: 'Investigate the failing test.',
        target_path: '.',
        target_mode: 'in_place',
      },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      task: Record<string, unknown>;
      execution: { status: string; code: string; retryable: boolean };
    };

    expect(result.task).toMatchObject({
      lifecycle_status: 'accepted',
      delivery_status: 'none',
      title: 'Run task',
      last_event_id: 1,
    });
    // Public-safe response shaping: the task summary must not surface the local
    // target path; it stays in the server-owned ledger only.
    expect(result.task).not.toHaveProperty('target');
    expect(JSON.stringify(result.task)).not.toContain(runtimeDir);
    expect(result.execution).toMatchObject({
      status: 'provider_unavailable',
      code: 'TEAMMATE_PROVIDER_UNAVAILABLE',
      retryable: true,
    });

    // The resolved target path is retained in the local ledger (local state).
    const taskId = result.task['task_id'] as string;
    const taskFile = JSON.parse(
      await readFile(
        join(dispatcherTeamMateTasksDir('flow'), `${taskId}.json`),
        'utf8',
      ),
    ) as { target: { kind: string; path: string }; origin: string };
    expect(taskFile.target.kind).toBe('path');
    expect(taskFile.origin).toBe('dispatcher');
  });

  it('mcp.teammate.capabilities reports both default workers (codex steer, claude-code single-turn)', async () => {
    // PR3 wired the real Codex worker (steer via folded turn/start); PR4 wires
    // the real Claude Code worker too. Both are now worker-available, but the
    // single-turn claude-code worker honestly reports steer:false (no mid-turn
    // fold primitive) so capabilities never mislead the dispatcher model.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      // The default catalog wires the real workers; pin the binary probe to
      // available so this advertisement test asserts the wired modes/refs
      // deterministically rather than depending on the CI host's PATH (the
      // probe itself is exercised by the unavailable-binary test below).
      workerBinaryProbe: async () => ({ available: true, reason: '' }),
    });
    await server.start();

    const caps = (await sendAdminRequest(
      'mcp.teammate.capabilities',
      { dispatcher_id: 'flow' },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      execution_available: boolean;
      default_input_mode: string;
      providers: Array<{
        provider_ref: string;
        worker_available: boolean;
        modes: { steer: boolean; queue: boolean; interrupt: boolean };
      }>;
    };

    expect(caps.execution_available).toBe(true);
    expect(caps.default_input_mode).toBe('steer');
    const refs = caps.providers.map((p) => p.provider_ref).sort();
    expect(refs).toContain('builtin:codex');
    expect(refs).toContain('builtin:claude-code');
    const codex = caps.providers.find((p) => p.provider_ref === 'builtin:codex');
    expect(codex?.worker_available).toBe(true);
    expect(codex?.modes).toMatchObject({
      steer: true,
      queue: false,
      interrupt: false,
    });
    const claudeCode = caps.providers.find(
      (p) => p.provider_ref === 'builtin:claude-code',
    );
    expect(claudeCode?.worker_available).toBe(true);
    expect(claudeCode?.modes).toMatchObject({
      steer: false,
      queue: false,
      interrupt: false,
    });
  });

  it('mcp.teammate.capabilities reports a wired worker as unavailable when its binary is missing (issue #126 PR7)', async () => {
    // Installed-state blocker: a worker is wired (default catalog) but its
    // binary cannot be started in the service environment (here `claude` is
    // missing while `codex` is present). The advertisement must not claim the
    // unstartable worker is available — it must report worker_available:false
    // with a reason, so the dispatcher does not route to a worker that will
    // immediately provider_unavailable on spawn.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      workerBinaryProbe: async (ref) =>
        ref === 'builtin:claude-code'
          ? { available: false, reason: "worker binary 'claude' was not found on the dispatcher service PATH" }
          : { available: true, reason: '' },
    });
    await server.start();

    const caps = (await sendAdminRequest(
      'mcp.teammate.capabilities',
      { dispatcher_id: 'flow' },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      execution_available: boolean;
      providers: Array<{
        provider_ref: string;
        worker_available: boolean;
        unsupported_reason: string;
      }>;
    };

    const codex = caps.providers.find((p) => p.provider_ref === 'builtin:codex');
    const claudeCode = caps.providers.find(
      (p) => p.provider_ref === 'builtin:claude-code',
    );
    // Codex resolves -> available; claude-code missing -> unavailable with a reason.
    expect(codex?.worker_available).toBe(true);
    expect(claudeCode?.worker_available).toBe(false);
    expect(claudeCode?.unsupported_reason).toContain('was not found');
    // One worker still resolves, so execution is available overall.
    expect(caps.execution_available).toBe(true);
  });

  it('default binary probe resolves codex and reports claude-code unavailable end-to-end (issue #126 PR7)', async () => {
    // Exercises the REAL defaultWorkerBinaryProbe wiring (NO injected probe):
    // codex resolves via an absolute codexBinPath; `claude` is absent from a
    // stripped service PATH, so claude-code advertises unavailable. This is the
    // installed-state composition the stubbed-probe tests above cannot cover.
    // The advertisement reads the catalog + probe directly, so no dispatcher
    // process (and no real codex spawn) is needed — call the server method.
    const savedPath = process.env['PATH'];
    const emptyBinDir = mkdtempSync(join(tmpdir(), 'dreamux-emptybin-'));
    process.env['PATH'] = emptyBinDir;
    try {
      server = buildServer({
        runtimeDir,
        fake,
        bot,
        config: configWithDispatcher({ cwd: runtimeDir }),
        // Absolute path → resolves regardless of PATH; the running node binary
        // is guaranteed present and executable.
        codexBinPath: process.execPath,
      });

      const caps = await server.getTeamMateCapabilitiesFromMcp();
      const codex = caps.providers.find(
        (p) => p.provider_ref === 'builtin:codex',
      );
      const claudeCode = caps.providers.find(
        (p) => p.provider_ref === 'builtin:claude-code',
      );
      expect(codex?.worker_available).toBe(true);
      expect(claudeCode?.worker_available).toBe(false);
      expect(claudeCode?.unsupported_reason).toContain('was not found');
      expect(caps.execution_available).toBe(true);
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      rmSync(emptyBinDir, { recursive: true, force: true });
    }
  });

  it('mcp.teammate.capabilities reports execution unavailable when no worker binary resolves (issue #126 PR7)', async () => {
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      // Neither built-in binary resolves in this environment.
      workerBinaryProbe: async () => ({
        available: false,
        reason: 'worker binary was not found on the dispatcher service PATH',
      }),
    });
    await server.start();

    const caps = (await sendAdminRequest(
      'mcp.teammate.capabilities',
      { dispatcher_id: 'flow' },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      execution_available: boolean;
      providers: Array<{ provider_ref: string; worker_available: boolean }>;
    };

    expect(caps.execution_available).toBe(false);
    for (const p of caps.providers) {
      expect(p.worker_available).toBe(false);
    }
  });

  it('mcp.teammate.capabilities reflects an injected worker provider as available', async () => {
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [new FakeTeamMateWorkerProvider()],
      }),
    });
    await server.start();

    const caps = (await sendAdminRequest(
      'mcp.teammate.capabilities',
      { dispatcher_id: 'flow' },
      { socketPath: join(runtimeDir, 'admin.sock') },
    )) as {
      execution_available: boolean;
      providers: Array<{
        provider_ref: string;
        worker_available: boolean;
        modes: { steer: boolean };
      }>;
    };

    // Injecting an available worker flips execution_available and appends the
    // worker ref alongside the (still worker-unavailable) built-in runtimes.
    expect(caps.execution_available).toBe(true);
    const fakeRow = caps.providers.find(
      (p) => p.provider_ref === FAKE_TEAMMATE_WORKER_REF,
    );
    expect(fakeRow?.worker_available).toBe(true);
    expect(fakeRow?.modes.steer).toBe(true);
    const builtinCodex = caps.providers.find(
      (p) => p.provider_ref === 'builtin:codex',
    );
    expect(builtinCodex?.worker_available).toBe(false);
  });

  it('run_task executes through an injected worker and await/pull collect the result', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Run task',
        prompt: 'Investigate the failing test.',
        target_path: '.',
      },
      { socketPath },
    )) as {
      task: { task_id: string; lifecycle_status: string; last_event_id: number };
      execution: { status: string; provider_ref?: string };
    };

    // With a worker wired, run_task starts a live session: the task is running
    // (not provider_unavailable) and the execution names the resolved provider.
    expect(created.execution).toMatchObject({
      status: 'running',
      provider_ref: FAKE_TEAMMATE_WORKER_REF,
    });
    expect(created.task.lifecycle_status).toBe('running');
    // The local target path is still kept out of the public summary.
    expect(JSON.stringify(created.task)).not.toContain(runtimeDir);
    const taskId = created.task.task_id;

    // Register the wait, then drive the fake worker to completion; the waiter
    // must wake from the recorded completion event, not its timeout.
    const awaiting = sendAdminRequest(
      'mcp.teammate.await',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        after_event_id: created.task.last_event_id,
        timeout_ms: 3000,
      },
      { socketPath, timeoutMs: 9000 },
    ) as Promise<{ status: string; result: { outcome: string; text: string } | null }>;

    await new Promise((resolve) => setTimeout(resolve, 50));
    await fakeWorker.emitCompleted(taskId, 'the worker finished the job');

    const awaited = await awaiting;
    expect(awaited.status).toBe('completed');
    expect(awaited.result?.outcome).toBe('completed');

    // Pull returns the retained result regardless of delivery (no runtime up).
    const pulled = (await sendAdminRequest(
      'mcp.teammate.pull',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { result: { outcome: string; text: string } };
    expect(pulled.result.text).toBe('the worker finished the job');
  });

  it('cancel_task stops a live worker and is an idempotent no-op afterward (PR5)', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Run task',
        prompt: 'Investigate the failing test.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string; lifecycle_status: string } };
    const taskId = created.task.task_id;
    expect(created.task.lifecycle_status).toBe('running');
    expect(fakeWorker.hasLiveSession(taskId)).toBe(true);

    const cancelled = (await sendAdminRequest(
      'mcp.teammate.cancel',
      { dispatcher_id: 'flow', task_id: taskId, note: 'stop now' },
      { socketPath },
    )) as {
      status: string;
      lifecycle_status: string;
      cancelled_live_session: boolean;
      task: { task_id: string };
    };
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      lifecycle_status: 'cancelled',
      cancelled_live_session: true,
    });
    // The live worker session was actually reaped, not just ledger-closed.
    expect(fakeWorker.hasLiveSession(taskId)).toBe(false);

    const fetched = (await sendAdminRequest(
      'mcp.teammate.get',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { task: { close: { status: string; note: string } } };
    expect(fetched.task.close).toMatchObject({ status: 'cancelled', note: 'stop now' });

    // Second cancel is a no-op: the task is already terminal.
    const again = (await sendAdminRequest(
      'mcp.teammate.cancel',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { status: string; cancelled_live_session: boolean };
    expect(again).toMatchObject({
      status: 'already_terminal',
      cancelled_live_session: false,
    });
  });

  it('cancel_task racing a completion is an idempotent no-op, not a spurious close (PR5)', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Run task',
        prompt: 'Investigate the failing test.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string } };
    const taskId = created.task.task_id;

    // The worker completes first; its session is gone before cancel arrives —
    // the exact TOCTOU window between cancel's terminal check and its no-live
    // ledger close.
    await fakeWorker.emitCompleted(taskId, 'finished before the cancel');

    const cancelled = (await sendAdminRequest(
      'mcp.teammate.cancel',
      { dispatcher_id: 'flow', task_id: taskId, note: 'too late' },
      { socketPath },
    )) as { status: string; lifecycle_status: string; cancelled_live_session: boolean };
    expect(cancelled).toMatchObject({
      status: 'already_terminal',
      lifecycle_status: 'completed',
      cancelled_live_session: false,
    });

    const fetched = (await sendAdminRequest(
      'mcp.teammate.get',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as {
      task: {
        close: unknown;
        events: Array<{ type: string }>;
        result: { text: string } | null;
      };
    };
    // No spurious cancelled close or closed event stamped on the completed task,
    // and its result is still retained/pullable.
    expect(fetched.task.close).toBeNull();
    expect(fetched.task.events.some((e) => e.type === 'closed')).toBe(false);
    expect(fetched.task.result?.text).toBe('finished before the cancel');
  });

  it('cancel_task closes an accepted task with no live worker (PR5)', async () => {
    // No worker catalog: schedule lands an accepted task that never runs, so
    // cancel must close the ledger directly (cancelled_live_session: false).
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog(),
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const accepted = (await sendAdminRequest(
      'mcp.teammate.schedule',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Accept only',
        prompt: 'Stand by.',
      },
      { socketPath },
    )) as { task_id: string };

    const cancelled = (await sendAdminRequest(
      'mcp.teammate.cancel',
      { dispatcher_id: 'flow', task_id: accepted.task_id, note: 'never mind' },
      { socketPath },
    )) as { status: string; lifecycle_status: string; cancelled_live_session: boolean };
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      lifecycle_status: 'cancelled',
      cancelled_live_session: false,
    });
  });

  it('get_task_logs forwards and reports unsupported logs for a layout-less worker (PR5)', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Run task',
        prompt: 'Investigate the failing test.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string } };
    const taskId = created.task.task_id;

    const logs = (await sendAdminRequest(
      'mcp.teammate.logs',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as {
      task_id: string;
      provider_ref: string;
      logs_supported: boolean;
      streams: unknown[];
    };
    // The fake worker has no on-disk log layout, so logs are unsupported — but
    // the admin → server → worker-logs wiring resolved the task and provider.
    expect(logs).toMatchObject({
      task_id: taskId,
      provider_ref: FAKE_TEAMMATE_WORKER_REF,
      logs_supported: false,
      streams: [],
    });

    // An unknown task is a structured error, not a crash.
    await expect(
      sendAdminRequest(
        'mcp.teammate.logs',
        { dispatcher_id: 'flow', task_id: 'tmtsk_missing_one' },
        { socketPath },
      ),
    ).rejects.toThrow();
  });

  it('run_task executes through the default codex worker and collects the real turn result', async () => {
    // No injected catalog: this exercises the real `builtin:codex` worker wired
    // by default (PR3), driven against the in-process fake codex app-server via
    // the same codex process/client test seams the dispatcher runtime uses.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Codex worker task',
        prompt: 'Run the codex worker.',
        target_path: '.',
      },
      { socketPath },
    )) as {
      task: { task_id: string; lifecycle_status: string; last_event_id: number };
      execution: { status: string; provider_ref?: string };
    };

    // The worker started a live Codex session: running, attributed to builtin:codex.
    expect(created.execution).toMatchObject({
      status: 'running',
      provider_ref: 'builtin:codex',
    });
    const taskId = created.task.task_id;

    // Wait for the real turn/completed to land (the fake codex completes the turn
    // asynchronously); the waiter wakes from the recorded completion event.
    const awaited = (await sendAdminRequest(
      'mcp.teammate.await',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        after_event_id: created.task.last_event_id,
        timeout_ms: 3000,
      },
      { socketPath, timeoutMs: 9000 },
    )) as { status: string; result: { outcome: string; text: string } | null };
    expect(awaited.status).toBe('completed');
    expect(awaited.result?.outcome).toBe('completed');

    const pulled = (await sendAdminRequest(
      'mcp.teammate.pull',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { result: { outcome: string; text: string } };
    // The result is the real assistant text the fake codex returned for the turn.
    expect(pulled.result.text).toBe('echo: Run the codex worker.');
  });

  it('run_task from a non-Codex (claude-code) dispatcher still executes via the default codex worker', async () => {
    // Regression (issue #126 PR3 review): the default worker is Codex
    // regardless of the dispatcher's own runtime. A builtin:claude-code
    // dispatcher also gets TeamMate MCP, so run_task must resolve a VALID Codex
    // worker config (the defaults) and execute, not accept-then-hard-fail with
    // "not wired to Codex".
    const claudeCodeDispatcher = testDispatcherConfig({
      id: 'flow',
      cwd: runtimeDir,
      runtime: {
        provider: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
        config: {
          bin: 'claude',
          model: null,
          permission_mode: null,
          extra_args: [],
          extra_env: {},
          turn_timeout_ms: 600000,
        },
      },
    });
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: { ...BUILT_IN_DEFAULTS, dispatchers: [claudeCodeDispatcher] },
      teamMateDeliveryBackoffMs: () => 0,
      // Assert the Codex worker is advertised available regardless of the
      // dispatcher's own runtime; pin the probe so it does not depend on the
      // CI host having `codex` on PATH.
      workerBinaryProbe: async () => ({ available: true, reason: '' }),
    });
    // Do NOT start() — that would spawn the claude-code runtime. The worker
    // catalog, ledger, and dispatcher rows are wired in the constructor, so the
    // MCP entry point can be driven directly.
    const result = await server.runTeamMateTaskFromMcp({
      dispatcherId: 'flow',
      callerKind: 'dispatcher',
      title: 'CC dispatcher task',
      prompt: 'Run from a claude-code dispatcher.',
      targetPath: '.',
    });
    // The Codex worker started for real (default config), not a hard-fail.
    expect(result.execution).toMatchObject({
      status: 'running',
      provider_ref: 'builtin:codex',
    });

    // Capabilities reports the default Codex worker as available regardless of
    // the dispatcher's own (claude-code) runtime.
    const caps = await server.getTeamMateCapabilitiesFromMcp();
    const codex = caps.providers.find((p) => p.provider_ref === 'builtin:codex');
    expect(codex?.worker_available).toBe(true);
    expect(caps.execution_available).toBe(true);
  });

  it('run_task from a non-Claude-Code (codex) dispatcher still executes via a pinned claude-code worker', async () => {
    // Regression (issue #126 PR4): the Claude Code worker is selectable by
    // pinning `provider_ref: builtin:claude-code` regardless of the dispatcher's
    // own runtime. A `builtin:codex` dispatcher pinning the claude-code worker
    // must resolve a VALID Claude Code launch config (the defaults) and execute,
    // not accept-then-hard-fail with "not wired to Claude Code" — the mirror of
    // the PR3 non-Codex regression above.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }), // a builtin:codex dispatcher
      claudeCodeWorkerSessionFactory: fakeClaudeWorkerSessionFactory({
        auto: false,
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    const result = await server.runTeamMateTaskFromMcp({
      dispatcherId: 'flow',
      callerKind: 'dispatcher',
      title: 'CC worker from codex dispatcher',
      prompt: 'Run on the claude-code worker.',
      targetPath: '.',
      providerRef: 'builtin:claude-code',
    });
    // The Claude Code worker started for real (default config), not a hard-fail.
    expect(result.execution).toMatchObject({
      status: 'running',
      provider_ref: 'builtin:claude-code',
    });
  });

  it('run_task executes through the default claude-code worker and collects the real turn result', async () => {
    // The default catalog wires BOTH workers (PR4); pinning
    // `provider_ref: builtin:claude-code` routes to the real Claude Code worker,
    // driven against a fake resident session via the same session-factory seam
    // the dispatcher runtime uses.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      claudeCodeWorkerSessionFactory: fakeClaudeWorkerSessionFactory({
        auto: true,
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Claude Code worker task',
        prompt: 'Run the claude-code worker.',
        target_path: '.',
        provider_ref: 'builtin:claude-code',
      },
      { socketPath },
    )) as {
      task: { task_id: string; lifecycle_status: string; last_event_id: number };
      execution: { status: string; provider_ref?: string };
    };

    // The worker started a live Claude Code session: running, attributed to it.
    expect(created.execution).toMatchObject({
      status: 'running',
      provider_ref: 'builtin:claude-code',
    });
    const taskId = created.task.task_id;

    const awaited = (await sendAdminRequest(
      'mcp.teammate.await',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        after_event_id: created.task.last_event_id,
        timeout_ms: 3000,
      },
      { socketPath, timeoutMs: 9000 },
    )) as { status: string; result: { outcome: string; text: string } | null };
    expect(awaited.status).toBe('completed');
    expect(awaited.result?.outcome).toBe('completed');

    const pulled = (await sendAdminRequest(
      'mcp.teammate.pull',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { result: { outcome: string; text: string } };
    // The result is the real assistant text the fake claude session returned.
    expect(pulled.result.text).toBe('echo: Run the claude-code worker.');
  });

  it('send_input promotes a queued input to submitted when a worker session is live', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Steerable task',
        prompt: 'Start working and await steering.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string } };
    const taskId = created.task.task_id;

    const sent = (await sendAdminRequest(
      'mcp.teammate.send_input',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        prompt: 'also check the integration tests',
      },
      { socketPath },
    )) as { status: string; mode: string; input_id: string };
    // Default mode is steer, and the live worker accepted it -> submitted.
    expect(sent.mode).toBe('steer');
    expect(sent.status).toBe('submitted');
    expect(fakeWorker.inputsFor(taskId)).toHaveLength(1);

    const task = (await sendAdminRequest(
      'mcp.teammate.get',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as { task: { inputs: Array<{ input_id: string; status: string }> } };
    expect(task.task.inputs[0]).toMatchObject({
      input_id: sent.input_id,
      status: 'submitted',
    });
  });

  it('run_task drives the task to cancelled when the worker cancels', async () => {
    const fakeWorker = new FakeTeamMateWorkerProvider();
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog({
        providers: [fakeWorker],
      }),
      teamMateDeliveryBackoffMs: () => 0,
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Cancellable task',
        prompt: 'Begin work.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string } };
    const taskId = created.task.task_id;

    await fakeWorker.emitCancelled(taskId, 'superseded by a newer task');

    const task = (await sendAdminRequest(
      'mcp.teammate.get',
      { dispatcher_id: 'flow', task_id: taskId },
      { socketPath },
    )) as {
      task: { lifecycle_status: string; close: { status: string; note: string } };
    };
    expect(task.task.lifecycle_status).toBe('cancelled');
    expect(task.task.close).toMatchObject({
      status: 'cancelled',
      note: 'superseded by a newer task',
    });
  });

  it('await_completion wakes promptly when a completion is recorded mid-wait', async () => {
    // Empty worker catalog: this test drives completion through the operator
    // ingest seam (`mcp.teammate.complete`) to isolate the wait-broker wake, so
    // the default codex worker must not auto-complete the task first.
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      config: configWithDispatcher({ cwd: runtimeDir }),
      teamMateWorkerProviders: new TeamMateWorkerProviderCatalog(),
    });
    await server.start();
    const socketPath = join(runtimeDir, 'admin.sock');

    const created = (await sendAdminRequest(
      'mcp.teammate.run',
      {
        dispatcher_id: 'flow',
        caller_kind: 'dispatcher',
        title: 'Wait task',
        prompt: 'Do work then report.',
        target_path: '.',
      },
      { socketPath },
    )) as { task: { task_id: string; last_event_id: number } };
    const taskId = created.task.task_id;

    // Register the wait first, then record a completion through the worker/
    // operator ingest seam; the waiter must wake from the event, not its timeout.
    const awaiting = sendAdminRequest(
      'mcp.teammate.await',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        after_event_id: created.task.last_event_id,
        timeout_ms: 3000,
      },
      { socketPath, timeoutMs: 9000 },
    ) as Promise<{ status: string; result: { outcome: string } | null }>;

    await new Promise((resolve) => setTimeout(resolve, 50));
    await sendAdminRequest(
      'mcp.teammate.complete',
      {
        dispatcher_id: 'flow',
        task_id: taskId,
        outcome: 'completed',
        final_text: 'the work is done',
      },
      { socketPath },
    );

    const awaited = await awaiting;
    expect(awaited.status).toBe('completed');
    expect(awaited.result?.outcome).toBe('completed');
  });

  it('does NOT consume /introduce from a non-allowlisted sender (no trust, dropped by the gate)', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce-stranger', {
        senderId: 'stranger',
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-2' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    // Not consumed as introduce; falls to the gate and is dropped (not allowlisted,
    // and the bot was not mentioned). No trust written, no enqueue, no reactions.
    expect(fake.turnsHandled).toBe(0);
    expect(bot.sentMessages).toEqual([]);
    expect(bot.reactions).toEqual([]);
    const entry = (await loadChatBots('flow')).chats['chat-group-a'];
    expect(entry?.trusted ?? []).not.toContain('peer-bot-2');

    // Issue #77: the unauthorized introduce is diagnosed before the gate runs,
    // with the stable reason — not silently surfaced as the gate's eventual
    // `bot not mentioned` drop.
    const lines = channel.lines();
    const diag = lines.find((l) => l['msg'] === 'introduce detected but not authorized');
    expect(diag).toMatchObject({
      chat_id: 'chat-group-a',
      sender_id: 'stranger',
      message_id: 'msg-introduce-stranger',
      reason: 'sender_not_followed',
    });
    // The unauthorized introduce still falls through to the gate, which drops it
    // — here as `bot not mentioned`, since the stranger mentioned only the peer
    // bot. The issue #77 diagnostic above is what names the real cause.
    expect(
      lines.some(
        (l) =>
          l['msg'] === 'feishu inbound dropped' &&
          l['reason'] === 'bot not mentioned',
      ),
    ).toBe(true);
    // No-leak: the diagnostic carries only ids/reason — never the message body,
    // the mentioned peer's open_id, or the mention display name.
    const text = channel.text();
    expect(text).not.toContain('/introduce');
    expect(text).not.toContain('peer-bot-2');
    expect(text).not.toContain('Peer');
  });

  it('diagnoses an unauthorized /introduce when allow_users is empty (would surface as bot-not-mentioned)', async () => {
    // The misleading case from issue #77: with allow_users empty the sender is
    // unauthorized, and because the gate is mention-first the eventual drop
    // reason is `bot not mentioned` — which looks like the user simply forgot to
    // @ the bot, hiding the real cause that the issue #77 diagnostic names.
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: [],
      group: {
        policy: 'follow-user',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce-empty-follow', {
        senderId: 'sender-test',
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-3' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.reactions).toEqual([]);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted ?? []).not.toContain('peer-bot-3');

    const lines = channel.lines();
    expect(lines.find((l) => l['msg'] === 'introduce detected but not authorized')).toMatchObject({
      chat_id: 'chat-group-a',
      sender_id: 'sender-test',
      message_id: 'msg-introduce-empty-follow',
      reason: 'sender_not_followed',
    });
    // Same gate drop as before the diagnostic existed.
    expect(
      lines.some(
        (l) => l['msg'] === 'feishu inbound dropped' && l['reason'] === 'bot not mentioned',
      ),
    ).toBe(true);
  });

  it('diagnoses an unauthorized /introduce when the chat is not allowlisted', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-other'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce-other-chat', {
        senderId: 'sender-test',
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-4' }, name: 'Peer' }],
      }),
    );

    await sleep(60);
    expect(fake.turnsHandled).toBe(0);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted ?? []).not.toContain('peer-bot-4');

    expect(
      channel.lines().find((l) => l['msg'] === 'introduce detected but not authorized'),
    ).toMatchObject({
      chat_id: 'chat-group-a',
      sender_id: 'sender-test',
      message_id: 'msg-introduce-other-chat',
      reason: 'chat_not_allowlisted',
    });
  });

  it('diagnoses an unauthorized /introduce sent as a direct message (non_group)', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'follow-user',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-dm', '/introduce', 'msg-introduce-dm', {
        chatType: 'p2p',
        senderId: 'sender-test',
        mentions: [],
      }),
    );

    await waitFor(() => fake.turnsHandled === 1);
    // Diagnosed as non_group, then delivered normally as an ordinary DM — the
    // introduce trust path never fires outside a group.
    expect(
      channel.lines().find((l) => l['msg'] === 'introduce detected but not authorized'),
    ).toMatchObject({
      chat_id: 'chat-dm',
      sender_id: 'sender-test',
      message_id: 'msg-introduce-dm',
      reason: 'non_group',
    });
  });

  it('an authorized /introduce is consumed without emitting the unauthorized diagnostic', async () => {
    await saveDispatcherAccess('flow', {
      version: 2,
      allow_users: ['sender-test'],
      group: {
        policy: 'allowlist',
        allow_chats: ['chat-group-a'],
        require_mention: true,
      },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    });
    const channel = captureLogger('channel');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => channel.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(
      fakeInbound('chat-group-a', '/introduce', 'msg-introduce-ok', {
        senderId: 'sender-test',
        mentions: [{ key: '@_user_9', id: { open_id: 'peer-bot-5' }, name: 'Peer Bot' }],
      }),
    );

    await sleep(60);
    // Consumed: trust written, no enqueue, and crucially no unauthorized diagnostic.
    expect(fake.turnsHandled).toBe(0);
    expect((await loadChatBots('flow')).chats['chat-group-a']?.trusted).toEqual(['peer-bot-5']);
    const lines = channel.lines();
    expect(lines.some((l) => l['msg'] === 'introduce consumed')).toBe(true);
    expect(lines.some((l) => l['msg'] === 'introduce detected but not authorized')).toBe(false);
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

    const access = await loadDispatcherAccess('flow');
    expect(access.observed_chats).toEqual(['chat-group-a', 'chat-group-b']);
    expect(access.warnings).toEqual([TRUST_DOMAIN_WARNING]);
    expect(bot.reactions.map((reaction) => reaction.messageId)).toEqual([
      'msg-chat-a',
      'msg-chat-a',
      'msg-chat-b',
      'msg-chat-b',
    ]);
    await waitFor(() => fake.turnsHandled === 2);
    expect(bot.sentMessages).toEqual([]);
  });

  // Issue #70: a dropped inbound must be diagnosable (reason + ids) without
  // leaking the message body into the persistent log.
  it('logs gate drops with ids and reason but never the message body', async () => {
    const capture = captureLogger('channel/flow');
    const SECRET_BODY = 'PLEASE-DO-NOT-LOG-THIS-BODY';
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => capture.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    // A group message with no @-mention of our bot is dropped by the gate.
    await bot.inject(
      fakeInbound('chat-group-a', SECRET_BODY, 'msg-dropped', { mentions: [] }),
    );
    await sleep(60);

    expect(fake.turnsHandled).toBe(0);
    const dropLine = capture
      .lines()
      .find((line) => line['msg'] === 'feishu inbound dropped');
    expect(dropLine).toBeDefined();
    expect(dropLine).toMatchObject({
      chat_id: 'chat-group-a',
      message_id: 'msg-dropped',
      reason: 'bot not mentioned',
    });
    // The body text must not appear anywhere in the persisted log.
    expect(capture.text()).not.toContain(SECRET_BODY);
  });

  // Issue #70: a delivered inbound is logged (submitted) — still ids only.
  it('logs accepted inbound as submitted without the message body', async () => {
    const capture = captureLogger('channel/flow');
    const SECRET_BODY = 'ACCEPTED-BODY-MUST-NOT-LEAK';
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => capture.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', SECRET_BODY, 'msg-accepted'));
    await waitFor(() => fake.turnsHandled === 1);

    const submitted = capture
      .lines()
      .find((line) => line['msg'] === 'feishu inbound submitted');
    expect(submitted).toMatchObject({
      chat_id: 'chat-group-a',
      message_id: 'msg-accepted',
    });
    expect(capture.text()).not.toContain(SECRET_BODY);
  });

  // Issue #70 (PR #75 review): outbound reply/react must be diagnosable —
  // success and failure — without leaking the reply body. The admin layer
  // turning a failure into a response does not replace a persistent log.
  it('logs a successful outbound reply with ids but never the reply text', async () => {
    const capture = captureLogger('channel/flow');
    const REPLY_BODY = 'REPLY-BODY-MUST-NOT-LEAK';
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => capture.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    const result = await server.replyFromMcp({
      dispatcherId: 'flow',
      chatId: 'chat-group-a',
      messageId: 'msg-reply',
      text: REPLY_BODY,
    });
    expect(result.message_ids).toEqual(['message-fake-1']);

    const sent = capture
      .lines()
      .find((line) => line['msg'] === 'feishu reply sent');
    expect(sent).toMatchObject({
      dispatcher_id: 'flow',
      chat_id: 'chat-group-a',
      message_id: 'msg-reply',
      message_ids: ['message-fake-1'],
    });
    expect(capture.text()).not.toContain(REPLY_BODY);
  });

  it('logs a failed outbound reply with the error summary and rethrows (no body)', async () => {
    const capture = captureLogger('channel/flow');
    const REPLY_BODY = 'FAILED-REPLY-BODY-MUST-NOT-LEAK';
    bot.setSendError(new Error('feishu send boom'));
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => capture.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await expect(
      server.replyFromMcp({
        dispatcherId: 'flow',
        chatId: 'chat-group-a',
        messageId: 'msg-reply-fail',
        text: REPLY_BODY,
      }),
    ).rejects.toThrow('feishu send boom');

    const failed = capture
      .lines()
      .find((line) => line['msg'] === 'feishu reply failed');
    expect(failed).toMatchObject({
      dispatcher_id: 'flow',
      chat_id: 'chat-group-a',
      message_id: 'msg-reply-fail',
    });
    expect((failed?.['err'] as { message: string }).message).toBe(
      'feishu send boom',
    );
    expect(capture.text()).not.toContain(REPLY_BODY);
  });

  it('logs outbound react success and failure with ids and emoji', async () => {
    const capture = captureLogger('channel/flow');
    server = buildServer({
      runtimeDir,
      fake,
      bot,
      channelLoggerFactory: () => capture.logger,
    });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    const ok = await server.reactFromMcp({
      dispatcherId: 'flow',
      messageId: 'msg-react',
      emoji: 'THUMBSUP',
    });
    expect(ok.reaction_id).toBe('reaction-fake-1');
    const sent = capture
      .lines()
      .find((line) => line['msg'] === 'feishu react sent');
    expect(sent).toMatchObject({
      dispatcher_id: 'flow',
      message_id: 'msg-react',
      emoji: 'THUMBSUP',
      reaction_id: 'reaction-fake-1',
    });

    bot.setReactionError(new Error('feishu react boom'));
    await expect(
      server.reactFromMcp({
        dispatcherId: 'flow',
        messageId: 'msg-react-fail',
        emoji: 'EYES',
      }),
    ).rejects.toThrow('feishu react boom');
    const failed = capture
      .lines()
      .find((line) => line['msg'] === 'feishu react failed');
    expect(failed).toMatchObject({
      dispatcher_id: 'flow',
      message_id: 'msg-react-fail',
      emoji: 'EYES',
    });
    expect((failed?.['err'] as { message: string }).message).toBe(
      'feishu react boom',
    );
  });

  it('submits each pending inbound with turn/start while Codex folds active-turn input', async () => {
    // Restart fake with a slow active turn so later submissions fold into it.
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      activeTurnFolding: true,
      turnDelayMs: 300,
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

    await waitFor(() => fake.turnsHandled === 3, 6000);
    await waitFor(() => fake.turnsCompleted === 1, 6000);
    expect(fake.turnsHandled).toBe(3);
    expect(fake.methodLog.filter((method) => method === 'turn/start'))
      .toHaveLength(3);
    expect(codexInputs).toHaveLength(1);
    expect(codexInputs[0]).toContain('running');
    expect(feishuMessageBlockCount(codexInputs[0] ?? '')).toBe(3);
    expect(codexInputs[0]).toContain('batch-1');
    expect(codexInputs[0]).toContain('batch-2');
    expect(bot.sentMessages).toEqual([]);
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

    await waitFor(() => fake.turnsHandled === 1);
    await sleep(120);
    expect(fake.turnsHandled).toBe(1);
    expect(bot.reactions).toHaveLength(2);
    expect(bot.reactions[0]?.messageId).toBe('msg-same');
    expect(bot.reactions[1]).toMatchObject({
      messageId: 'msg-same',
      emoji: IN_PROGRESS_REACTION_EMOJI,
    });
  });

  it('thread/resume failure produces visible degradation, not silent loss', async () => {
    const config = configWithDispatcher();
    server = buildServer({ runtimeDir, fake, bot, config });
    // Pre-seed an existing thread_id so startup will try thread/resume.
    await server.repos.dispatchers.setThreadId('flow', 'thread_was_lost');

    await server.shutdown();
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      failResume: true,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    server = buildServer({ runtimeDir, fake, bot, config });
    await server.start();

    const d = server.repos.dispatchers.get('flow');
    expect(d?.last_lost_thread_id).toBe('thread_was_lost');
    expect(d?.thread_id).toMatch(/^thread_fake_/);
    expect(d?.thread_id).not.toBe('thread_was_lost');
    // last_error is cleared when dispatcher reaches 'ready' again; the
    // durable evidence of degradation is last_lost_thread_id above.
    expect(d?.status).toBe('ready');
  });

  it('injects a restart notice into a resumed target after daemon restart --notify-resumed', async () => {
    const config = configWithDispatcher();
    server = buildServer({ runtimeDir, fake, bot, config });
    await server.repos.dispatchers.setThreadId('flow', 'thread_seed');
    await server.start();
    await server.shutdown();

    // Marker written by `daemon restart --notify-resumed --dispatcher flow`.
    await writeRestartIntent({
      targets: ['flow'],
      announce: 'Restart completed.',
      now: Date.now(),
      path: restartIntentPath(),
    });
    expect(existsSync(restartIntentPath())).toBe(true);

    server = buildServer({ runtimeDir, fake, bot, config });
    await server.start();

    await waitFor(() => codexInputs.includes('Restart completed.'));
    // The thread was resumed (not freshly started) and the notice rode in.
    expect(server.repos.dispatchers.get('flow')?.thread_id).toBe('thread_seed');
    // The marker is one-shot: consumed on load and deleted from disk.
    expect(existsSync(restartIntentPath())).toBe(false);
  });

  it('does not inject a restart notice without a marker (plain resume)', async () => {
    const config = configWithDispatcher();
    server = buildServer({ runtimeDir, fake, bot, config });
    await server.repos.dispatchers.setThreadId('flow', 'thread_seed');
    await server.start();
    await server.shutdown();
    codexInputs = [];

    server = buildServer({ runtimeDir, fake, bot, config });
    await server.start();

    await sleep(150);
    expect(codexInputs).toEqual([]);
    expect(server.repos.dispatchers.get('flow')?.thread_id).toBe('thread_seed');
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

    await waitFor(() => fake.turnsHandled === 1);
    await sleep(120);
    expect(bot.sentMessages).toEqual([]);
  });

  it('keeps only the received reaction when turn/start is refused before accept', async () => {
    await fake.close();
    codexInputs = [];
    fake = await startFakeCodex({
      failTurnStart: true,
      replyFor: captureAndEchoCodexInput(codexInputs),
    });

    server = buildServer({ runtimeDir, fake, bot });
    server.repos.dispatchers.create({
      dispatcher_id: 'flow',
      bot_app_id: 'app-smoke',
      bot_secret_ref: 'env:UNUSED',
    });
    await server.start();

    await bot.inject(fakeInbound('chat-group-a', 'will fail', 'msg-start-fail'));

    await sleep(120);
    expect(fake.turnsHandled).toBe(0);
    expect(bot.reactions).toEqual([
      {
        messageId: 'msg-start-fail',
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
    ]);
    expect(bot.removedReactions).toEqual([]);
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

    await waitFor(() => fake.turnsHandled === 1, 1000);
    await sleep(220);
    expect(processes).toHaveLength(1);
    expect(bot.sentMessages).toEqual([]);
  });
});

describe('admin socket hardening', () => {
  let runtimeDir: string;
  let stubServer: Server;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'dreamux-admin-'));
    stubServer = new Server({
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

    // Both contenders treat both PIDs as live. This mirrors production, where
    // two real `dreamux serve` processes each see the other's *real, live* PID:
    // whoever loses the atomic `wx` lock race reads a live holder and bails
    // *before* touching the socket (it never reclaims a live holder's lock).
    // Lock acquisition is async, so which contender wins the `wx` race is
    // scheduling-dependent — assert the invariant (exactly one wins, mutual
    // exclusion) rather than a fixed winner.
    const bothAlive = (pid: number): boolean => pid === 11111 || pid === 22222;
    const a = createAdminSocketServer(stubServer, sockPath, {
      selfPid: 11111,
      isPidAlive: bothAlive,
    });
    const b = createAdminSocketServer(stubServer, sockPath, {
      selfPid: 22222,
      isPidAlive: bothAlive,
    });

    const results = await Promise.allSettled([a.start(), b.start()]);
    const wonA = results[0].status === 'fulfilled';
    const wonB = results[1].status === 'fulfilled';
    expect(wonA !== wonB).toBe(true);

    // The winner's socket file must still exist and still be listenable — i.e.
    // the loser's bail path did NOT rm it out from under the winner.
    const { existsSync, statSync } = await import('node:fs');
    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).isSocket()).toBe(true);

    await (wonA ? a : b).close();
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
