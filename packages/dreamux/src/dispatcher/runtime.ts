/**
 * DispatcherRuntime — one running dispatcher's in-memory state.
 *
 * Owns:
 *   - CodexProcess (child app-server)
 *   - CodexWsClient (WS connection)
 *   - thread_id (lazily created via thread/start or resumed)
 *   - TurnManager (FIFO worker for this dispatcher)
 *   - approval handler bound to the current "source chat" for hints
 *
 * Lifecycle: declared → starting → ready → (degraded) → stopping → stopped.
 *
 * Issue #2 §"崩溃与异常恢复":
 *   - On startup, mark stale `running` rows as `unknown` before opening
 *     inbound — at-most-once.
 *   - thread/resume failure does not degrade the whole dispatcher; we
 *     start a fresh thread, record the lost one in last_lost_thread_id,
 *     and post a visible warning to the next source chat.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DispatcherRow, DispatcherStatus } from '../db/types.js';
import type {
  DispatcherRepo,
  InboundRepo,
} from '../db/repository.js';
import { CodexProcess, type CodexProcessOptions } from '../codex/supervisor.js';
import { CodexWsClient } from '../codex/rpc.js';
import { performInitializeHandshake } from '../codex/handshake.js';
import type {
  ThreadResumeResponse,
  ThreadStartResponse,
} from '../codex/types.js';
import { TurnManager } from './turn-manager.js';
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
import { outboundTargetForInbound, type OutboundSink } from '../channel/outbound.js';

export interface DispatcherRuntimeDeps {
  dispatchers: DispatcherRepo;
  inbound: InboundRepo;
  outbound: OutboundSink;
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
  /** Outbound retry count. From ~/.dreamux/config.json. */
  outboundRetries?: number;
  /** Outbound retry delay (ms). From ~/.dreamux/config.json. */
  outboundRetryDelayMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export class DispatcherRuntime {
  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private turnManager: TurnManager | null = null;
  private threadId: string | null = null;
  private currentInboundChatId: string | null = null;
  private status: DispatcherStatus = 'declared';
  private readonly log: NonNullable<DispatcherRuntimeDeps['log']>;

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

  /** Called by Feishu inbound right before enqueuing into inbound_buffer. */
  setCurrentInboundChat(chatId: string | null): void {
    this.currentInboundChatId = chatId;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  /**
   * Bring the dispatcher up. Order:
   *  1. crash recovery sweep on inbound_buffer (running → unknown)
   *  2. spawn codex app-server child
   *  3. open WS client
   *  4. install fail-fast approval handler
   *  5. thread/start (new) or thread/resume (existing)
   *  6. install turn manager + retry pending outbound
   *  7. status = ready
   */
  async start(): Promise<void> {
    this.setStatus('starting');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'starting', {
      last_started_at: Date.now(),
    });

    try {
      await this.recoverInboundOnStartup();

      const cwd = this.row.codex_cwd ?? dispatcherCodexCwd(this.dispatcherId);
      const socketPath = dispatcherSocketPath(this.dispatcherId);
      const extraArgs = this.deps.resolveExtraArgs?.(this.row) ?? [];
      if (this.deps.codexHomeDoctor !== undefined) {
        await this.deps.codexHomeDoctor(
          dispatcherCodexHomeDoctorContext(this.dispatcherId, {
            codexCliArgs: extraArgs,
          }),
        );
      }

      const factory = this.deps.codexProcessFactory ?? ((o) => new CodexProcess(o));
      this.process = factory({
        socketPath,
        cwd,
        stdoutLogPath: dispatcherStdoutLog(this.dispatcherId),
        stderrLogPath: dispatcherStderrLog(this.dispatcherId),
        binPath: this.deps.codexBinPath,
        extraArgs,
        env: { ...process.env },
      });
      mkdirSync(dirname(socketPath), { recursive: true });
      await this.process.start();

      const clientFactory =
        this.deps.codexClientFactory ?? ((sock) => new CodexWsClient({ socketPath: sock }));
      this.client = clientFactory(socketPath);
      await this.client.ready();

      const approvalHandler = createFailFastApprovalHandler({
        onReject: async (req) => {
          // Best-effort hint to the user, only if we know who is asking.
          const chatId = this.currentInboundChatId;
          if (chatId === null) return;
          try {
            await this.deps.outbound.send(
              { conversationId: chatId },
              `Codex 请求了一次审批（${req.method}），但当前 dispatcher 不支持审批 —— 本轮将失败。`,
            );
          } catch {
            /* nothing useful to do */
          }
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
        inbound: this.deps.inbound,
        getThreadId: () => this.threadId,
        client: this.client,
        outbound: this.deps.outbound,
        log: this.log,
        ...(this.deps.outboundRetries !== undefined
          ? { outboundRetries: this.deps.outboundRetries }
          : {}),
        ...(this.deps.outboundRetryDelayMs !== undefined
          ? { outboundRetryDelayMs: this.deps.outboundRetryDelayMs }
          : {}),
      });
      await this.turnManager.retryPendingOutbound();

      this.setStatus('ready');
      this.deps.dispatchers.setStatus(this.dispatcherId, 'ready', {
        last_ready_at: Date.now(),
        last_error: null,
      });

      // Issue #2 + PR #3 review #1: the durable inbound buffer's contract
      // says nothing is dropped across a server crash. retryPendingOutbound
      // covers awaiting_outbound / outbound_failed rows; recoverInboundOnStartup
      // covers running → unknown. But rows persisted in 'queued' before the
      // crash are only drained when notify() is invoked, and at startup no
      // new inbound has arrived yet. Kick the worker once so any
      // already-queued backlog drains immediately instead of stalling until
      // the next live message lands.
      this.turnManager.notify();
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

  private async resolveThread(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    const existing = this.row.thread_id;
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
   * Drain any inbound message arriving for this dispatcher. Called by the
   * Feishu inbound layer. Returns the assigned inbound row id, or null if
   * the message was a duplicate.
   */
  enqueueInbound(input: {
    source_chat_id: string;
    source_message_id: string | null;
    sender_id: string | null;
    feishu_event_json: string;
    parsed_text: string;
  }): number | null {
    const row = this.deps.inbound.enqueue({
      dispatcher_id: this.dispatcherId,
      ...input,
    });
    if (row === null) return null;
    this.setCurrentInboundChat(input.source_chat_id);
    this.turnManager?.notify();
    return row.id;
  }

  private async recoverInboundOnStartup(): Promise<void> {
    const stale = this.deps.inbound.markRunningAsUnknown(this.dispatcherId);
    for (const row of stale) {
      this.log(
        'warn',
        `inbound ${row.id} was 'running' at restart — marked unknown (at-most-once); chat=${row.source_chat_id}`,
      );
      try {
        await this.deps.outbound.send(
          outboundTargetForInbound(row),
          `上一次的执行结果未知（server 重启时正在进行）。请确认是否需要重新发送：\n> ${row.parsed_text.slice(0, 200)}`,
        );
      } catch (err) {
        this.log('warn', `failed to notify chat about unknown inbound`, err);
      }
    }
  }

  /** Graceful stop: stop accepting work, reap codex child. */
  async stop(): Promise<void> {
    this.setStatus('stopping');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'stopping');
    if (this.turnManager !== null) await this.turnManager.stop();
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* best effort */
      }
    }
    if (this.process !== null) {
      await this.process.reap();
    }
    this.setStatus('stopped');
    this.deps.dispatchers.setStatus(this.dispatcherId, 'stopped');
  }

  private async cleanupOnFailure(): Promise<void> {
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* */
      }
      this.client = null;
    }
    if (this.process !== null) {
      await this.process.reap();
      this.process = null;
    }
    this.turnManager = null;
  }

  private setStatus(s: DispatcherStatus): void {
    this.status = s;
  }
}
