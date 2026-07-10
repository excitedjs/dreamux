import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { MimoHttpClient, type MimoClient } from './client.js';
import type { MimoCodeConfig } from './config.js';
import type {
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
} from '@excitedjs/dreamux-types';

export interface MimoServerStartOptions {
  runtimeId: string;
  config: MimoCodeConfig;
  cwd: string;
  paths: AgentRuntimePathContext;
  injectEnv?: Record<string, string>;
  mcpServers: readonly AgentRuntimeMcpServer[];
  systemPrompt: string | null;
}

export interface MimoProcessEnvOptions {
  config: MimoCodeConfig;
  homeDir: string;
  username: string;
  password: string;
  configPath: string;
  injectEnv?: Record<string, string>;
}

export interface MimoServerHandle {
  readonly homeDir: string;
  readonly baseUrl: string;
  readonly username: string | null;
  readonly password: string | null;
  readonly client: MimoClient;
  stop(): Promise<void>;
}

export type MimoServerFactory = (
  options: MimoServerStartOptions,
) => Promise<MimoServerHandle>;

type MimoChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class MimoServeProcess implements MimoServerHandle {
  readonly client: MimoClient;

  constructor(
    readonly homeDir: string,
    readonly baseUrl: string,
    readonly username: string | null,
    readonly password: string | null,
    private readonly child: MimoChildProcess,
    private readonly keepHome: boolean,
  ) {
    this.client = new MimoHttpClient({ baseUrl, username, password });
  }

  async stop(): Promise<void> {
    if (!this.child.killed) this.child.kill('SIGTERM');
    await new Promise<void>((resolveStop) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolveStop();
        return;
      }
      const timer = globalThis.setTimeout(() => {
        if (!this.child.killed) this.child.kill('SIGKILL');
        resolveStop();
      }, 2_000);
      this.child.once('exit', () => {
        globalThis.clearTimeout(timer);
        resolveStop();
      });
    });
    if (!this.keepHome) {
      await rm(this.homeDir, { recursive: true, force: true });
    }
  }
}

export async function createDefaultMimoServer(
  options: MimoServerStartOptions,
): Promise<MimoServerHandle> {
  const homeDir = resolve(
    join(options.paths.dispatcherDir(options.runtimeId), 'mimo-code-home'),
  );
  await mkdir(homeDir, { recursive: true });
  const configPath = join(homeDir, 'config.json');
  await writeFile(
    configPath,
    buildMimoNativeConfig(options, await readOperatorNativeConfig(options.config)),
    { mode: 0o600 },
  );

  const username = 'mimocode';
  const password = `dreamux-${options.runtimeId}-${Date.now()}`;
  const env = buildMimoProcessEnv({
    config: options.config,
    homeDir,
    username,
    password,
    configPath,
    ...(options.injectEnv !== undefined ? { injectEnv: options.injectEnv } : {}),
  });
  const args = ['serve', '--hostname', '127.0.0.1', '--port', '0'];
  const child = spawn(options.config.bin, args, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = await waitForServerUrl(child, options.config.startup_timeout_ms);
  return new MimoServeProcess(
    homeDir,
    baseUrl,
    username,
    password,
    child,
    options.config.keep_home,
  );
}

export function buildMimoProcessEnv(
  options: MimoProcessEnvOptions,
): NodeJS.ProcessEnv {
  return {
    ...globalThis.process.env,
    ...(options.injectEnv ?? {}),
    ...options.config.extra_env,
    MIMOCODE_HOME: options.homeDir,
    MIMOCODE_MIMO_ONLY: 'true',
    MIMOCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    MIMOCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    MIMOCODE_DISABLE_MODELS_FETCH: 'true',
    MIMOCODE_DISABLE_CLAUDE_CODE_MCP: 'true',
    MIMOCODE_ENABLE_ANALYSIS: 'false',
    MIMOCODE_SERVER_USERNAME: options.username,
    MIMOCODE_SERVER_PASSWORD: options.password,
    MIMOCODE_CONFIG: options.configPath,
  };
}

export function buildMimoNativeConfig(
  options: MimoServerStartOptions,
  operatorConfig: Record<string, unknown> = {},
): string {
  const config: Record<string, unknown> = {
    ...operatorConfig,
    share: 'disabled',
    mcp: Object.fromEntries(
      options.mcpServers.map((server) => [
        server.name,
        {
          type: 'local',
          command: [server.command, ...server.args],
        },
      ]),
    ),
  };
  if (options.config.model !== null) config.model = options.config.model;
  config.permission = 'deny';
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function readOperatorNativeConfig(
  config: MimoCodeConfig,
): Promise<Record<string, unknown>> {
  const raw =
    config.config_content ??
    (config.config_path === null
      ? null
      : await readFile(config.config_path, 'utf8'));
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MiMo native config must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if ('mcp' in record || 'mcpServers' in record) {
    throw new Error(
      'MiMo native config must not declare MCP servers; Dreamux mcpServers are authoritative',
    );
  }
  return record;
}

async function waitForServerUrl(
  child: MimoChildProcess,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolveUrl, reject) => {
    let settled = false;
    let output = '';
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (err !== null) reject(err);
      else resolveUrl(url ?? '');
    };
    const timer = globalThis.setTimeout(() => {
      finish(new Error('timed out waiting for MiMo server URL'));
    }, timeoutMs);
    const onExit = (): void => {
      finish(new Error(`MiMo server exited before startup: ${output.trim()}`));
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match !== null) finish(null, match[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

export function mimoStderrLogPath(
  paths: AgentRuntimePathContext,
  runtimeId: string,
): string {
  return join(paths.logsDir(), 'mimo-code', `${runtimeId}.stderr.log`);
}

export function mimoConfigPath(
  paths: AgentRuntimePathContext,
  runtimeId: string,
): string {
  return join(dirname(mimoStderrLogPath(paths, runtimeId)), `${runtimeId}.json`);
}
