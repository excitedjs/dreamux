/**
 * Live integration test against a real codex app-server — the issue #63
 * non-blocking-inbound gate, restored on the CURRENT provider-seam contracts
 * (Stage 9 architecture refactor, node `live-codex-gate`).
 *
 * This is a from-scratch rebuild, not a port. The `next`-branch original
 * (`git show next:packages/dreamux/tests/codex-live.test.ts`) targeted
 * contracts this refactor deleted outright:
 *   - `AgentRuntimeStateCallbacks` / `RuntimeTurnOutcome` / `completionInput`
 *     -> `AgentRuntimeStateSink` / `RuntimeSubmissionSettlement` / `submit`.
 *   - `CodexRuntime` was directly importable from `@excitedjs/agent-runtime-codex`;
 *     it is now a package-internal implementation detail. Every direct-runtime
 *     case here goes through the neutral seam instead:
 *     `createCodexAgentRuntimeProvider(options).createRuntime(context)`.
 *   - `dispatcherMcpServerDescriptors()` (`mcp-descriptors.ts`) built one
 *     dedicated Feishu MCP server per runtime by hand. That file is gone: MCP
 *     server composition is now automatic (`TeammateRuntimeOwner`, one
 *     generic `dreamux mcp --admin-socket <path>` shim per delegate, see
 *     `/packages/dreamux/src/service/mcp/descriptor.ts`), so a live test that
 *     wants real Feishu tools reachable from Codex just starts the real
 *     `Server` and lets production wiring mint the MCP servers — there is no
 *     surface left to construct by hand.
 *   - The issue #63 reaction TRI-STATE (`RECEIVED_REACTION_EMOJI` /
 *     `IN_PROGRESS_REACTION_EMOJI`, add-then-cancel ordering) is a DELETED
 *     surface, not a renamed one: `.agents/reference/current-architecture.md`
 *     states plainly "Automatic received/in-progress reactions are removed;
 *     the explicit model-facing `react` tool remains", and
 *     `.agents/domains/non-blocking-dispatcher-inbound.md`'s own Tests section
 *     requires proving "no automatic reaction is added on inbound, submission,
 *     or settlement". This file asserts exactly that negative instead of a
 *     tri-state that no longer exists — see `fakeBot.reactions` in the folding
 *     test below.
 *
 * FEASIBILITY GATE (checked against current source before writing anything
 * here — see the task's mandatory pre-check):
 *   - `ServerOptions` (`/packages/dreamux/src/server.ts`) still accepts
 *     `agentRuntimeProviderCatalog`, `channelProviderCatalog`, `config`,
 *     `adminSocketPath`, `logger`, `runtimeSocketSweep`, `legacyAdminLockPath`
 *     — confirmed by reading the file.
 *   - `@excitedjs/agent-runtime-codex`'s `createCodexAgentRuntimeProvider`
 *     still accepts `codexClientFactory` / `codexHomeDoctor` and omits
 *     `codexProcessFactory` by default, so a test can record the WS traffic
 *     while still spawning the REAL `codex` binary — confirmed in
 *     `provider.ts`.
 *   - `@excitedjs/feishu-channel`'s `createFeishuChannelProvider` still
 *     accepts `botFactory`, and `saveDispatcherAccess` still exists — both
 *     confirmed in `provider.ts` / `feishu-gate-io.ts`.
 *   Every required seam still exists under test-only code; nothing here
 *   required a `src/**` change. What changed is HOW those seams are reached
 *   (through the provider registry/catalog, not ad-hoc construction), and
 *   that is reflected in `./helpers/live-catalogs.ts`.
 *
 * **Default behavior**: missing/unparseable `codex --version` fails loudly.
 * The whole point is to verify compatibility; a silent skip in CI defeats it.
 *
 * **Escape hatch**: set `DREAMUX_SKIP_LIVE_CODEX=1` to explicitly opt out
 * (e.g. dev machines without codex, or pre-merge sandboxes). The skip emits a
 * loud `console.warn` so it's visible in test output.
 *
 * The real-model gates need a usable Codex model login, not just the
 * app-server binary. They run by default outside CI. CI loud-skips them
 * unless `DREAMUX_RUN_LIVE_MODEL_GATE=1` is set, because public CI cannot
 * assume an operator's interactive Codex auth is available.
 */

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- live-Codex probe: a one-shot `execSync` reads `codex --version` / the operator's interactive Codex auth state to decide whether a live case can run at all; it is setup, not the code under test, and must complete before the suite proceeds (issue #85 test-scope carve-out, matching the restored next-branch original).
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CodexProcess,
  CodexWsClient,
  type CodexWsClientOptions,
  performInitializeHandshake,
  codexArgsToCli,
  parseCodexArgs,
  createCodexAgentRuntimeProvider,
  defaultDispatcherCodexConfig,
  type DispatcherCodexConfig,
  type ServerNotification,
  type ThreadStartResponse,
} from '@excitedjs/agent-runtime-codex';
import {
  saveDispatcherAccess,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import type {
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentRuntimeCreateContext,
  AgentRuntimePathContext,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

import { Server } from '../src/server.js';
import { dispatcherDir } from '../src/platform/paths.js';
import { dreamuxBinPath } from '../src/platform/package-bin.js';
import type { DreamuxConfig } from '../src/config/config.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  codexAgentRuntimeCatalog,
  feishuChannelCatalog,
} from './helpers/live-catalogs.js';

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
export function classifyDetection(rawOutput: string | null): Detection {
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
    out = execSync('codex --version', { stdio: ['ignore', 'pipe', 'pipe'] })
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
  data: Array<{ name: string; tools?: Record<string, { name: string }> }>;
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

  override async request<R = unknown>(method: string, params: unknown): Promise<R> {
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

function fakeInbound(chatId: string, text: string, messageId: string): FeishuInboundEvent {
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
      { key: '@_user_1', id: { open_id: 'fake-open-id-app-live' }, name: 'Dispatcher' },
    ],
    createTime: String(Date.now()),
    raw: { event: { message: { chat_id: chatId, message_id: messageId } } },
  };
}

function liveConfig(dispatcherCwd: string, codexHomeEnv: string): DreamuxConfig {
  const dispatcher = testDispatcherConfig({
    id: 'live',
    cwd: dispatcherCwd,
    enabled: true,
    feishu: { app_id: 'app-live', app_secret: 'secret-server-only' },
    codex: {
      bin: 'codex',
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      extra_args: [],
      extra_env: { HOME: codexHomeEnv },
      initialize_timeout_ms: 15000,
    },
  });
  return testDreamuxConfig([dispatcher]);
}

function createIsolatedCodexHome(dir: string): string {
  const codexHome = join(dir, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const sourceAuth = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'auth.json');
  if (existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, join(codexHome, 'auth.json'));
  }
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      '',
      '[features]',
      'apps = false',
      '',
      '[apps._default]',
      'enabled = false',
      'destructive_enabled = false',
      'open_world_enabled = false',
      '',
    ].join('\n'),
  );
  return codexHome;
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

function notifications(client: RecordingCodexWsClient, method: string): RecordedNotification[] {
  return client.notifications.filter((entry) => entry.notification.method === method);
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

function notificationDebugSummary(client: RecordingCodexWsClient): string {
  return client.notifications
    .slice(-20)
    .map((entry) => {
      const params = entry.notification.params;
      let itemType: unknown = null;
      let detail = '';
      if (params !== null && typeof params === 'object') {
        const record = params as Record<string, unknown>;
        const item = record['item'];
        if (item !== null && typeof item === 'object') {
          itemType = (item as Record<string, unknown>)['type'];
        }
        const status = record['status'];
        if (typeof status === 'string') detail = `:${status}`;
        const errorText = record['error'];
        if (typeof errorText === 'string') detail += `:${errorText}`;
      }
      return `${entry.notification.method}:${String(itemType)}${detail}`;
    })
    .join(', ');
}

function turnStartRequests(client: RecordingCodexWsClient): RecordedRequest[] {
  return client.requests.filter((request) => request.method === 'turn/start');
}

// ── Direct-provider harness (no Server, no Feishu) ─────────────────────────
//
// Item 3's "start continuity" and "structured-output binding at create time"
// cases need only the neutral AgentRuntimeProvider seam, not a whole
// dispatcher. Building the AgentRuntimeCreateContext by hand here is the
// BEHAVIORAL boundary these facts actually live on now that `CodexRuntime`
// itself is package-internal (see the file banner).

function runtimePaths(dir: string): AgentRuntimePathContext {
  return {
    cacheDir: () => join(dir, 'cache'),
    logsDir: () => join(dir, 'logs'),
    runtimeSocketDirs: () => [dir],
  };
}

function recordingStateSink(): {
  sink: AgentRuntimeStateSink;
  updates: AgentRuntimeStateUpdate[];
} {
  const updates: AgentRuntimeStateUpdate[] = [];
  return {
    updates,
    sink: {
      async publish(update): Promise<void> {
        updates.push(update);
      },
    },
  };
}

/**
 * CODEX_HOME travels through the ambient `process.env` (codex's own
 * resolution — see `agent-runtime/codex/src/runtime-support.ts`: "the child
 * inherits the operator's ambient CODEX_HOME"), not through `extra_env`. Every
 * direct-provider case below sets `process.env.CODEX_HOME` around `start()`
 * itself; this only builds the rest of the dispatcher-codex config.
 */
function directCodexConfig(): DispatcherCodexConfig {
  return {
    ...defaultDispatcherCodexConfig(),
    bin: 'codex',
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    extra_env: {},
    initialize_timeout_ms: 15_000,
  };
}

describe('codex live integration', () => {
  const skipRequested = process.env[SKIP_ENV] === '1';
  const detection = detectCodex();
  const runModelGate =
    process.env[MODEL_GATE_ENV] === '1' || process.env['CI'] !== 'true';

  if (skipRequested) {
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

  if (!runModelGate) {
    console.warn(
      `[codex-live] live model gates SKIPPED in CI. ` +
        `Set ${MODEL_GATE_ENV}=1 in an environment with usable Codex model auth ` +
        `to verify structured output, activity, and the issue #63 folding gate.`,
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
      const extraArgs = codexArgsToCli(parseCodexArgs('{"sandboxMode":"danger-full-access"}'));

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
          expect(typeof init.userAgent).toBe('string');
          expect(init.userAgent.length).toBeGreaterThan(0);
          expect(init.platformOs).toBeDefined();

          // The real test: a business RPC after handshake must not get
          // "Not initialized". Response shape is the daemon's concern.
          const ts = await client.request<ThreadStartResponse>('thread/start', {});
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

  // Empirically NOT a structural-only case (verified against real codex
  // 0.147.0 while writing this file): `thread/start` returns a rollout
  // `path` up front, but codex does not actually create that file on disk
  // until the thread has real turn activity — resuming a thread that was
  // started but never submitted anything fails with "no rollout found for
  // thread id ...". So proving `resumed` continuity needs one real,
  // model-gated turn between `start()` and `stop()`, same as the other
  // model-gated cases below.
  (runModelGate ? it : it.skip)(
    `reports fresh continuity via the AgentRuntimeProvider seam, then resumes the same thread through real codex ${detection.version}`,
    async () => {
      const operatorHome = homedir();
      const previousCodexHome = process.env['CODEX_HOME'];
      const dir = mkdtempSync(join(operatorHome, '.dreamux-continuity-live-'));
      const isolatedCodexHome = createIsolatedCodexHome(dir);
      const cwd = join(dir, 'cwd');
      process.env['CODEX_HOME'] = isolatedCodexHome;

      const provider = createCodexAgentRuntimeProvider({
        codexHomeDoctor: () => {
          /* real Codex auth is supplied through the isolated CODEX_HOME */
        },
      });

      function context(
        sessionId: string | null,
      ): AgentRuntimeCreateContext<DispatcherCodexConfig> {
        return {
          identity: { runtimeId: 'continuity-live', sessionId },
          config: directCodexConfig(),
          cwd,
          mcpServers: [],
          skillSources: [],
          disabledFeatures: [],
          paths: runtimePaths(dir),
          state: recordingStateSink().sink,
        };
      }

      try {
        const { sink, updates } = recordingStateSink();
        const fresh = await provider.createRuntime({ ...context(null), state: sink });
        const freshOutcome = await fresh.start();
        expect(freshOutcome).toEqual({ continuity: 'fresh' });
        const sessionUpdate = updates.find((update) => update.kind === 'session');
        expect(sessionUpdate).toBeDefined();
        const sessionId =
          sessionUpdate!.kind === 'session' ? sessionUpdate!.sessionId : null;
        expect(sessionId).not.toBeNull();

        // One minimal real turn — codex only persists a resumable rollout
        // file once the thread has actual activity (see the case comment
        // above), so `resumed` continuity cannot be proven without it.
        const admission = await fresh.submit({ text: 'Reply with exactly the word ok.' });
        expect(admission.status).toBe('submitted');
        if (admission.status === 'submitted') {
          const settlement = await admission.submission.settled;
          expect(settlement.kind).toBe('completion');
        }
        await fresh.stop();

        const resumedRecording = recordingStateSink();
        const resumed = await provider.createRuntime({
          ...context(sessionId),
          state: resumedRecording.sink,
        });
        const resumedOutcome = await resumed.start();
        expect(resumedOutcome).toEqual({ continuity: 'resumed' });
        await resumed.stop();
      } finally {
        if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
        else process.env['CODEX_HOME'] = previousCodexHome;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  (runModelGate ? it : it.skip)(
    `binds an output schema at create time and returns matching structured JSON through real codex ${detection.version}`,
    async () => {
      const operatorHome = homedir();
      const previousCodexHome = process.env['CODEX_HOME'];
      const dir = mkdtempSync(join(operatorHome, '.dreamux-codex-schema-live-'));
      const isolatedCodexHome = createIsolatedCodexHome(dir);
      const cwd = join(dir, 'cwd');
      process.env['CODEX_HOME'] = isolatedCodexHome;

      const provider = createCodexAgentRuntimeProvider({
        codexHomeDoctor: () => {
          /* real Codex auth is supplied through the isolated CODEX_HOME */
        },
      });

      const outputSchema = {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['portable'] },
          score: { type: 'integer', minimum: 7, maximum: 7 },
          nullableFlag: { type: ['boolean', 'null'] },
          optionalNote: { type: 'string', enum: ['present'] },
        },
        required: ['kind', 'score', 'nullableFlag'],
        additionalProperties: false,
      };

      const { sink } = recordingStateSink();
      const runtime = await provider.createRuntime({
        identity: { runtimeId: 'schema-live', sessionId: null },
        config: directCodexConfig(),
        cwd,
        mcpServers: [],
        skillSources: [],
        disabledFeatures: [],
        outputSchema,
        paths: runtimePaths(dir),
        state: sink,
      });

      try {
        await runtime.start();
        const admission = await runtime.submit({
          text: [
            'Return the requested structured result.',
            'Use kind "portable", score 7, nullableFlag null, and optionalNote null.',
          ].join(' '),
        });
        expect(admission.status).toBe('submitted');
        if (admission.status !== 'submitted') {
          throw new Error(`portable structured-output turn was ${admission.status}`);
        }
        const settlement: RuntimeSubmissionSettlement = await admission.submission.settled;
        if (settlement.kind !== 'completion' || settlement.completion.status !== 'completed') {
          throw new Error(
            `portable structured-output turn did not complete: ${JSON.stringify(settlement)}`,
          );
        }
        const resultText = settlement.completion.resultText;
        expect(resultText).not.toBeNull();
        expect(JSON.parse(resultText ?? '')).toEqual({
          kind: 'portable',
          score: 7,
          nullableFlag: null,
        });
      } finally {
        await runtime.stop();
        if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
        else process.env['CODEX_HOME'] = previousCodexHome;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  (runModelGate ? it : it.skip)(
    `observes readRecentActivity growing while a real submitted turn is still in flight`,
    async () => {
      const operatorHome = homedir();
      const previousCodexHome = process.env['CODEX_HOME'];
      const dir = mkdtempSync(join(operatorHome, '.dreamux-codex-activity-live-'));
      const isolatedCodexHome = createIsolatedCodexHome(dir);
      const cwd = join(dir, 'cwd');
      process.env['CODEX_HOME'] = isolatedCodexHome;

      const provider = createCodexAgentRuntimeProvider({
        codexHomeDoctor: () => {
          /* real Codex auth is supplied through the isolated CODEX_HOME */
        },
      });
      const config = directCodexConfig();
      const { sink, updates } = recordingStateSink();

      const runtime = await provider.createRuntime({
        identity: { runtimeId: 'activity-live', sessionId: null },
        config,
        cwd,
        mcpServers: [],
        skillSources: [],
        disabledFeatures: [],
        paths: runtimePaths(dir),
        state: sink,
      });

      try {
        await runtime.start();
        const sessionUpdate = updates.find((update) => update.kind === 'session');
        expect(sessionUpdate).toBeDefined();
        const sessionId =
          sessionUpdate!.kind === 'session' ? sessionUpdate!.sessionId : null;
        expect(sessionId).not.toBeNull();

        const activityContext: AgentActivityReadContext<DispatcherCodexConfig> = {
          config,
          cwd,
        };
        const query: AgentActivityQuery = { sessionId: sessionId! };

        const admission = await runtime.submit({
          text: [
            'First call exec_command with cmd "sleep 3; echo activity-live-done" and wait for it.',
            'After it returns, reply with exactly the word done.',
          ].join(' '),
        });
        expect(admission.status).toBe('submitted');
        if (admission.status !== 'submitted') {
          throw new Error(`activity-live turn was ${admission.status}`);
        }

        // The session's real rollout file is being appended to by the live
        // codex process right now; poll until the provider's OWN recent-
        // activity reader (not our WS recording) observes at least one record
        // for it, proving readRecentActivity works against an actively
        // growing session rather than only a finished one.
        //
        // Right after `submit()` returns there is a real window where the
        // rollout file does not exist on disk yet — codex only creates it once
        // the thread has actual turn activity (see the neighboring continuity
        // case's comment) — during which `readRecentActivity` rejects with the
        // neutral `session_unavailable` reason rather than returning an empty
        // page. That is documented, correct provider behavior
        // (`AgentActivityError.reason`, `@excitedjs/dreamux-types`), so this
        // poll treats it exactly like "zero records so far" and keeps
        // retrying; any other rejection is a real failure and propagates.
        let midTurnCount = 0;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && midTurnCount === 0) {
          try {
            const page = await provider.readRecentActivity(query, activityContext);
            midTurnCount = page.records.length;
          } catch (err) {
            const isSessionUnavailable =
              err !== null &&
              typeof err === 'object' &&
              (err as { name?: unknown }).name === 'AgentActivityError' &&
              (err as { reason?: unknown }).reason === 'session_unavailable';
            if (!isSessionUnavailable) throw err;
          }
          if (midTurnCount === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(midTurnCount).toBeGreaterThan(0);

        const settlement = await admission.submission.settled;
        expect(settlement.kind).toBe('completion');

        const finalPage = await provider.readRecentActivity(query, activityContext);
        expect(finalPage.records.length).toBeGreaterThanOrEqual(midTurnCount);
      } finally {
        await runtime.stop();
        if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
        else process.env['CODEX_HOME'] = previousCodexHome;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  (runModelGate ? it : it.skip)(
    `folds a mid-turn Feishu inbound into the active native turn via the real Server + Dispatcher wiring, and adds no automatic reaction`,
    async () => {
      if (!versionAtLeast(detection.version, '0.136.0')) {
        throw new Error(
          `dreamux's issue #63 live gate requires codex >= 0.136.0; detected ${detection.version}`,
        );
      }

      const operatorHome = homedir();
      const previousHome = process.env['HOME'];
      const previousCodexHome = process.env['CODEX_HOME'];
      // `mcpServerDescriptor()` resolves the launcher codex spawns for every
      // Agent-facing MCP server through `dreamuxBinPath(process.env)`, which
      // prefers an ambient `DREAMUX_BIN` override over the package's own
      // `bin/dreamux`. A developer machine's shell profile commonly exports
      // `DREAMUX_BIN` pointing at a separately, globally installed `dreamux`
      // CLI (for everyday operator use) — a DIFFERENT, independently
      // versioned build than this worktree's own `packages/dreamux/bin/dreamux`.
      // If that global build predates the current MCP subcommand shape, codex
      // spawns it, its CLI parser rejects `mcp --admin-socket ...` outright,
      // and codex reports every server's handshake as
      // "connection closed: initialize response" — indistinguishable from a
      // real regression unless this is pinned. Isolating it here, like every
      // other ambient path this test overrides, is what makes this a live
      // gate on THIS worktree's own build rather than on whatever happens to
      // be on the operator's PATH/env.
      const previousDreamuxBin = process.env['DREAMUX_BIN'];
      process.env['DREAMUX_BIN'] = dreamuxBinPath({});
      const dir = mkdtempSync(join(operatorHome, '.dreamux-issue63-live-'));
      const runtimeHome = join(dir, 'home');
      const isolatedCodexHome = createIsolatedCodexHome(dir);
      const dispatcherCwd = join(dir, 'cwd');
      const adminSocket = join(dir, 'admin.sock');
      const bot = createFakeFeishuBot('app-live');
      let client: RecordingCodexWsClient | null = null;
      let server: Server | null = null;

      mkdirSync(dispatcherCwd, { recursive: true });
      process.env['HOME'] = runtimeHome;
      process.env['DREAMUX_ROOT'] = runtimeHome;
      process.env['CODEX_HOME'] = isolatedCodexHome;
      // Onboard the live sender onto the global allow-user list so the folded
      // group messages are delivered (empty `allow_users` authorizes nobody
      // under the follow-user gate).
      await saveDispatcherAccess(dispatcherDir('live'), {
        version: 3,
        dm_policy: 'pairing',
        allow_users: ['sender-live'],
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
        pending: {},
        observed_chats: [],
        warnings: [],
        last_gate: { at: 0 },
      });

      try {
        server = new Server({
          config: liveConfig(dispatcherCwd, operatorHome),
          adminSocketPath: adminSocket,
          channelProviderCatalog: feishuChannelCatalog(() => bot),
          // Codex seams live on the provider implementation now; injected via
          // the AgentRuntime catalog. No process factory is given, so the
          // real codex process is spawned (this is the live-codex path).
          agentRuntimeProviderCatalog: codexAgentRuntimeCatalog({
            codexClientFactory: (socketPath) => {
              client = new RecordingCodexWsClient({ socketPath });
              return client;
            },
            codexHomeDoctor: () => {
              /* real Codex auth is supplied through CODEX_HOME above */
            },
          }),
        });
        await server.start();
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
        await waitFor(() => client !== null, 10_000, 'dispatcher runtime started');
        const liveClient = client!;
        await waitFor(
          () => turnStartRequests(liveClient).length === 1,
          10_000,
          'first turn/start accepted',
        );

        // The Feishu MCP surface (reply/react/list_chat_bots) is composed
        // automatically now (no dispatcherMcpServerDescriptors() left to call
        // by hand); confirm the real codex app-server actually reached it
        // through the generic `dreamux mcp` shim before relying on the model
        // calling `reply` later in this same test. The server's advertised
        // name is the Channel MCP delegate's own namespacing
        // (`channel-<configured channel id>`, see `SERVER_NAME_PREFIX` in
        // `service/channel-service/mcp-delegate.ts`) — there is no longer a
        // literal `feishu` server name, since the delegate is generic over
        // any Channel provider and namespaces by the operator's own channel
        // id, not the provider's identity.
        //
        // codex connects each Agent-facing MCP server lazily rather than at
        // spawn: `mcpServerStatus/list` can legitimately report a known
        // server with an empty `tools: {}` for tens of seconds after the
        // first turn is accepted, right up until codex actually needs a
        // tool. Poll generously until the tool map is populated rather than
        // asserting on an early snapshot.
        let feishu: McpServerStatusListResponse['data'][number] | undefined;
        {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const status = await liveClient.request<McpServerStatusListResponse>(
              'mcpServerStatus/list',
              {},
            );
            feishu = status.data.find((entry) => entry.name === 'channel-primary');
            if (feishu !== undefined && Object.keys(feishu.tools ?? {}).length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        expect(feishu).toBeDefined();
        expect(feishu?.tools?.['reply']?.name).toBe('reply');
        expect(feishu?.tools?.['list_chat_bots']?.name).toBe('list_chat_bots');

        try {
          await waitFor(
            () => hasCommandExecutionStarted(liveClient),
            45_000,
            'command execution started before marker injection',
          );
        } catch (err) {
          const suffix = notificationDebugSummary(liveClient);
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}; recent notifications: ${suffix}`,
          );
        }
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(0);

        await bot.inject(
          fakeInbound('chat-live', `Please handle this folded marker now: ${marker}`, markerMessageId),
        );
        const markerTurnStart = turnStartRequests(liveClient)[1];
        expect(markerTurnStart).toBeDefined();
        expect(markerTurnStart!.ackedAt).not.toBeNull();
        // Folding proof: a second accepted `turn/start` does not itself
        // complete or start a parallel turn — see
        // `.agents/domains/non-blocking-dispatcher-inbound.md` "Codex Contract".
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(0);

        try {
          await waitFor(
            () => bot.sentMessages.some((message) => message.text.includes(marker)),
            120_000,
            'model replied through Feishu MCP with folded marker',
          );
        } catch (err) {
          const suffix = notificationDebugSummary(liveClient);
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}; recent notifications: ${suffix}`,
          );
        }

        const markerReply = bot.sentMessages.find((message) => message.text.includes(marker));
        expect(markerReply).toMatchObject({
          chatId: 'chat-live',
          target: { chatId: 'chat-live', replyToMessageId: markerMessageId },
        });

        await waitFor(
          () => notifications(liveClient, 'turn/completed').length >= 1,
          30_000,
          'active turn completed',
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(turnStartRequests(liveClient)).toHaveLength(2);
        expect(notifications(liveClient, 'turn/completed')).toHaveLength(1);

        // The issue #63 automatic reaction tri-state is a deleted surface
        // (see file banner): assert its replacement contract instead — no
        // reaction is ever added automatically across the whole delivery.
        // The model was never instructed to call the deliberate `react`
        // tool in this prompt, so an empty array also proves that surface
        // stayed silent unless a model explicitly asks for it.
        expect(bot.reactions).toEqual([]);
      } finally {
        await server?.shutdown();
        if (previousHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = previousHome;
        delete process.env['DREAMUX_ROOT'];
        if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
        else process.env['CODEX_HOME'] = previousCodexHome;
        if (previousDreamuxBin === undefined) delete process.env['DREAMUX_BIN'];
        else process.env['DREAMUX_BIN'] = previousDreamuxBin;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // Longer than the other live cases: this one waits out codex's own lazy
    // per-server MCP connect (up to 60s), the setup turn's exec_command, and
    // the folded-turn reply, in sequence rather than in parallel.
    240_000,
  );
});

// Unit coverage of the classification logic itself — these run regardless of
// whether codex is installed, and prove that detection behaves as the live
// tests above rely on.
describe('codex detection logic', () => {
  it('classifies parseable versions as ok', () => {
    expect(classifyDetection('codex-cli 0.135.0')).toEqual({ state: 'ok', version: '0.135.0' });
    expect(classifyDetection('codex-cli 0.136.0')).toEqual({ state: 'ok', version: '0.136.0' });
    expect(classifyDetection('codex-cli 1.0.0')).toEqual({ state: 'ok', version: '1.0.0' });
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
