
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
import {
  extractAssistantText,
  injectThreadItems,
  type CollectedTurn,
} from './events.js';
import { renderChannelInput } from '@excitedjs/dreamux-utils';
import { createFailFastApprovalHandler } from './approval.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
  DreamuxLogger,
  InboundDeliveryResult,
  InboundDeliveryHooks,
  InboundTurnInput,
  CompletionDeliveryResult,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';
import { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';
import { CODEX_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import {
  buildCodexCompletionItem,
  buildCodexIdentityGuidanceItem,
  CODEX_COMPLETION_TRIGGER_TEXT,
  codexProcessEnv,
} from './runtime-support.js';
import { applyCodexSkillExtraRoots } from './skill-roots.js';

const DEFAULT_RESTART_BACKOFF_BASE_MS = 1000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;

export interface CodexRuntimeDeps {
    cwd: string;
    systemPromptReplace?: string;
    identityGuidance?: string;
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
    onTurnSettled?: (settled: TurnSettledSignal) => void;
    logger?: DreamuxLogger;
}

const COMPLETION_ID_CACHE_LIMIT = 256;

export class CodexRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CODEX_PROVIDER_REF;

  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private turnManager: TurnManager | null = null;
  private threadId: string | null = null;
    private threadResumed = false;
  private status: AgentRuntimeStatus = 'declared';
    private teammateDeliverySeq = 0;
    private readonly inFlightCompletionDeliveries = new Map<
    string,
    Promise<CompletionDeliveryResult>
  >();
    private readonly acceptedCompletionIds = new Set<string>();
  private readonly acceptedCompletionOrder: string[] = [];
    private readonly injectedCompletionIds = new Set<string>();
  private readonly injectedCompletionOrder: string[] = [];
  private readonly log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    err?: unknown,
  ) => void;
  private stopping = false;
  private restarting = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastResult: AgentRuntimeLastResult | null = null;
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
    this.threadId = identity.checkpoint_id ?? null;
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

  getCheckpoint(): { id: string } | null {
    return this.threadId === null ? null : { id: this.threadId };
  }

  wasCheckpointResumed(): boolean {
    return this.threadResumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return this.lastResult;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async resume(): Promise<void> {
    await this.start();
  }

  private async submitRestartNotice(text: string): Promise<AgentRuntimeTurnResult> {
    if (this.turnManager === null) return { status: 'stopped' };
    const result = await this.turnManager.injectNotice(text);
    if (result.status === 'submitted') {
      this.log('info', 'restart notice injected into resumed thread');
    } else if (result.status === 'skipped') {
      this.log('info', 'restart notice skipped; a live inbound already arrived');
    }
    return result;
  }

  private async submitSystemInput(text: string): Promise<InboundDeliveryResult> {
    if (this.turnManager === null) return { status: 'stopped' };
    return this.turnManager.submitSystemInput(text);
  }

    async start(): Promise<void> {
    this.stopping = false;
    this.restarting = false;
    this.clearRestartTimer();
    this.setStatus('starting');
    await this.state.setStatus('starting', {
      last_started_at: Date.now(),
    });

    try {
      await this.startCodexRuntime();
      await this.markReady();

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      this.setStatus('degraded');
      await this.state.setStatus('degraded', {
        last_error: msg,
      });
      await this.cleanupOnFailure();
      throw err;
    }
  }

  private async startCodexRuntime(): Promise<void> {
    const cwd = this.deps.cwd;
    const socketPath = this.deps.allocateSocketPath(this.dispatcherId);
    const extraArgs = this.deps.resolveExtraArgs?.() ?? [];
    if (this.deps.codexHomeDoctor !== undefined) {
      await this.deps.codexHomeDoctor({ runtimeId: this.dispatcherId, cwd });
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

    const clientFactory =
      this.deps.codexClientFactory ?? ((sock) => new CodexWsClient({ socketPath: sock }));
    const client = clientFactory(socketPath);
    this.client = client;
    client.onClose((reason) => {
      if (this.client !== client) return;
      this.handleClientClose(reason);
    });
    await client.ready();

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
    this.log(
      'info',
      `codex initialized: ${initResponse.userAgent} (home=${initResponse.codexHome}, ${initResponse.platformOs})`,
    );
    await this.applySkillExtraRoots();

    await this.resolveThread();
    await this.injectIdentityGuidance();

    this.turnManager = new TurnManager({
      dispatcherId: this.dispatcherId,
      getThreadId: () => this.threadId,
      client: this.client,
      onTurnCompleted: (turn) => this.recordCollectedTurn(turn),
      onTurnSettled: this.deps.onTurnSettled,
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

  private async resolveThread(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    this.threadResumed = false;
    const existing = this.threadId ?? this.identity.checkpoint_id ?? null;
    if (existing === null) {
      const params: ThreadStartParams = {
        baseInstructions: this.deps.systemPromptReplace,
      };
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      );
      this.threadId = res.thread.id;
      await this.state.setCheckpoint({ id: this.threadId });
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }
    try {
      const params: ThreadResumeParams = {
        threadId: existing,
        baseInstructions: this.deps.systemPromptReplace,
      };
      await this.client.request<ThreadResumeResponse>('thread/resume', params);
      this.threadId = existing;
      this.threadResumed = true;
      this.log('info', `resumed thread ${this.threadId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(
        'warn',
        `thread/resume failed for ${existing}: ${msg}; starting fresh thread`,
      );
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        { baseInstructions: this.deps.systemPromptReplace },
      );
      this.threadId = res.thread.id;
      if (this.state.recordLostCheckpoint !== undefined) {
        await this.state.recordLostCheckpoint(
          { id: existing },
          { id: this.threadId },
          `thread/resume failed: ${msg}`,
        );
      } else {
        await this.state.setCheckpoint({ id: this.threadId });
        await this.state.setStatus('degraded', {
          last_error: `thread/resume failed: ${msg}`,
        });
      }
    }
  }

  private async injectIdentityGuidance(): Promise<void> {
    if (this.deps.identityGuidance === undefined) return;
    if (this.client === null) throw new Error('client not initialized');
    if (this.threadId === null) {
      throw new Error('codex identity guidance injection has no thread id');
    }
    try {
      await injectThreadItems(this.client, this.threadId, [
        buildCodexIdentityGuidanceItem(this.deps.identityGuidance),
      ]);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `codex identity guidance thread/inject_items failed (requires codex 0.137+): ${cause}`,
      );
    }
  }

  async channelInput(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<AgentRuntimeTurnResult> {
    if (this.turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    return this.turnManager.enqueue(
      { ...input, text: renderChannelInput(input) },
      hooks,
    );
  }

    async systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    if (notice.reason === 'scheduled') {
      return this.channelInput({ sourceId: '', text: notice.text });
    }
    if (notice.reason === 'restart-notice') {
      return this.submitRestartNotice(notice.text);
    }
    const result = await this.submitSystemInput(notice.text);
    return result.status === 'duplicate'
      ? {
          status: 'failed',
          error: new Error('system input unexpectedly deduplicated'),
        }
      : result;
  }

  waitIdle(): Promise<void> {
    return this.turnManager?.waitIdle() ?? Promise.resolve();
  }

    async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    if (this.acceptedCompletionIds.has(completion.id)) {
      return { status: 'accepted' };
    }
    const inFlight = this.inFlightCompletionDeliveries.get(completion.id);
    if (inFlight !== undefined) return inFlight;

    const delivery = this.deliverCompletionInput(completion);
    this.inFlightCompletionDeliveries.set(completion.id, delivery);
    try {
      const outcome = await delivery;
      if (outcome.status === 'accepted') {
        this.rememberAcceptedCompletion(completion.id);
      }
      return outcome;
    } finally {
      this.inFlightCompletionDeliveries.delete(completion.id);
    }
  }

  private async deliverCompletionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    if (this.client === null || this.turnManager === null || this.stopping) {
      return { status: 'unsupported', reason: 'dispatcher runtime stopped' };
    }
    const threadId = this.threadId;
    if (threadId === null) {
      return {
        status: 'failed',
        error: new Error('teammate completion delivery has no thread id'),
      };
    }
    if (!this.injectedCompletionIds.has(completion.id)) {
      try {
        await injectThreadItems(this.client, threadId, [
          await buildCodexCompletionItem(
            completion,
            this.paths.completionSpillDir(this.dispatcherId),
          ),
        ]);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed',
          error: new Error(
            `teammate completion thread/inject_items failed (requires codex 0.137+): ${cause}`,
          ),
        };
      }
      this.rememberInjectedCompletion(completion.id);
    }
    const deliverySeq = ++this.teammateDeliverySeq;
    const delivery = await this.channelInput({
      sourceId: `teammate:${completion.id}#${deliverySeq}`,
      text: CODEX_COMPLETION_TRIGGER_TEXT,
    });
    switch (delivery.status) {
      case 'submitted':
        return { status: 'accepted' };
      case 'stopped':
        return { status: 'unsupported', reason: 'dispatcher runtime stopped' };
      case 'failed':
        return { status: 'failed', error: delivery.error };
      case 'duplicate':
        return {
          status: 'failed',
          error: new Error('teammate completion trigger unexpectedly deduplicated'),
        };
      case 'skipped':
        return {
          status: 'failed',
          error: new Error('teammate completion trigger unexpectedly skipped'),
        };
    }
  }

    async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.setStatus('stopping');
    await this.state.setStatus('stopping');
    await this.teardownCodexRuntime();
    this.setStatus('stopped');
    await this.state.setStatus('stopped');
  }

  private async cleanupOnFailure(): Promise<void> {
    this.clearRestartTimer();
    const wasStopping = this.stopping;
    this.stopping = true;
    try {
      await this.teardownCodexRuntime();
    } finally {
      this.stopping = wasStopping;
    }
  }

  private async teardownCodexRuntime(): Promise<void> {
    const turnManager = this.turnManager;
    this.turnManager = null;
    if (turnManager !== null) await turnManager.stop();

    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        client.close();
      } catch {
        /* */
      }
    }

    const process = this.process;
    this.process = null;
    if (process !== null) {
      await process.reap();
    }
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
      void this.restartCodexRuntime(reason);
    }, delay);
  }

  private async restartCodexRuntime(reason: string): Promise<void> {
    if (this.stopping) return;
    this.restarting = true;
    let retryReason: string | null = null;
    this.setStatus('starting');
    await this.state.setStatus('starting', {
      last_started_at: Date.now(),
    });
    try {
      await this.teardownCodexRuntime();
      if (this.stopping) return;
      await this.startCodexRuntime();
      if (this.stopping) {
        await this.teardownCodexRuntime();
        return;
      }
      this.restartAttempts = 0;
      await this.markReady();
      this.log('info', `restarted codex app-server after: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `restart failed: ${msg}`, err);
      this.setStatus('degraded');
      await this.state.setStatus('degraded', {
        last_error: msg,
      });
      await this.teardownCodexRuntime();
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

  private async markReady(): Promise<void> {
    this.setStatus('ready');
    await this.state.setStatus('ready', {
      last_ready_at: Date.now(),
      last_error: null,
    });
  }

  private recordCollectedTurn(turn: CollectedTurn): void {
    const resultText = extractAssistantText(turn);
    if (resultText !== null) {
      this.lastResult = { text: resultText };
    }
    this.deps.onTurnSettled?.({
      turnId: turn.turnId,
      status: 'completed',
      result: { text: resultText },
    });
  }

    private rememberInjectedCompletion(id: string): void {
    if (this.injectedCompletionIds.has(id)) return;
    this.injectedCompletionIds.add(id);
    this.injectedCompletionOrder.push(id);
    while (this.injectedCompletionOrder.length > COMPLETION_ID_CACHE_LIMIT) {
      const evicted = this.injectedCompletionOrder.shift();
      if (evicted !== undefined) this.injectedCompletionIds.delete(evicted);
    }
  }

    private rememberAcceptedCompletion(id: string): void {
    if (this.acceptedCompletionIds.has(id)) return;
    this.acceptedCompletionIds.add(id);
    this.acceptedCompletionOrder.push(id);
    while (this.acceptedCompletionOrder.length > COMPLETION_ID_CACHE_LIMIT) {
      const evicted = this.acceptedCompletionOrder.shift();
      if (evicted !== undefined) this.acceptedCompletionIds.delete(evicted);
    }
  }

  private setStatus(s: AgentRuntimeStatus): void {
    this.status = s;
  }
}
