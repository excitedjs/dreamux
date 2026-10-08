/** Actual Codex process/model fixture; observations call through the real transport. */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeStateUpdate,
  RuntimeActivity,
} from '@excitedjs/dreamux-types';
import {
  createCodexAgentRuntimeProvider,
  defaultDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from '@excitedjs/agent-runtime-codex';
// Test-only internal coupling: public provider creation is sufficient for execution,
// but native RPC/version/notification observations have no public equivalent.
import { CodexWsClient } from '../../../agent-runtime/codex/dist/rpc.js';
import { codexVersionSatisfies } from '../../../agent-runtime/codex/dist/version.js';
import type { ServerNotification } from '../../../agent-runtime/codex/dist/types.js';
import { createLogger } from '../../src/platform/logger.js';

const capture = promisify(execFile);
export const skipLiveModelGate =
  process.env['DREAMUX_SKIP_LIVE_CODEX'] === '1' ||
  process.env['DREAMUX_RUN_LIVE_MODEL_GATE'] !== '1';
if (skipLiveModelGate)
  console.warn(
    '[codex-native-live] Model cases excluded; set DREAMUX_RUN_LIVE_MODEL_GATE=1 with usable auth to certify native model behavior. DREAMUX_SKIP_LIVE_CODEX=1 excludes all live Codex checks.',
  );

export interface LiveCodexRequest {
  readonly client: CodexWsClient;
  readonly method: string;
  readonly params: unknown;
  result?: unknown;
}

export async function liveCodexProvider() {
  const bin = process.env['CODEX_HOST_CODEX_BIN']?.trim() || 'codex';
  const { stdout } = await capture(bin, ['--version']);
  if (!codexVersionSatisfies(stdout))
    throw new Error(
      `Unsupported or unparseable live Codex version: ${stdout.trim()}`,
    );
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-native-live-'));
  const cwd = join(dir, 'cwd');
  const codexHome = join(dir, 'codex');
  const authHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
  try {
    await Promise.all([mkdir(cwd), mkdir(codexHome)]);
    // Preserve the actual configured model/provider and usable auth, as #63
    // does, without copying operator sessions or editing the operator home.
    for (const file of ['auth.json', 'config.toml']) {
      try {
        await copyFile(join(authHome, file), join(codexHome, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const config: DispatcherCodexConfig = {
    ...defaultDispatcherCodexConfig(),
    bin,
    sandbox_mode: 'danger-full-access',
    extra_env: { CODEX_HOME: codexHome },
    initialize_timeout_ms: 15_000,
  };
  const paths = {
    cacheDir: () => join(dir, 'cache'),
    logsDir: () => join(dir, 'logs'),
    runtimeSocketDirs: () => [dir],
  };
  const requests: LiveCodexRequest[] = [];
  const clients: CodexWsClient[] = [];
  const notifications: Array<{
    client: CodexWsClient;
    notification: ServerNotification;
  }> = [];
  const original = CodexWsClient.prototype.request;
  const requestSpy = vi
    .spyOn(CodexWsClient.prototype, 'request')
    .mockImplementation(async function <R = unknown>(
      this: CodexWsClient,
      method: string,
      params: unknown,
    ): Promise<R> {
      if (!clients.includes(this)) {
        clients.push(this);
        this.onNotification((notification) => {
          notifications.push({ client: this, notification });
        });
      }
      const row: LiveCodexRequest = { client: this, method, params };
      requests.push(row);
      const result = await original.call(this, method, params);
      row.result = result;
      return result as R;
    });
  const provider = createCodexAgentRuntimeProvider();
  const runtimes: AgentRuntime[] = [];
  const logger = createLogger({ destination: { write() {} } });
  async function create(
    runtimeId: string,
    sessionId: string | null,
    options: {
      config?: DispatcherCodexConfig;
      outputSchema?: AgentRuntimeCreateContext<DispatcherCodexConfig>['outputSchema'];
    } = {},
  ) {
    const updates: AgentRuntimeStateUpdate[] = [];
    const activities: RuntimeActivity[] = [];
    const context: AgentRuntimeCreateContext<DispatcherCodexConfig> = {
      identity: { runtimeId, sessionId },
      config: options.config ?? config,
      cwd,
      mcpServers: [],
      skillSources: [],
      disabledFeatures: [],
      paths,
      state: {
        async publish(update) {
          updates.push(update);
        },
      },
      activity: (activity) => {
        activities.push(activity);
      },
      logger,
      ...(options.outputSchema === undefined
        ? {}
        : { outputSchema: options.outputSchema }),
    };
    const runtime = await provider.createRuntime(context);
    runtimes.push(runtime);
    return { runtime, context, updates, activities };
  }
  async function dispose() {
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.stop()),
    );
    requestSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Live Codex runtimes did not stop',
      );
  }
  return {
    dir,
    cwd,
    codexHome,
    version: stdout.trim(),
    config,
    paths,
    provider,
    clients,
    requests,
    notifications,
    create,
    dispose,
  };
}

export async function completeLiveTurn(
  runtime: AgentRuntime,
  text: string,
): Promise<string | null> {
  const admission = await runtime.submit({ text });
  if (admission.status !== 'submitted')
    throw new Error(`Real Codex turn admission was ${admission.status}`);
  const settlement = await admission.submission.settled;
  if (settlement.kind !== 'completion') {
    if (settlement.kind === 'failed') throw settlement.error;
    throw new Error(`Real Codex turn settled as ${settlement.kind}`);
  }
  if (settlement.completion.status !== 'completed')
    throw settlement.completion.error;
  return settlement.completion.resultText;
}
