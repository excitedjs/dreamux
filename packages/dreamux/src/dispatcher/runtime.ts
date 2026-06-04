/**
 * DispatcherRuntime — one running dispatcher's in-memory state.
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

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../runtime/dispatcher-store.js';
import {
  CodexProcess,
  type CodexProcessExit,
  type CodexProcessOptions,
} from '../codex/supervisor.js';
import { CodexWsClient } from '../codex/rpc.js';
import { performInitializeHandshake } from '../codex/handshake.js';
import type {
  ThreadResumeResponse,
  ThreadStartResponse,
} from '../codex/types.js';
import {
  TurnManager,
  type InboundDeliveryHooks,
  type InboundDeliveryResult,
  type InboundTurnInput,
} from './turn-manager.js';
import { createFailFastApprovalHandler } from './approval.js';
import {
  dispatcherCodexCwd,
  dispatcherSocketPath,
  dispatcherStderrLog,
  dispatcherStdoutLog,
} from '../runtime/paths.js';
import {
  dispatcherCodexHomeDoctorContext,
  type DispatcherCodexHomeDoctor,
} from '../runtime/dispatcher-codex-home.js';
import { dispatcherProcessEnv } from '../runtime/package-bin.js';

const DEFAULT_RESTART_BACKOFF_BASE_MS = 1000;
const DEFAULT_RESTART_BACKOFF_MAX_MS = 30_000;

export interface DispatcherRuntimeDeps {
  dispatchers: DispatcherStore;
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
  /** Codex initialize handshake timeout (ms). From ~/.dreamux/config.json. */
  handshakeTimeoutMs?: number;
  /** Per-dispatcher environment overrides from config. */
  extraEnv?: Record<string, string>;
  /** Codex child/WS restart backoff base (tests may override). */
  restartBackoffBaseMs?: number;
  /** Codex child/WS restart backoff cap (tests may override). */
  restartBackoffMaxMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export class DispatcherRuntime {
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
  private readonly log: NonNullable<DispatcherRuntimeDeps['log']>;
  private stopping = false;
  private restarting = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly row: DispatcherRow,
    private readonly deps: DispatcherRuntimeDeps,
  ) {
    this.log = deps.log ?? ((lvl, msg, err) => {
      const prefix = `[dispatcher ${row.dispatcher_id}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.threadId = row.thread_id;
  }

  get dispatcherId(): string {
    return this.row.dispatcher_id;
  }

  getStatus(): DispatcherStatus {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  /** True when the live thread was resumed (not freshly started/recovered). */
  wasThreadResumed(): boolean {
    return this.threadResumed;
  }

  /**
   * Inject a best-effort one-shot restart notice into the resumed thread. The
   * server calls this only after the dispatcher slot is ready (so the resumed
   * turn can reply through Feishu). Never throws — failures are logged.
   */
  async injectRestartNotice(text: string): Promise<void> {
    if (this.turnManager === null) return;
    const result = await this.turnManager.injectNotice(text);
    if (result.status === 'submitted') {
      this.log('info', 'restart notice injected into resumed thread');
    } else if (result.status === 'skipped') {
      this.log('info', 'restart notice skipped; a live inbound already arrived');
    }
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
    this.deps.dispatchers.setStatus(this.dispatcherId, 'starting', {
      last_started_at: Date.now(),
    });

    try {
      await this.startCodexRuntime();
      this.markReady();

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      this.setStatus('degraded');
      this.deps.dispatchers.setStatus(this.dispatcherId, 'degraded', {
        last_error: msg,
      });
      await this.cleanupOnFailure();
      throw err;
    }
  }

  private async startCodexRuntime(): Promise<void> {
    const cwd = this.row.codex_cwd ?? dispatcherCodexCwd(this.dispatcherId);
    const socketPath = dispatcherSocketPath(this.dispatcherId);
    const extraArgs = this.deps.resolveExtraArgs?.(this.row) ?? [];
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
      stdoutLogPath: dispatcherStdoutLog(this.dispatcherId),
      stderrLogPath: dispatcherStderrLog(this.dispatcherId),
      binPath: this.deps.codexBinPath,
      extraArgs,
      env: dispatcherProcessEnv(globalThis.process.env, this.deps.extraEnv ?? {}),
    });
    this.process = process;
    process.onExit((exit) => {
      if (this.process !== process) return;
      this.handleChildExit(exit);
    });
    mkdirSync(dirname(socketPath), { recursive: true });
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
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        {},
      );
      this.threadId = res.thread.id;
      this.deps.dispatchers.setThreadId(this.dispatcherId, this.threadId);
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }
    try {
      await this.client.request<ThreadResumeResponse>('thread/resume', {
        threadId: existing,
      });
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
        {},
      );
      this.threadId = res.thread.id;
      this.deps.dispatchers.recordLostThread(
        this.dispatcherId,
        existing,
        this.threadId,
        `thread/resume failed: ${msg}`,
      );
      // Park a warning to be delivered with the next outbound — best-effort
      // queue note. For MVP we just log; full user-visible delivery on next
      // inbound is a follow-up (see PR review).
    }
  }

  /**
   * Submit any accepted inbound message arriving for this dispatcher. Called by
   * the Feishu inbound layer.
   */
  async enqueueInbound(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<InboundDeliveryResult> {
    if (this.turnManager === null) {
      return { status: 'failed', error: new Error('turn manager not initialized') };
    }
    return this.turnManager.enqueue(input, hooks);
  }

  /** Graceful stop: stop accepting work, reap codex child. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.setStatus('stopping');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'stopping');
    await this.teardownCodexRuntime();
    this.setStatus('stopped');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'stopped');
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
    this.deps.dispatchers.setStatus(this.dispatcherId, 'degraded', {
      last_error: reason,
    });
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
    this.deps.dispatchers.setStatus(this.dispatcherId, 'starting', {
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
      this.markReady();
      this.log('info', `restarted codex app-server after: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `restart failed: ${msg}`, err);
      this.setStatus('degraded');
      this.deps.dispatchers.setStatus(this.dispatcherId, 'degraded', {
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

  private markReady(): void {
    this.setStatus('ready');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'ready', {
      last_ready_at: Date.now(),
      last_error: null,
    });
  }

  private setStatus(s: DispatcherStatus): void {
    this.status = s;
  }
}
