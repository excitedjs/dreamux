/**
 * Live integration test against a real codex app-server.
 *
 * CI installs `@openai/codex@latest` before this test runs. Local developer
 * machines use whatever `codex` is on PATH. This test exists to catch the
 * two compat bugs fixed in PR #5 plus the serve-foundation shape:
 *   - dropped `--approval-policy` flag (now `-c approval_policy=...`)
 *   - LSP-style `initialize` / `initialized` handshake required before
 *     any business RPC
 *   - app-server listen socket must not live under `/tmp`
 *   - app-server startup must use a network-enabled sandbox/profile
 *
 * **Default behavior**: missing/unparseable `codex --version` fails loudly.
 * The whole point is to verify compatibility; a silent skip in CI defeats it.
 *
 * **Escape hatch**: set `DREAMUX_SKIP_LIVE_CODEX=1` to explicitly opt out
 * (e.g. dev machines without codex, or pre-merge sandboxes). The skip
 * emits a loud `console.warn` so it's visible in test output.
 *
 * The issue #63 mid-turn model gate needs a usable Codex model login, not just
 * the app-server binary. It runs by default outside CI. CI loud-skips that one
 * gate unless `DREAMUX_RUN_LIVE_MODEL_GATE=1` is set, because public CI cannot
 * assume an operator's interactive Codex auth is available.
 */

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- live-Codex probe: a one-shot `execSync` reads the operator's interactive Codex auth/login state to decide whether the live model-gate case can run at all; it is setup, not the code under test, and must complete before the suite proceeds (issue #85 test-scope carve-out).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CodexProcess } from '../src/agent-runtime/builtin/codex/supervisor.js';
import { CodexWsClient, type CodexWsClientOptions } from '../src/agent-runtime/builtin/codex/rpc.js';
import { performInitializeHandshake } from '../src/agent-runtime/builtin/codex/handshake.js';
import { feishuMcpCodexArgs } from '../src/agent-runtime/builtin/codex/mcp-config.js';
import { codexArgsToCli, parseCodexArgs } from '../src/agent-runtime/builtin/codex/args.js';
import { dreamuxBinPath } from '../src/platform/package-bin.js';
import {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
  Server,
} from '../src/server.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
  type FeishuInboundEvent,
} from '../src/channel/feishu/bot.js';
import { saveDispatcherAccess } from '../src/channel/feishu/feishu-gate.js';
import type { DreamuxConfig } from '../src/config/config.js';
import type {
  ServerNotification,
  ThreadStartResponse,
} from '../src/agent-runtime/builtin/codex/types.js';
import { testDispatcherConfig } from './helpers/config.js';

export const SKIP_ENV = 'DREAMUX_SKIP_LIVE_CODEX';
export const MODEL_GATE_ENV = 'DREAMUX_RUN_LIVE_MODEL_GATE';

export type Detection =
  | { state: 'ok'; version: string }
  | { state: 'missing'; reason: string };

/**
 * Pure-ish decision logic, split out so it can be unit-tested without
 * actually executing `codex`. `versionFetcher` is what would normally call
 * `codex --version`; returning `null` (or throwing) means codex is missing.
 */
export function classifyDetection(
  rawOutput: string | null,
): Detection {
  if (rawOutput === null) {
    return { state: 'missing', reason: 'codex CLI did not respond to --version' };
  }
  const m = rawOutput.match(/(\d+\.\d+\.\d+)/);
  if (!m) return { state: 'missing', reason: `unparseable codex --version output: ${rawOutput}` };
  return { state: 'ok', version: m[1]! };
}

function detectCodex(): Detection {
  let out: string;
  try {
    out = execSync('codex --version', {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { state: 'missing', reason };
  }
  return classifyDetection(out);
}

function versionAtLeast(version: string, min: string): boolean {
  const actualParts = version.split('.').map((part) => Number.parseInt(part, 10));
  const minParts = min.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(actualParts.length, minParts.length); i += 1) {
    const actual = actualParts[i] ?? 0;
    const expected = minParts[i] ?? 0;
    if (actual > expected) return true;
    if (actual < expected) return false;
  }
  return true;
}

interface McpServerStatusListResponse {
  data: Array<{
    name: string;
    tools?: Record<string, { name: string }>;
  }>;
}

interface RecordedRequest {
  method: string;
  params: unknown;
  sentAt: number;
  ackedAt: number | null;
  result: unknown;
  error: string | null;
}

interface RecordedNotification {
  at: number;
  notification: ServerNotification;
}

class RecordingCodexWsClient extends CodexWsClient {
  readonly requests: RecordedRequest[] = [];
  readonly notifications: RecordedNotification[] = [];

  constructor(opts: CodexWsClientOptions) {
    super(opts);
    this.onNotification((notification) => {
      this.notifications.push({ at: Date.now(), notification });
    });
  }

  override async request<R = unknown>(
    method: string,
    params: unknown,
  ): Promise<R> {
    const record: RecordedRequest = {
      method,
      params,
      sentAt: Date.now(),
      ackedAt: null,
      result: null,
      error: null,
    };
    this.requests.push(record);
    try {
      const result = await super.request<R>(method, params);
      record.ackedAt = Date.now();
      record.result = result;
      return result;
    } catch (err) {
      record.ackedAt = Date.now();
      record.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
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
    senderId: 'sender-live',
    senderType: 'user',
    senderName: 'Live Tester',
    messageType: 'text',
    rawContent: JSON.stringify({ text }),
    parsedText: text,
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-live' },
        name: 'Dispatcher',
      },
    ],
    createTime: String(Date.now()),
    raw: { event: { message: { chat_id: chatId, message_id: messageId } } },
  };
}

function liveConfig(dispatcherCwd: string, codexHomeEnv: string): DreamuxConfig {
  return {
    dispatchers: [
      testDispatcherConfig({
        id: 'live',
        cwd: dispatcherCwd,
        enabled: true,
        feishu: {
          app_id: 'app-live',
          app_secret: 'secret-server-only',
        },
        codex: {
          bin: 'codex',
          approval_policy: 'never',
          sandbox_mode: 'danger-full-access',
          extra_args: [],
          extra_env: {
            HOME: codexHomeEnv,
          },
          // A longer handshake margin for the real codex app-server, now a
          // dispatcher-local field rather than a global default.
          initialize_timeout_ms: 15000,
        },
      }),
    ],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function notifications(
  client: RecordingCodexWsClient,
  method: string,
): RecordedNotification[] {
  return client.notifications.filter(
    (entry) => entry.notification.method === method,
  );
}

function hasCommandExecutionStarted(client: RecordingCodexWsClient): boolean {
  return notifications(client, 'item/started').some((entry) => {
    const params = entry.notification.params;
    if (params === null || typeof params !== 'object') return false;
    const item = (params as Record<string, unknown>)['item'];
    return (
      item !== null &&
      typeof item === 'object' &&
      (item as Record<string, unknown>)['type'] === 'commandExecution'
    );
  });
}

function turnStartRequests(client: RecordingCodexWsClient): RecordedRequest[] {
  return client.requests.filter((request) => request.method === 'turn/start');
}

describe('codex live integration', () => {
  const skipRequested = process.env[SKIP_ENV] === '1';
  const detection = detectCodex();
  const runModelGate =
    process.env[MODEL_GATE_ENV] === '1' || process.env['CI'] !== 'true';

  if (skipRequested) {
    // Opt-in skip — loud so it can't be missed in CI / local output.
    console.warn(
      `[codex-live] SKIPPED via ${SKIP_ENV}=1. ` +
        `Detected codex: state=${detection.state}` +
        (detection.state === 'ok' ? ` version=${detection.version}` : '') +
        `. Real codex app-server compatibility is NOT being verified by this run.`,
    );
    it.skip(`live integration skipped via ${SKIP_ENV}=1`, () => {
      /* skipped on purpose */
    });
    return;
  }

  if (detection.state === 'missing') {
    it('requires codex on PATH', () => {
      throw new Error(
        `dreamux's codex compat test requires the codex CLI on PATH. ` +
          `Detection: ${detection.reason}. ` +
          `Install @openai/codex@latest, or set ${SKIP_ENV}=1 to explicitly opt out (loud skip).`,
      );
    });
    return;
  }

  // From here on we know codex is on PATH and reports a parseable version.
  if (!runModelGate) {
    console.warn(
      `[codex-live] issue #63 mid-turn model gate SKIPPED in CI. ` +
        `Set ${MODEL_GATE_ENV}=1 in an environment with usable Codex model auth ` +
        `to verify the real model/tool folding path.`,
    );
  }

  it(
    `spawns codex ${detection.version}, completes init handshake, starts a thread`,
    async () => {
      const dir = mkdtempSync(join(homedir(), '.dreamux-e2e-'));
      const socketPath = join(dir, 'codex.sock');
      const cwd = join(dir, 'cwd');

      // Use the same parser the runtime uses — exercises the
      // `-c approval_policy=never` codepath end-to-end.
      const extraArgs = codexArgsToCli(
        parseCodexArgs('{"sandboxMode":"danger-full-access"}'),
      );

      const proc = new CodexProcess({
        socketPath,
        cwd,
        stdoutLogPath: join(dir, 'stdout.log'),
        stderrLogPath: join(dir, 'stderr.log'),
        extraArgs,
        readyTimeoutMs: 15_000,
      });

      try {
        await proc.start();
        const client = new CodexWsClient({ socketPath });
        try {
          await client.ready();
          const init = await performInitializeHandshake(client);
          // userAgent shape is daemon-driven (older lines echoed the
          // client name into a long descriptor) — don't assert content
          // beyond non-empty string.
          expect(typeof init.userAgent).toBe('string');
          expect(init.userAgent.length).toBeGreaterThan(0);
          expect(init.platformOs).toBeDefined();

          // The real test: a business RPC after handshake must not get
          // "Not initialized". Response shape is the daemon's concern.
          const ts = await client.request<ThreadStartResponse>(
            'thread/start',
            {},
          );
          expect(typeof ts.thread.id).toBe('string');
          expect(ts.thread.id.length).toBeGreaterThan(0);
        } finally {
          client.close();
        }
      } finally {
        await proc.reap();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    `spawns codex ${detection.version} with the Feishu stdio MCP shim`,
    async () => {
      if (!versionAtLeast(detection.version, '0.136.0')) {
        throw new Error(
          `dreamux's Feishu MCP injection gate requires codex >= 0.136.0; detected ${detection.version}`,
        );
      }

      const dreamuxBin = dreamuxBinPath();
      if (!isAbsolute(dreamuxBin) || !existsSync(dreamuxBin)) {
        throw new Error(
          `dreamux Feishu MCP live test requires an absolute built dreamux bin path; got ${dreamuxBin}`,
        );
      }

      const dir = mkdtempSync(join(homedir(), '.dreamux-e2e-'));
      const socketPath = join(dir, 'codex.sock');
      const cwd = join(dir, 'cwd');
      const extraArgs = [
        ...codexArgsToCli(
          parseCodexArgs('{"sandboxMode":"danger-full-access"}'),
        ),
        ...feishuMcpCodexArgs({
          dispatcherId: 'dispatcher-a',
          adminSocketPath: join(dir, 'admin.sock'),
          command: dreamuxBin,
        }),
      ];

      const proc = new CodexProcess({
        socketPath,
        cwd,
        stdoutLogPath: join(dir, 'stdout.log'),
        stderrLogPath: join(dir, 'stderr.log'),
        extraArgs,
        readyTimeoutMs: 15_000,
      });

      try {
        await proc.start();
        const client = new CodexWsClient({ socketPath });
        try {
          await client.ready();
          await performInitializeHandshake(client);
          const status = await client.request<McpServerStatusListResponse>(
            'mcpServerStatus/list',
            {},
          );
          const feishu = status.data.find((server) => server.name === 'feishu');
          expect(feishu).toBeDefined();
          expect(feishu?.tools?.['reply']?.name).toBe('reply');
          expect(feishu?.tools?.['react']?.name).toBe('react');
        } finally {
          client.close();
        }
      } finally {
        await proc.reap();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  (runModelGate ? it : it.skip)(
    `folds mid-turn Feishu inbound submitted via turn/start and completes reaction tri-state`,
    async () => {
      if (!versionAtLeast(detection.version, '0.136.0')) {
        throw new Error(
          `dreamux's issue #63 live gate requires codex >= 0.136.0; detected ${detection.version}`,
        );
      }

      const dreamuxBin = dreamuxBinPath();
      if (!isAbsolute(dreamuxBin) || !existsSync(dreamuxBin)) {
        throw new Error(
          `dreamux issue #63 live gate requires an absolute built dreamux bin path; got ${dreamuxBin}`,
        );
      }

      const operatorHome = homedir();
      const previousHome = process.env['HOME'];
      const previousCodexHome = process.env['CODEX_HOME'];
      const dir = mkdtempSync(join(operatorHome, '.dreamux-issue63-live-'));
      const runtimeHome = join(dir, 'home');
      const dispatcherCwd = join(dir, 'cwd');
      const adminSocket = join(dir, 'admin.sock');
      const bot = createFakeFeishuBot('app-live');
      let client: RecordingCodexWsClient | null = null;
      let server: Server | null = null;

      mkdirSync(dispatcherCwd, { recursive: true });
      process.env['HOME'] = runtimeHome;
      process.env['CODEX_HOME'] = previousCodexHome ?? join(operatorHome, '.codex');
      // Onboard the live sender onto the global allow-user list so the folded
      // group messages are delivered (empty `allow_users` authorizes nobody
      // under the follow-user gate).
      await saveDispatcherAccess('live', {
        version: 2,
        allow_users: ['sender-live'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
        observed_chats: [],
        warnings: [],
        last_gate: null,
      });

      try {
        server = new Server({
          config: liveConfig(dispatcherCwd, operatorHome),
          adminSocketPath: adminSocket,
          skipBotSecret: true,
          botFactory: () => bot,
          codexClientFactory: (socketPath) => {
            client = new RecordingCodexWsClient({ socketPath });
            return client;
          },
          codexHomeDoctor: () => {
            /* real Codex auth is supplied through CODEX_HOME above */
          },
        });
        await server.start();
        expect(client).not.toBeNull();
        const liveClient = client!;
        const marker = `ISSUE63_LIVE_MARKER_${Date.now()}`;
        const startMessageId = 'msg-live-start';
        const markerMessageId = 'msg-live-marker';
        const startPrompt = [
          'Integration gate for dreamux issue #63.',
          'Do exactly this sequence:',
          '1. First call exec_command with cmd "sleep 6; echo issue63-sleep-done" and wait until it completes.',
          '2. After that command returns, inspect any later Feishu inbound message folded into this same turn.',
          '3. When you see a later message containing a token that starts with ISSUE63_LIVE_MARKER_, call the Feishu MCP reply tool.',
          '4. Reply to that later message, not this setup message, and include the marker token verbatim in the reply text.',
          'Do not send any plain assistant answer before the Feishu MCP reply call.',
        ].join('\n');

        await bot.inject(fakeInbound('chat-live', startPrompt, startMessageId));
        await waitFor(
          () => turnStartRequests(liveClient).length === 1,
          10_000,
          'first turn/start accepted',
        );
        await waitFor(
          () => hasCommandExecutionStarted(liveClient),
          45_000,
          'command execution started before marker injection',
        );
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(0);

        await bot.inject(
          fakeInbound(
            'chat-live',
            `Please handle this folded marker now: ${marker}`,
            markerMessageId,
          ),
        );
        const markerTurnStart = turnStartRequests(liveClient)[1];
        expect(markerTurnStart).toBeDefined();
        expect(markerTurnStart!.ackedAt).not.toBeNull();
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(0);

        await waitFor(
          () => bot.sentMessages.some((message) => message.text.includes(marker)),
          120_000,
          'model replied through Feishu MCP with folded marker',
        );

        const markerReply = bot.sentMessages.find((message) =>
          message.text.includes(marker),
        );
        expect(markerReply).toMatchObject({
          chatId: 'chat-live',
          target: {
            chatId: 'chat-live',
            replyToMessageId: markerMessageId,
          },
        });

        await waitFor(
          () => notifications(liveClient, 'turn/completed').length >= 1,
          30_000,
          'active turn completed',
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(turnStartRequests(liveClient)).toHaveLength(2);
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(1);

        const markerReactions = bot.reactions.filter(
          (reaction) => reaction.messageId === markerMessageId,
        );
        expect(markerReactions.map((reaction) => reaction.emoji)).toEqual([
          RECEIVED_REACTION_EMOJI,
          IN_PROGRESS_REACTION_EMOJI,
        ]);
        const markerRemoved = bot.removedReactions.filter(
          (reaction) => reaction.messageId === markerMessageId,
        );
        expect(markerRemoved.map((reaction) => reaction.reactionId)).toEqual(
          markerReactions.map((reaction) => reaction.reactionId),
        );
      } finally {
        await server?.shutdown();
        if (previousHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
        else process.env['CODEX_HOME'] = previousCodexHome;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

// Unit coverage of the classification logic itself — these run regardless of
// whether codex is installed, and prove that detection behaves as the live
// test above relies on.
describe('codex detection logic', () => {
  it('classifies parseable versions as ok', () => {
    expect(classifyDetection('codex-cli 0.135.0')).toEqual({
      state: 'ok',
      version: '0.135.0',
    });
    expect(classifyDetection('codex-cli 0.136.0')).toEqual({
      state: 'ok',
      version: '0.136.0',
    });
    expect(classifyDetection('codex-cli 1.0.0')).toEqual({
      state: 'ok',
      version: '1.0.0',
    });
  });

  it('classifies missing/unparseable inputs as missing', () => {
    expect(classifyDetection(null).state).toBe('missing');
    expect(classifyDetection('not a version string').state).toBe('missing');
    expect(classifyDetection('').state).toBe('missing');
  });

  it('compares codex semver versions', () => {
    expect(versionAtLeast('0.136.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.137.0', '0.136.0')).toBe(true);
    expect(versionAtLeast('0.135.9', '0.136.0')).toBe(false);
  });
});
