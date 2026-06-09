/**
 * CodexRuntime — one running Codex-backed AgentRuntime instance.
 *
 * Owns:
 *   - CodexProcess (child app-server)
 *   - CodexWsClient (WS connection)
 *   - thread_id (lazily created via thread/start or resumed)
 *   - TurnManager (FIFO worker for this dispatcher)
 *
 * Lifecycle: declared → starting → ready → (degraded) → stopping → stopped.
 *
 * Current MVP:
 *   - accepted inbound work is process-local and is dropped on restart;
 *   - thread/resume failure does not degrade the whole dispatcher; we
 *     start a fresh thread, record the lost one in last_lost_thread_id,
 *     and post a visible warning to the next source chat.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../../../state/dispatcher-store.js';
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
import { injectThreadItems, type CollectedTurn } from './events.js';
import { renderChannelInput } from '../../turn.js';
import type {
  InboundDeliveryHooks,
  InboundTurnInput,
  TurnSettledSignal,
} from '../../turn.js';
import { createFailFastApprovalHandler } from './approval.js';
import {
  dispatcherCodexHomeDoctorContext,
  type DispatcherCodexHomeDoctor,
} from './codex-home.js';
import { codexSocketPathIn } from './paths.js';
import { installBundledWorkspaceSkills } from '../../../onboard/bundled-skills.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeLastResult,
  AgentRuntimePathContext,
  AgentRuntimeResumeInput,
  AgentRuntimeStateStore,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
} from '../../types.js';
import { BUILTIN_CODEX_PROVIDER_REF } from '../../../registry/index.js';
import { CODEX_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import {
  buildCodexCompletionItem,
  CODEX_COMPLETION_TRIGGER_TEXT,
  codexProcessEnv,
  codexRowStateStore,
  defaultCodexRuntimePaths,
} from './runtime-support.js';

const DEFAULT_RESTART_BACKOFF_BASE_MS = 1000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;

export interface CodexRuntimeDeps {
  dispatchers: DispatcherStore;
  /** Working directory the codex app-server runs in (required launch param). */
  cwd: string;
  /**
   * Launcher-supplied system-prompt content used as codex `baseInstructions`
   * (codex applies it as a REPLACE per its `systemPrompt` capability). Omitted
   * for launches that supply none (e.g. teammates).
   */
  systemPromptContent?: string;
  state?: AgentRuntimeStateStore;
  paths?: AgentRuntimePathContext;
  /** Optional bin path override for tests. */
  codexBinPath?: string;
  /** Override process construction for tests. */
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  /** Override WS client factory for tests. */
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  /** Optional Codex home validator for tests and explicit diagnostics. */
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  /** Codex extraArgs (parsed from dispatcher.codex_args_json). */
  resolveExtraArgs?: (row: DispatcherRow) => string[];
  /**
   * Codex initialize handshake timeout (ms). From this dispatcher's
   * `dispatchers[].runtime.config.initialize_timeout_ms` (default 10000).
   */
  handshakeTimeoutMs?: number;
  /** Per-dispatcher environment overrides from config. */
  extraEnv?: Record<string, string>;
  /** Codex child/WS restart backoff base (tests may override). */
  restartBackoffBaseMs?: number;
  /** Codex child/WS restart backoff cap (tests may override). */
  restartBackoffMaxMs?: number;
  /**
   * Fired each time a delivered turn reaches a terminal state. Supplied by the
   * launcher (teammate service) and omitted for dispatcher launches.
   */
  onTurnSettled?: (settled: TurnSettledSignal) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

const COMPLETION_ID_CACHE_LIMIT = 256;

export class CodexRuntime implements AgentRuntime {
  readonly providerRef = BUILTIN_CODEX_PROVIDER_REF;

  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private turnManager: TurnManager | null = null;
  private threadId: string | null = null;
  /**
   * Whether the most recent thread resolution resumed an existing Codex thread
   * (true) rather than starting a fresh one or recovering from a failed resume.
   * Consulted by the server right after the slot is ready to decide whether a
   * `daemon restart` notice should be injected (issue #78).
   */
  private threadResumed = false;
  private status: DispatcherStatus = 'declared';
  /** Monotonic per-attempt suffix for TeamMate delivery turn dedup ids (#110 PR8). */
  private teammateDeliverySeq = 0;
  /**
   * Completion deliveries currently being processed. Duplicate settled events can
   * race into `completionInput`; coalescing by completion id keeps one logical
   * completion from injecting or triggering more than once concurrently.
   */
  private readonly inFlightCompletionDeliveries = new Map<
    string,
    Promise<TeamMateCompletionDeliveryResult>
  >();
  /**
   * Completion ids whose trigger turn has already been accepted. A later replay
   * of the same settled teammate turn is an idempotent success, not a new wake-up.
   */
  private readonly acceptedCompletionIds = new Set<string>();
  private readonly acceptedCompletionOrder: string[] = [];
  /**
   * Completion ids whose item has already been injected into the thread. The
   * Dispatcher Service retries `completionInput` on `failed`; if the inject
   * succeeded but the trigger turn failed, the retry must NOT re-inject the same
   * item (that would persist a duplicate completion to the rollout). Bounded so
   * a long-lived dispatcher does not grow this set without limit.
   */
  private readonly injectedCompletionIds = new Set<string>();
  private readonly injectedCompletionOrder: string[] = [];
  private readonly log: NonNullable<CodexRuntimeDeps['log']>;
  private stopping = false;
  private restarting = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastResult: AgentRuntimeLastResult | null = null;
  private readonly state: AgentRuntimeStateStore;
  private readonly paths: AgentRuntimePathContext;

  constructor(
    public readonly row: DispatcherRow,
    private readonly deps: CodexRuntimeDeps,
  ) {
    this.log = deps.log ?? ((lvl, msg, err) => {
      const prefix = `[dispatcher ${row.dispatcher_id}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.threadId = row.thread_id;
    this.state = deps.state ?? codexRowStateStore(deps.dispatchers);
    this.paths = deps.paths ?? defaultCodexRuntimePaths;
  }

  get dispatcherId(): string {
    return this.row.dispatcher_id;
  }

  getStatus(): DispatcherStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CODEX_AGENT_RUNTIME_CAPABILITIES;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  /** True when the live thread was resumed (not freshly started/recovered). */
  wasThreadResumed(): boolean {
    return this.threadResumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return this.lastResult;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    if (input.checkpoint !== undefined && input.checkpoint !== null) {
      if (input.checkpoint.kind !== 'codexThread') {
        throw new Error(
          `unsupported resume checkpoint for Codex runtime: ${input.checkpoint.kind}`,
        );
      }
      this.threadId = input.checkpoint.id;
    }
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

  /**
   * Bring the dispatcher up. Order:
   *  1. spawn codex app-server child
   *  2. open WS client
   *  3. install fail-fast approval handler
   *  4. thread/start (new) or thread/resume (existing)
   *  5. install turn manager
   *  6. status = ready
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.restarting = false;
    this.clearRestartTimer();
    this.setStatus('starting');
    await this.state.setStatus(this.dispatcherId, 'starting', {
      last_started_at: Date.now(),
    });

    try {
      await this.startCodexRuntime();
      await this.markReady();

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      this.setStatus('degraded');
      await this.state.setStatus(this.dispatcherId, 'degraded', {
        last_error: msg,
      });
      await this.cleanupOnFailure();
      throw err;
    }
  }

  private async startCodexRuntime(): Promise<void> {
    const cwd = this.deps.cwd;
    const socketPath = codexSocketPathIn(
      this.paths.dispatcherDir(this.dispatcherId),
      this.dispatcherId,
    );
    const extraArgs = this.deps.resolveExtraArgs?.(this.row) ?? [];
    const skillInstallResults = await installBundledWorkspaceSkills({
      dispatcherCwd: cwd,
    });
    for (const result of skillInstallResults) {
      if (result.status === 'skipped') {
        this.log(
          'warn',
          `bundled skill '${result.skillName}' not installed at ${result.targetPath}: ${result.reason}`,
        );
      } else if (result.status === 'linked' || result.status === 'replaced') {
        this.log(
          'info',
          `bundled skill '${result.skillName}' ${result.status} at ${result.targetPath}`,
        );
      }
    }
    if (this.deps.codexHomeDoctor !== undefined) {
      await this.deps.codexHomeDoctor(
        dispatcherCodexHomeDoctorContext(this.dispatcherId, {
          codexCliArgs: extraArgs,
          dispatcherCwd: cwd,
        }),
      );
    }

    const factory = this.deps.codexProcessFactory ?? ((o) => new CodexProcess(o));
    const process = factory({
      socketPath,
      cwd,
      stdoutLogPath: this.paths.stdoutLogPath(this.dispatcherId),
      stderrLogPath: this.paths.stderrLogPath(this.dispatcherId),
      binPath: this.deps.codexBinPath,
      extraArgs,
      env: codexProcessEnv(this.deps.extraEnv ?? {}),
    });
    this.process = process;
    process.onExit((exit) => {
      if (this.process !== process) return;
      this.handleChildExit(exit);
    });
    await mkdir(dirname(socketPath), { recursive: true });
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

    // codex 0.134+ LSP-style handshake — must precede thread/start or
    // any other RPC, otherwise codex answers everything with
    // `Not initialized` (see src/codex/handshake.ts).
    const initResponse = await performInitializeHandshake(this.client, {
      ...(this.deps.handshakeTimeoutMs !== undefined
        ? { timeoutMs: this.deps.handshakeTimeoutMs }
        : {}),
    });
    this.log(
      'info',
      `codex initialized: ${initResponse.userAgent} (home=${initResponse.codexHome}, ${initResponse.platformOs})`,
    );

    await this.resolveThread();

    this.turnManager = new TurnManager({
      dispatcherId: this.dispatcherId,
      getThreadId: () => this.threadId,
      client: this.client,
      onTurnCompleted: (turn) => this.recordCollectedTurn(turn),
      onTurnSettled: this.deps.onTurnSettled,
      log: this.log,
    });
  }

  private async resolveThread(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    // Each resolution recomputes whether we resumed; a fresh start or a
    // resume-failure recovery must not look like a resume to the notice gate.
    this.threadResumed = false;
    const existing = this.threadId ?? this.row.thread_id;
    if (existing === null) {
      // Fresh thread.
      const params: ThreadStartParams = {
        baseInstructions: this.deps.systemPromptContent,
      };
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        params,
      );
      this.threadId = res.thread.id;
      await this.state.setThreadId(this.dispatcherId, this.threadId);
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }
    try {
      const params: ThreadResumeParams = {
        threadId: existing,
        baseInstructions: this.deps.systemPromptContent,
      };
      await this.client.request<ThreadResumeResponse>('thread/resume', params);
      this.threadId = existing;
      this.threadResumed = true;
      this.log('info', `resumed thread ${this.threadId}`);
    } catch (err) {
      // Visible degradation (issue #2 Q11): start a fresh thread, record loss.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(
        'warn',
        `thread/resume failed for ${existing}: ${msg}; starting fresh thread`,
      );
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        { baseInstructions: this.deps.systemPromptContent },
      );
      this.threadId = res.thread.id;
      if (this.state.recordLostThread !== undefined) {
        await this.state.recordLostThread(
          this.dispatcherId,
          existing,
          this.threadId,
          `thread/resume failed: ${msg}`,
        );
      } else {
        await this.state.setThreadId(this.dispatcherId, this.threadId);
        await this.state.setStatus(this.dispatcherId, 'degraded', {
          last_error: `thread/resume failed: ${msg}`,
        });
      }
      // Park a warning to be delivered with the next outbound — best-effort
      // queue note. For MVP we just log; full user-visible delivery on next
      // inbound is a follow-up (see PR review).
    }
  }

  /**
   * Submit any accepted inbound message arriving for this dispatcher. Called by
   * the Feishu inbound layer.
   */
  async channelInput(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<AgentRuntimeTurnResult> {
    if (this.turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    // This runtime owns wrapping the channel input into its delivery shape: a
    // structured channel turn becomes the native `<channel source="…">` block
    // (same envelope claude renders); a plain turn (e.g. the completion trigger)
    // passes through unchanged.
    return this.turnManager.enqueue(
      { ...input, text: renderChannelInput(input) },
      hooks,
    );
  }

  /** Inject a system-originated notice (e.g. a restart notice). */
  async systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return this.submitRestartNotice(notice.text);
  }

  /**
   * Codex TeamMate completion delivery — the native inbox-then-trigger idiom.
   *
   * Two steps, in order:
   *  1. `thread/inject_items` appends the completion to the dispatcher thread's
   *     model-visible history as a developer-role message (no fake user turn).
   *     codex folds the item onto the active turn when one is running and never
   *     rejects on a busy thread, so a failure here is a genuine RPC error.
   *  2. a minimal trigger turn through the public `channelInput` seam wakes the
   *     idle dispatcher so it reads the just-injected notification and acts.
   *
   * The trigger turn uses a fresh, non-routable source id per attempt. The turn
   * manager commits its dedup id before `turn/start` and does not roll it back
   * on failure, so a retry that reused one id would come back `duplicate` and be
   * mis-counted as delivered when nothing was submitted. The Dispatcher Service
   * only retries on `failed` (definitely not submitted), so a unique id per
   * attempt re-submits the trigger safely.
   */
  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult> {
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
  ): Promise<TeamMateCompletionDeliveryResult> {
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
    // Inject the completion item at most once per completion id. On a retry
    // (trigger turn failed last time) the item is already in the thread, so we
    // skip straight to re-triggering instead of persisting a duplicate.
    if (!this.injectedCompletionIds.has(completion.id)) {
      try {
        await injectThreadItems(this.client, threadId, [
          await buildCodexCompletionItem(completion),
        ]);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        // `thread/inject_items` exists only on codex 0.137+. On an older codex
        // it RPC-fails here, so surface the version requirement loudly rather
        // than letting the dispatcher silently never see the completion.
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
        // Unreachable with the per-attempt id above; if it ever happens, the
        // turn was NOT freshly submitted, so do not report it as delivered.
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

  /** Graceful stop: stop accepting work, reap codex child. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.setStatus('stopping');
    await this.state.setStatus(this.dispatcherId, 'stopping');
    await this.teardownCodexRuntime();
    this.setStatus('stopped');
    await this.state.setStatus(this.dispatcherId, 'stopped');
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
    // scheduleRestart runs from synchronous event handlers (ws close, child
    // exit); the durable status write is best-effort here — persist it without
    // blocking, logging (never throwing) on failure. The restart timer's later
    // 'starting'/'ready' writes are awaited, so they cannot be reordered behind
    // this one within the backoff delay.
    void this.state
      .setStatus(this.dispatcherId, 'degraded', { last_error: reason })
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
    await this.state.setStatus(this.dispatcherId, 'starting', {
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
      await this.state.setStatus(this.dispatcherId, 'degraded', {
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
    await this.state.setStatus(this.dispatcherId, 'ready', {
      last_ready_at: Date.now(),
      last_error: null,
    });
  }

  private recordCollectedTurn(turn: CollectedTurn): void {
    const messages = turn.items.filter((item) => item.type === 'agentMessage');
    const last = messages[messages.length - 1];
    if (typeof last?.text === 'string' && last.text.length > 0) {
      this.lastResult = { text: last.text };
    }
    // A turn reaching `turn/completed` is the `completed` terminal state. The
    // `stopped` settlement for interrupted turns is emitted by the turn manager
    // on `stop()`.
    this.deps.onTurnSettled?.({ turnId: turn.turnId, status: 'completed' });
  }

  /** Record a completion id as injected, evicting the oldest past a small cap. */
  private rememberInjectedCompletion(id: string): void {
    if (this.injectedCompletionIds.has(id)) return;
    this.injectedCompletionIds.add(id);
    this.injectedCompletionOrder.push(id);
    while (this.injectedCompletionOrder.length > COMPLETION_ID_CACHE_LIMIT) {
      const evicted = this.injectedCompletionOrder.shift();
      if (evicted !== undefined) this.injectedCompletionIds.delete(evicted);
    }
  }

  /** Record a completion id as fully accepted, evicting the oldest past a cap. */
  private rememberAcceptedCompletion(id: string): void {
    if (this.acceptedCompletionIds.has(id)) return;
    this.acceptedCompletionIds.add(id);
    this.acceptedCompletionOrder.push(id);
    while (this.acceptedCompletionOrder.length > COMPLETION_ID_CACHE_LIMIT) {
      const evicted = this.acceptedCompletionOrder.shift();
      if (evicted !== undefined) this.acceptedCompletionIds.delete(evicted);
    }
  }

  private setStatus(s: DispatcherStatus): void {
    this.status = s;
  }
}
