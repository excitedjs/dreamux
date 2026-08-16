
import { join } from 'node:path';

import {
  CodexProcess,
  type CodexProcessExit,
  type CodexProcessOptions,
} from './supervisor.js';
import { CodexWsClient } from './rpc.js';
import { performInitializeHandshake } from './handshake.js';
import type {
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
} from './types.js';
import {
  TurnManager,
} from './turn-manager.js';
import { renderChannelInput } from '@excitedjs/dreamux-utils';
import { createFailFastApprovalHandler } from './approval.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  DreamuxLogger,
  InboundTurnInput,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';
import { CODEX_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import {
  codexProcessEnv,
  renderCodexSystemPromptAppend,
} from './runtime-support.js';
import { applyCodexSkillExtraRoots } from './skill-roots.js';
import {
  resolveCodexTranscriptRoots,
  validateCodexThreadPath,
} from './transcript/path.js';

const DEFAULT_RESTART_BACKOFF_BASE_MS = 1000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;

export interface CodexRuntimeDeps {
  cwd: string;
  systemPromptReplace?: string;
  systemPromptAppend?: readonly string[];
  state: AgentRuntimeStateCallbacks;
  paths: AgentRuntimePathContext;
  allocateSocketPath: (id: string) => string;
  skillSources?: readonly AgentRuntimeSkillSource[];
  injectEnv?: Record<string, string>;
  codexBinPath?: string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  codexHomeDoctor?: (info: {
    runtimeId: string;
    cwd: string;
  }) => void | Promise<void>;
  resolveExtraArgs?: () => string[];
  handshakeTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  validateTranscriptPath?: (
    path: string,
    threadId: string,
  ) => Promise<string>;
  logger?: DreamuxLogger;
}

export class CodexRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CODEX_PROVIDER_REF;

  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private turnManager: TurnManager | null = null;
  private threadId: string | null = null;
  private transcriptLocator: string | null = null;
  private threadResumed = false;
  private status: AgentRuntimeStatus = 'declared';
  private readonly log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ) => void;
  private stopping = false;
  private restarting = false;
  private generation = 0;
  private startupTask: Promise<void> | null = null;
  private restartTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly state: AgentRuntimeStateCallbacks;
  private readonly paths: AgentRuntimePathContext;

  constructor(
    public readonly identity: AgentRuntimeIdentity,
    private readonly deps: CodexRuntimeDeps,
  ) {
    const logger = deps.logger;
    this.log =
      logger !== undefined
        ? (lvl, msg, err) =>
            logger[lvl](err !== undefined ? { err } : {}, msg)
        : (lvl, msg, err) => {
            const prefix = `[dispatcher ${identity.runtime_id}] ${lvl}`;
            if (err !== undefined) console.error(prefix, msg, err);
            else console.error(prefix, msg);
          };
    this.threadId = identity.checkpoint?.id ?? null;
    this.transcriptLocator =
      identity.checkpoint?.transcript_locator ?? null;
    this.state = deps.state;
    this.paths = deps.paths;
  }

  get dispatcherId(): string {
    return this.identity.runtime_id;
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CODEX_AGENT_RUNTIME_CAPABILITIES;
  }

  getCheckpoint(): { id: string; transcript_locator?: string | null } | null {
    if (this.threadId === null) return null;
    return {
      id: this.threadId,
      transcript_locator: this.transcriptLocator,
    };
  }

  wasCheckpointResumed(): boolean {
    return this.threadResumed;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async resume(): Promise<void> {
    await this.start();
  }

  start(): Promise<void> {
    if (this.startupTask !== null) return this.startupTask;
    if (this.stopping || this.stopTask !== null || this.status === 'stopped') {
      return Promise.reject(new Error('codex runtime is stopped'));
    }
    if (this.status === 'ready') return Promise.resolve();
    this.restarting = false;
    this.generation += 1;
    this.clearRestartTimer();
    const generation = this.generation;
    const task = this.startRuntime(generation);
    this.startupTask = task;
    void task.finally(() => {
      if (this.startupTask === task) this.startupTask = null;
    }).catch(() => undefined);
    return task;
  }

  private async startRuntime(generation: number): Promise<void> {
    this.setStatus('starting');
    await this.state.setStatus('starting', {
      last_started_at: Date.now(),
    });

    try {
      await this.startCodexRuntime(generation);
      this.assertGeneration(generation);
      await this.markReady(generation);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      const failures: unknown[] = [err];
      if (!this.stopping && generation === this.generation) {
        this.setStatus('degraded');
        try {
          await this.state.setStatus('degraded', {
            last_error: msg,
          });
        } catch (stateError) {
          failures.push(stateError);
        }
      }
      try {
        await this.cleanupOnFailure();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        const failureDetails = failures.slice(1).map((failure) =>
          failure instanceof Error ? failure.message : String(failure)
        ).join('; ');
        throw new AggregateError(
          failures,
          `codex runtime start failed and cleanup did not fully converge: ${failureDetails}`,
        );
      }
      throw err;
    }
  }

  private async startCodexRuntime(generation: number): Promise<void> {
    this.assertGeneration(generation);
    if (this.process !== null) {
      throw new Error(
        'codex runtime retains an unterminated process from a prior attempt',
      );
    }
    const cwd = this.deps.cwd;
    const socketPath = this.deps.allocateSocketPath(this.dispatcherId);
    const extraArgs = this.deps.resolveExtraArgs?.() ?? [];
    if (this.deps.codexHomeDoctor !== undefined) {
      await this.deps.codexHomeDoctor({ runtimeId: this.dispatcherId, cwd });
      this.assertGeneration(generation);
    }
    const codexLogDir = join(this.paths.logsDir(), 'codex-app-server');
    const factory = this.deps.codexProcessFactory ?? ((o) => new CodexProcess(o));
    const process = factory({
      socketPath,
      cwd,
      stdoutLogPath: join(codexLogDir, `${this.dispatcherId}.log`),
      stderrLogPath: join(codexLogDir, `${this.dispatcherId}.stderr.log`),
      binPath: this.deps.codexBinPath,
      extraArgs,
      env: codexProcessEnv(this.deps.injectEnv, this.deps.extraEnv),
    });
    this.process = process;
    process.onExit((exit) => {
      if (this.process !== process) return;
      this.handleChildExit(exit);
    });
    await process.start();
    this.assertGeneration(generation);

    const clientFactory =
      this.deps.codexClientFactory ?? ((sock) => new CodexWsClient({ socketPath: sock }));
    const client = clientFactory(socketPath);
    this.client = client;
    client.onClose((reason) => {
      if (this.client !== client) return;
      this.handleClientClose(reason);
    });
    await client.ready();
    this.assertGeneration(generation);

    const approvalHandler = createFailFastApprovalHandler({
      onReject: async (req) => {
        this.log(
          'warn',
          `rejected Codex approval request '${req.method}'; Feishu outbound is MCP reply-only`,
        );
      },
    });
    this.client.setServerRequestHandler(approvalHandler);
    const initResponse = await performInitializeHandshake(this.client, {
      ...(this.deps.handshakeTimeoutMs !== undefined
        ? { timeoutMs: this.deps.handshakeTimeoutMs }
        : {}),
    });
    this.assertGeneration(generation);
    this.log(
      'info',
      `codex initialized: ${initResponse.userAgent} (home=${initResponse.codexHome}, ${initResponse.platformOs})`,
    );
    await this.applySkillExtraRoots();
    this.assertGeneration(generation);

    await this.resolveThread(generation);
    this.assertGeneration(generation);

    this.turnManager = new TurnManager({
      dispatcherId: this.dispatcherId,
      getThreadId: () => this.threadId,
      client: this.client,
      log: this.log,
    });
  }

  private async applySkillExtraRoots(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    await applyCodexSkillExtraRoots({
      client: this.client,
      sources: this.deps.skillSources ?? [],
      log: this.log,
    });
  }

  private async resolveThread(generation: number): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    this.threadResumed = false;
    const threadInstructions = this.threadInstructionParams();
    const existing = this.threadId ?? this.identity.checkpoint?.id ?? null;
    if (existing === null) {
      const params: ThreadStartParams = {
        ...threadInstructions,
      };
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      );
      this.assertGeneration(generation);
      const candidateThreadId = res.thread.id;
      const transcript = await this.validateThreadPath(
        res.thread.path,
        candidateThreadId,
      );
      await this.state.setCheckpoint({
        id: candidateThreadId,
        transcript_locator: transcript.path,
      });
      this.assertGeneration(generation);
      this.threadId = candidateThreadId;
      this.transcriptLocator = transcript.path;
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }
    let resumed: ThreadResumeResponse;
    try {
      const params: ThreadResumeParams = {
        threadId: existing,
        ...threadInstructions,
      };
      resumed = await this.client.request<ThreadResumeResponse>(
        'thread/resume',
        params,
      );
    } catch (err) {
      this.assertGeneration(generation);
      const msg = err instanceof Error ? err.message : String(err);
      this.log(
        'warn',
        `thread/resume failed for ${existing}: ${msg}; starting fresh thread`,
      );
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        { ...threadInstructions },
      );
      this.assertGeneration(generation);
      const replacementThreadId = res.thread.id;
      const transcript = await this.validateThreadPath(
        res.thread.path,
        replacementThreadId,
      );
      const replacement = {
        id: replacementThreadId,
        transcript_locator: transcript.path,
      };
      if (this.state.recordLostCheckpoint !== undefined) {
        await this.state.recordLostCheckpoint(
          {
            id: existing,
            transcript_locator: this.transcriptLocator,
          },
          replacement,
          `thread/resume failed: ${msg}`,
        );
      } else {
        await this.state.setCheckpoint(replacement);
        await this.state.setStatus('degraded', {
          last_error: `thread/resume failed: ${msg}`,
        });
      }
      this.assertGeneration(generation);
      this.threadId = replacementThreadId;
      this.transcriptLocator = transcript.path;
      return;
    }
    this.assertGeneration(generation);
    const resumedThreadId = resumed.thread.id;
    const transcript = await this.validateThreadPath(
      resumed.thread.path,
      resumedThreadId,
    );
    await this.state.setCheckpoint({
      id: resumedThreadId,
      transcript_locator: transcript.path,
    });
    this.assertGeneration(generation);
    this.threadId = resumedThreadId;
    this.transcriptLocator = transcript.path;
    this.threadResumed = true;
    this.log('info', `resumed thread ${this.threadId}`);
  }

  private validateThreadPath(
    path: string | null | undefined,
    threadId: string,
  ) {
    if (path === null || path === undefined) {
      throw new Error('Codex thread response omitted the native transcript path');
    }
    if (this.deps.validateTranscriptPath !== undefined) {
      return this.deps.validateTranscriptPath(path, threadId).then(
        (validatedPath) => ({ path: validatedPath }),
      );
    }
    return resolveCodexTranscriptRoots(
      codexProcessEnv(this.deps.injectEnv, this.deps.extraEnv),
    ).then((roots) => validateCodexThreadPath(
      path,
      threadId,
      roots,
    ));
  }

  private threadInstructionParams(): Pick<
    ThreadStartParams,
    'baseInstructions' | 'developerInstructions'
  > {
    const params: Pick<
      ThreadStartParams,
      'baseInstructions' | 'developerInstructions'
    > = {};
    if (this.deps.systemPromptReplace !== undefined) {
      params.baseInstructions = this.deps.systemPromptReplace;
      return params;
    }
    if (this.deps.systemPromptAppend !== undefined) {
      const rendered = renderCodexSystemPromptAppend(this.deps.systemPromptAppend);
      if (rendered !== '') params.developerInstructions = rendered;
    }
    return params;
  }

  async channelInput(input: InboundTurnInput): Promise<RuntimeAdmission> {
    if (this.stopping || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    if (this.turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    return this.turnManager.enqueue({ ...input, text: renderChannelInput(input) });
  }

  waitIdle(): Promise<void> {
    return this.turnManager?.waitIdle() ?? Promise.resolve();
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    if (this.stopping || this.status === 'stopped') {
      return { status: 'stopped' };
    }
    if (this.turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    return this.turnManager.submitTextInput(input);
  }

  stop(): Promise<void> {
    if (this.status === 'stopped') return Promise.resolve();
    if (this.stopTask !== null) return this.stopTask;
    if (!this.stopping) {
      this.stopping = true;
      this.generation += 1;
    }
    this.clearRestartTimer();
    const task = this.stopRuntime();
    this.stopTask = task;
    void task.catch(() => {
      if (this.stopTask === task) this.stopTask = null;
    });
    return task;
  }

  private async stopRuntime(): Promise<void> {
    this.setStatus('stopping');
    // Teardown must be initiated before any status/start/restart join. Closing
    // the client is what rejects stuck ready/RPC admissions; the generation
    // fence prevents pre-authority startup work from publishing later.
    const teardown = this.teardownCodexRuntime();
    void teardown.catch(() => undefined);
    const stoppingState = Promise.resolve().then(() =>
      this.state.setStatus('stopping'));
    const [stateResult, teardownResult] = await Promise.allSettled([
      stoppingState,
      teardown,
    ]);
    throwSettledFailures(
      [stateResult, teardownResult],
      'codex runtime stop did not converge',
    );
    await this.state.setStatus('stopped');
    this.setStatus('stopped');
  }

  private async cleanupOnFailure(): Promise<void> {
    this.clearRestartTimer();
    const wasStopping = this.stopping;
    this.stopping = true;
    try {
      await this.teardownCodexRuntime();
      this.stopping = wasStopping;
    } catch (error) {
      // Retain the stop fence together with the process authority. Only a
      // successful stop retry may permit any later lifecycle transition.
      this.stopping = true;
      throw error;
    }
  }

  private async teardownCodexRuntime(): Promise<void> {
    const turnManager = this.turnManager;
    const managerStop = turnManager?.stop() ?? Promise.resolve();
    void managerStop.catch(() => undefined);

    const client = this.client;
    let clientClose: Promise<void> = Promise.resolve();
    if (client !== null) {
      try {
        client.close();
      } catch (error) {
        clientClose = Promise.reject(error);
        void clientClose.catch(() => undefined);
      }
    }

    const process = this.process;
    const processReap = process?.reap() ?? Promise.resolve();
    void processReap.catch(() => undefined);
    const results = await Promise.allSettled([
      managerStop,
      clientClose,
      processReap,
    ]);
    if (results[0]?.status === 'fulfilled' && this.turnManager === turnManager) {
      this.turnManager = null;
    }
    if (results[1]?.status === 'fulfilled' && this.client === client) {
      this.client = null;
    }
    if (results[2]?.status === 'fulfilled' && this.process === process) {
      this.process = null;
    }
    throwSettledFailures(results, 'codex runtime teardown did not converge');
  }

  private handleChildExit(exit: CodexProcessExit): void {
    const details =
      exit.signal !== null ? `signal=${exit.signal}` : `code=${exit.code ?? 'null'}`;
    this.scheduleRestart(`codex app-server child exited (${details})`);
  }

  private handleClientClose(reason: Error): void {
    this.scheduleRestart(`codex app-server websocket closed: ${reason.message}`);
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping || this.restartTimer !== null || this.restarting) return;
    const attempt = this.restartAttempts + 1;
    this.restartAttempts = attempt;
    const delay = this.restartDelayMs(attempt);
    this.log('warn', `${reason}; restarting in ${delay}ms`);
    this.setStatus('degraded');
    void this.state
      .setStatus('degraded', { last_error: reason })
      .catch((err) =>
        this.log('warn', 'failed to persist degraded status', err),
      );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const task = this.restartCodexRuntime(reason, this.generation);
      this.restartTask = task;
      void task.finally(() => {
        if (this.restartTask === task) this.restartTask = null;
      }).catch(() => undefined);
    }, delay);
  }

  private async restartCodexRuntime(
    reason: string,
    generation: number,
  ): Promise<void> {
    if (this.stopping || generation !== this.generation) return;
    this.restarting = true;
    let retryReason: string | null = null;
    try {
      this.setStatus('starting');
      await this.state.setStatus('starting', {
        last_started_at: Date.now(),
      });
      await this.teardownCodexRuntime();
      this.assertGeneration(generation);
      await this.startCodexRuntime(generation);
      this.assertGeneration(generation);
      this.restartAttempts = 0;
      await this.markReady(generation);
      this.log('info', `restarted codex app-server after: ${reason}`);
    } catch (err) {
      const failures: unknown[] = [err];
      try {
        await this.teardownCodexRuntime();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (this.stopping || generation !== this.generation) return;
      const msg = failures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure)
      ).join('; ');
      this.log('error', `restart failed: ${msg}`, err);
      this.setStatus('degraded');
      try {
        await this.state.setStatus('degraded', {
          last_error: msg,
        });
      } catch (stateError) {
        this.log('warn', 'failed to persist restart failure', stateError);
      }
      retryReason = `codex app-server restart failed: ${msg}`;
    } finally {
      this.restarting = false;
    }
    if (retryReason !== null) this.scheduleRestart(retryReason);
  }

  private restartDelayMs(attempt: number): number {
    const base = Math.max(
      0,
      this.deps.restartBackoffBaseMs ?? DEFAULT_RESTART_BACKOFF_BASE_MS,
    );
    const max = Math.max(
      base,
      this.deps.restartBackoffMaxMs ?? DEFAULT_RESTART_BACKOFF_MAX_MS,
    );
    return Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === null) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async markReady(generation: number): Promise<void> {
    this.assertGeneration(generation);
    this.setStatus('ready');
    await this.state.setStatus('ready', {
      last_ready_at: Date.now(),
      last_error: null,
    });
    this.assertGeneration(generation);
  }

  private setStatus(s: AgentRuntimeStatus): void {
    this.status = s;
  }

  private assertGeneration(generation: number): void {
    if (this.stopping || generation !== this.generation) {
      throw new Error('codex runtime is stopping');
    }
  }
}

function throwSettledFailures(
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void {
  const failures = results
    .filter((result): result is PromiseRejectedResult =>
      result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}
