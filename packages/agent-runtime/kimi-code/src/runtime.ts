import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureOwnerOnlyDir, renderChannelInput } from '@excitedjs/dreamux-utils';
import { KIMI_CODE_AGENT_RUNTIME_CAPABILITIES } from './capabilities.js';
import { kimiCodeAcpMcpServers } from './mcp.js';
import type {
  KimiCodeAcpClient,
  KimiCodeAcpClientFactory,
} from './acp-client.js';
import type { DispatcherKimiCodeConfig } from './config.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

export interface KimiCodeRuntimeDeps {
  providerRef: string;
  config: DispatcherKimiCodeConfig;
  cwd: string;
  state: AgentRuntimeStateCallbacks;
  paths: AgentRuntimePathContext;
  mcpServers: Parameters<typeof kimiCodeAcpMcpServers>[0];
  clientFactory: KimiCodeAcpClientFactory;
  injectEnv?: Record<string, string>;
  systemPromptAppend?: readonly string[];
  skillSources?: readonly AgentRuntimeSkillSource[];
  disableFeatures?: readonly string[];
  onTurnSettled?: (settled: TurnSettledSignal) => void;
  logger?: DreamuxLogger;
}

const MANAGED_AGENTS_MD_MARKER = '<!-- dreamux:kimi-code-agent-runtime:AGENTS.md:v1 -->';
const MANAGED_SKILLS_MANIFEST = '.dreamux-skill-links.json';
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

let nextRuntimeInstanceId = 0;

export class KimiCodeRuntime implements AgentRuntime {
  readonly providerRef: string;

  private readonly runtimeId: string;
  private readonly config: DispatcherKimiCodeConfig;
  private readonly cwd: string;
  private readonly logger: DreamuxLogger | undefined;
  private status: AgentRuntimeStatus = 'declared';
  private stopped = false;
  private checkpointId: string | null;
  private resumed = false;
  private client: KimiCodeAcpClient | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly seenChannelIds = new Set<string>();
  private readonly seenTextInputIds = new Set<string>();
  private readonly runtimeInstanceId = ++nextRuntimeInstanceId;
  private turnCounter = 0;
  private queuedTurnCount = 0;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;
  private lastResult: AgentRuntimeLastResult | null = null;

  constructor(
    identity: AgentRuntimeIdentity,
    private readonly deps: KimiCodeRuntimeDeps,
  ) {
    this.providerRef = deps.providerRef;
    this.runtimeId = identity.runtime_id;
    this.config = deps.config;
    this.cwd = deps.cwd;
    this.checkpointId = identity.checkpoint_id ?? null;
    this.logger = deps.logger;
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return KIMI_CODE_AGENT_RUNTIME_CAPABILITIES;
  }

  getCheckpoint(): { id: string } | null {
    return this.checkpointId === null ? null : { id: this.checkpointId };
  }

  wasCheckpointResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return this.lastResult;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async start(): Promise<void> {
    await this.startOrResume(false);
  }

  async resume(): Promise<void> {
    await this.startOrResume(true);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.setStatus('stopping');
    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        await client.stop();
      } catch (err) {
        this.log('warn', 'kimi-code client stop errored', err);
      }
    }
    this.queuedTurnCount = 0;
    this.resolveIdleWaitersIfIdle();
    await this.setStatus('stopped');
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.sourceId;
    if (key !== undefined && key !== '' && this.seenTextInputIds.has(key)) {
      return { status: 'duplicate' };
    }
    if (key !== undefined && key !== '') this.seenTextInputIds.add(key);
    return this.submitQueuedTurn(input.text);
  }

  async channelInput(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.sourceId;
    if (key !== '' && this.seenChannelIds.has(key)) return { status: 'duplicate' };
    if (key !== '') this.seenChannelIds.add(key);
    try {
      await hooks.onAccepted?.(input);
    } catch (err) {
      this.log('warn', 'kimi-code onAccepted hook failed', err);
    }
    return this.submitQueuedTurn(renderChannelInput(input));
  }

  waitIdle(): Promise<void> {
    if (this.queuedTurnCount === 0) return Promise.resolve();
    if (this.idlePromise === null) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolve = resolve;
      });
    }
    return this.idlePromise;
  }

  private async startOrResume(forceResume: boolean): Promise<void> {
    if (this.client !== null && this.client.isAlive()) {
      await this.setStatus('ready');
      return;
    }
    await this.setStatus('starting');
    try {
      const client = this.deps.clientFactory({
        bin: this.config.bin,
        args: ['acp', ...this.config.extra_args],
        cwd: this.cwd,
        env: this.buildProcessEnv(),
        homeDir: this.homeDir(),
        stderrLogPath: this.stderrLogPath(),
        turnTimeoutMs: this.config.turn_timeout_ms,
        log: (level, message, err) => this.log(level, message, err),
      });
      await this.materializeKimiHome();
      await client.start();
      const sessionRequest = {
        cwd: this.cwd,
        mcpServers: kimiCodeAcpMcpServers(this.deps.mcpServers),
      };
      const checkpoint = this.checkpointId;
      if (forceResume || checkpoint !== null) {
        if (checkpoint === null) {
          throw new Error('kimi-code resume requested without a checkpoint id');
        }
        try {
          this.checkpointId = await client.resumeSession(checkpoint, sessionRequest);
          this.resumed = true;
        } catch (err) {
          const message = `kimi-code session resume failed: ${errMessage(err)}`;
          this.log('warn', `${message}; starting fresh session`, err);
          const replacement = await client.createSession(sessionRequest);
          this.checkpointId = replacement;
          this.resumed = false;
          if (this.deps.state.recordLostCheckpoint !== undefined) {
            await this.deps.state.recordLostCheckpoint(
              { id: checkpoint },
              { id: replacement },
              message,
            );
          } else {
            await this.deps.state.setCheckpoint({ id: replacement });
            await this.deps.state.setStatus('degraded', { last_error: message });
          }
        }
      } else {
        this.checkpointId = await client.createSession(sessionRequest);
        this.resumed = false;
      }
      await this.deps.state.setCheckpoint({ id: this.checkpointId });
      this.client = client;
    } catch (err) {
      await this.setStatus('degraded', err);
      throw err;
    }
    await this.setStatus('ready');
  }

  private submitQueuedTurn(text: string): AgentRuntimeTurnResult {
    const turnId = this.nextTurnId();
    this.recordQueuedTurnStart();
    void this.runTurnOnQueue(text, turnId).then(
      (resultText) => this.markTurnSucceeded(turnId, resultText),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  private runTurnOnQueue(text: string, turnId: string): Promise<string | null> {
    const run = this.queue.then(() => this.runTurn(text, turnId));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTurn(text: string, _turnId: string): Promise<string | null> {
    const client = await this.ensureClient();
    const checkpointId = this.checkpointId;
    if (checkpointId === null) {
      throw new Error('kimi-code session is missing a checkpoint id');
    }
    const result = await client.prompt(checkpointId, text);
    if (result.stopReason === 'cancelled') {
      throw new KimiCodeTurnStoppedError('kimi-code prompt was cancelled');
    }
    this.lastResult = { text: result.text };
    return result.text;
  }

  private async ensureClient(): Promise<KimiCodeAcpClient> {
    if (this.client !== null && this.client.isAlive()) return this.client;
    await this.startOrResume(this.checkpointId !== null);
    if (this.client === null) {
      throw new Error('kimi-code client failed to start');
    }
    return this.client;
  }

  private async markTurnSucceeded(
    turnId: string,
    resultText: string | null,
  ): Promise<void> {
    this.recordQueuedTurnEnd();
    this.deps.onTurnSettled?.({
      turnId,
      status: 'completed',
      result: { text: resultText },
    });
    if (this.stopped) return;
    if (this.status !== 'ready') await this.setStatus('ready');
  }

  private async markTurnFailed(turnId: string, err: unknown): Promise<void> {
    this.recordQueuedTurnEnd();
    const stopped = this.stopped || err instanceof KimiCodeTurnStoppedError;
    this.deps.onTurnSettled?.({
      turnId,
      status: stopped ? 'stopped' : 'failed',
      result: { text: null },
      error: err instanceof Error ? err : new Error(String(err)),
    });
    if (this.stopped) return;
    if (stopped) {
      await this.setStatus('ready');
      return;
    }
    this.log('error', `kimi-code turn ${turnId} failed`, err);
    await this.setStatus('degraded', err);
  }

  private nextTurnId(): string {
    this.turnCounter += 1;
    return `${this.runtimeId}-kimi-${this.runtimeInstanceId}-${this.turnCounter}`;
  }

  private recordQueuedTurnStart(): void {
    this.queuedTurnCount += 1;
  }

  private recordQueuedTurnEnd(): void {
    this.queuedTurnCount = Math.max(0, this.queuedTurnCount - 1);
    this.resolveIdleWaitersIfIdle();
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.queuedTurnCount !== 0) return;
    const resolve = this.idleResolve;
    this.idlePromise = null;
    this.idleResolve = null;
    resolve?.();
  }

  private homeDir(): string {
    return (
      this.config.home_dir ??
      join(this.deps.paths.dispatcherDir(this.runtimeId), 'kimi-code-home')
    );
  }

  private async materializeKimiHome(): Promise<void> {
    const homeDir = this.homeDir();
    await ensureOwnerOnlyDir(homeDir);
    await Promise.all([
      this.materializeSystemPromptAppend(homeDir),
      this.materializeSkillSources(homeDir),
    ]);
  }

  private async materializeSystemPromptAppend(homeDir: string): Promise<void> {
    const append = (this.deps.systemPromptAppend ?? []).filter((entry) => entry !== '');
    if (append.length === 0) return;
    const path = join(homeDir, 'AGENTS.md');
    const existing = await readTextIfExists(path);
    if (existing !== null && !existing.startsWith(MANAGED_AGENTS_MD_MARKER)) {
      throw new Error(
        `refusing to overwrite existing Kimi AGENTS.md at ${path}; use a dedicated kimi-code home_dir for Dreamux`,
      );
    }
    const content = [
      MANAGED_AGENTS_MD_MARKER,
      '',
      '# Dreamux Runtime Instructions',
      '',
      ...append,
      '',
    ].join('\n');
    await writeFile(path, content, { mode: 0o600 });
  }

  private async materializeSkillSources(homeDir: string): Promise<void> {
    const skillsRoot = join(homeDir, 'skills');
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    const sources = this.deps.skillSources ?? [];
    const currentNames = new Set(sources.map((source) => source.name));
    const previousNames = await this.readManagedSkillNames(homeDir);
    await Promise.all(
      previousNames
        .filter((name) => !currentNames.has(name))
        .map((name) => this.removeManagedSkillLink(skillsRoot, name)),
    );
    for (const source of sources) {
      if (!SAFE_SKILL_NAME.test(source.name)) {
        throw new Error(
          `kimi-code skill source name ${JSON.stringify(source.name)} is not a safe path segment`,
        );
      }
      const linkPath = join(skillsRoot, source.name);
      await this.replaceManagedSkillLink(linkPath, source.path);
    }
    await writeFile(
      join(homeDir, MANAGED_SKILLS_MANIFEST),
      `${JSON.stringify({ version: 1, names: [...currentNames].sort() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async readManagedSkillNames(homeDir: string): Promise<string[]> {
    const text = await readTextIfExists(join(homeDir, MANAGED_SKILLS_MANIFEST));
    if (text === null) return [];
    try {
      const parsed = JSON.parse(text) as { names?: unknown };
      if (!Array.isArray(parsed.names)) return [];
      return parsed.names.filter((name): name is string => typeof name === 'string');
    } catch {
      return [];
    }
  }

  private async removeManagedSkillLink(
    skillsRoot: string,
    name: string,
  ): Promise<void> {
    if (!SAFE_SKILL_NAME.test(name)) return;
    const linkPath = join(skillsRoot, name);
    const info = await lstatIfExists(linkPath);
    if (info === null) return;
    if (!info.isSymbolicLink()) {
      throw new Error(
        `refusing to remove non-symlink Kimi skill path ${linkPath}`,
      );
    }
    await rm(linkPath, { force: true });
  }

  private async replaceManagedSkillLink(
    linkPath: string,
    targetPath: string,
  ): Promise<void> {
    const info = await lstatIfExists(linkPath);
    if (info !== null) {
      if (!info.isSymbolicLink()) {
        throw new Error(
          `refusing to overwrite existing non-symlink Kimi skill path ${linkPath}`,
        );
      }
      const currentTarget = await readlink(linkPath);
      if (currentTarget !== targetPath) await rm(linkPath, { force: true });
      else return;
    }
    await symlink(targetPath, linkPath, 'dir');
  }

  private stderrLogPath(): string {
    return join(this.deps.paths.logsDir(), 'kimi-code', `${this.runtimeId}.stderr.log`);
  }

  private buildProcessEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      ...this.deps.injectEnv,
      KIMI_CODE_HOME: this.homeDir(),
      ...this.config.extra_env,
    };
  }

  private async setStatus(
    status: AgentRuntimeStatus,
    err?: unknown,
  ): Promise<void> {
    this.status = status;
    await this.deps.state.setStatus(status, {
      ...(err !== undefined ? { last_error: errMessage(err) } : {}),
      ...(status === 'starting' ? { last_started_at: Date.now() } : {}),
      ...(status === 'ready' ? { last_ready_at: Date.now(), last_error: null } : {}),
    });
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    err?: unknown,
  ): void {
    this.logger?.[level]?.(
      { runtime_id: this.runtimeId, error: errMessage(err) },
      message,
    );
    if (this.logger === undefined && level !== 'info') {
      console.error(`[kimi-code] ${message}: ${errMessage(err)}`);
    }
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw err;
  }
}

class KimiCodeTurnStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KimiCodeTurnStoppedError';
  }
}
