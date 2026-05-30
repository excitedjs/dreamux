/**
 * Per-dispatcher FIFO turn worker.
 *
 * Issue #2 §"Codex 协议处理": the queue worker is the single executor for one
 * dispatcher's Codex thread. Holds an in-memory FIFO; pulls from
 * `inbound_buffer` lazily so we never lose messages across crashes.
 *
 * State machine (transitions are the only ones this worker performs):
 *   queued
 *     └─[worker]→ running
 *           └─[turn/completed]→ awaiting_outbound
 *                   ├─[feishu send OK]→ completed
 *                   └─[feishu send fail]→ outbound_failed → retry → completed
 *           └─[turn/start RPC failure]→ failed
 *
 * Server crash recovery is handled separately by `recoverDispatcher()`:
 *   running          → unknown (at-most-once, see issue #2 §"崩溃与异常恢复")
 *   awaiting_outbound → safe to retry the outbound
 *   outbound_failed   → safe to retry the outbound
 */

import type { InboundRepo } from '../db/repository.js';
import type { InboundRow } from '../db/types.js';
import type { CodexWsClient } from '../codex/rpc.js';
import { extractAssistantText, runTurn } from '../codex/events.js';

export interface OutboundSink {
  /** Send `text` to `chatId`; return the array of feishu message_ids sent. */
  sendText(chatId: string, text: string): Promise<string[]>;
}

export interface TurnManagerOptions {
  dispatcherId: string;
  inbound: InboundRepo;
  /** Lazily resolved Codex thread id (set after thread/start | resume). */
  getThreadId(): string | null;
  client: CodexWsClient;
  outbound: OutboundSink;
  /**
   * Codex cwd to pass on each turn/start. Issue #2 §"开放问题 Q1": for MVP
   * we leave this null (thread cwd is set once at thread/start time).
   */
  turnCwd?: string | null;
  /**
   * Outbound retry policy. P0 simple linear retry; production should add
   * exponential backoff (out of MVP scope).
   */
  outboundRetries?: number;
  outboundRetryDelayMs?: number;
  /** Optional logger; defaults to console.error. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  /**
   * Fallback assistant text when codex finished a turn without an
   * `agentMessage` item. Issue #2 §"开放问题 Q4".
   */
  emptyTurnPlaceholder?: string;
}

export class TurnManager {
  private running = false;
  private stopped = false;
  private wakeup: (() => void) | null = null;
  private readonly log: NonNullable<TurnManagerOptions['log']>;
  private readonly outboundRetries: number;
  private readonly outboundRetryDelayMs: number;
  private readonly emptyTurnPlaceholder: string;

  constructor(private readonly opts: TurnManagerOptions) {
    this.log = opts.log ?? ((lvl, msg, err) => {
      const prefix = `[turn-manager ${opts.dispatcherId}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.outboundRetries = opts.outboundRetries ?? 3;
    this.outboundRetryDelayMs = opts.outboundRetryDelayMs ?? 1000;
    this.emptyTurnPlaceholder =
      opts.emptyTurnPlaceholder ?? '本轮没有文本回复。';
  }

  /**
   * Notify the worker that new work may be available.
   * Idempotent — multiple wakeups collapse into the next loop iteration.
   */
  notify(): void {
    if (this.stopped) return;
    if (this.wakeup !== null) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
    void this.drainLoop();
  }

  /** Drain queued rows until the queue is empty or we're stopped. */
  private async drainLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const row = this.opts.inbound.takeNextQueued(this.opts.dispatcherId);
        if (row === null) {
          await this.waitForNotify();
          if (this.stopped) return;
          continue;
        }
        await this.processInbound(row);
      }
    } finally {
      this.running = false;
    }
  }

  private waitForNotify(): Promise<void> {
    return new Promise<void>((res) => {
      this.wakeup = res;
    });
  }

  private async processInbound(row: InboundRow): Promise<void> {
    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      // Should not happen — dispatcher is "ready" only after thread is set.
      this.log('error', `inbound row ${row.id} dequeued without thread_id`);
      this.opts.inbound.markFailed(row.id, 'dispatcher has no thread_id');
      return;
    }

    // Mark running first (before turn/start) so a crash mid-RPC still
    // leaves a recoverable trace.
    this.opts.inbound.markRunning(row.id, null);

    let assistantText: string;
    try {
      const turn = await runTurn(
        this.opts.client,
        threadId,
        row.parsed_text,
        this.opts.turnCwd ?? null,
      );
      // Record the turn id for diagnostics — non-fatal if this column
      // can't be updated (e.g. row was already advanced by another path).
      this.opts.inbound.markRunning(row.id, turn.turnId);
      assistantText =
        extractAssistantText(turn) ?? this.emptyTurnPlaceholder;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `turn execution failed for inbound ${row.id}: ${msg}`);
      this.opts.inbound.markFailed(row.id, msg);
      // Best-effort tell the user something went wrong.
      try {
        await this.opts.outbound.sendText(
          row.source_chat_id,
          `本次请求执行失败：${msg}`,
        );
      } catch (sendErr) {
        this.log('warn', `error notification also failed`, sendErr);
      }
      return;
    }

    this.opts.inbound.markAwaitingOutbound(row.id, assistantText);
    await this.sendOutbound(row.id, row.source_chat_id, assistantText);
  }

  /** Send assistant text to feishu with bounded retry. */
  private async sendOutbound(
    inboundId: number,
    chatId: string,
    text: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.outboundRetries; attempt++) {
      try {
        const ids = await this.opts.outbound.sendText(chatId, text);
        this.opts.inbound.markCompleted(inboundId, ids);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < this.outboundRetries) {
          await new Promise<void>((r) =>
            setTimeout(r, this.outboundRetryDelayMs),
          );
        }
      }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    this.log('error', `outbound send failed for inbound ${inboundId}: ${msg}`);
    this.opts.inbound.markOutboundFailed(inboundId, msg);
  }

  /**
   * Retry rows previously left in awaiting_outbound / outbound_failed
   * (no Codex turn re-runs — assistant_text is already in the DB).
   * Called once at dispatcher startup, after thread/resume succeeds.
   */
  async retryPendingOutbound(): Promise<void> {
    const pending = this.opts.inbound.listAwaitingOrFailedOutbound(
      this.opts.dispatcherId,
    );
    for (const row of pending) {
      if (row.assistant_text === null) {
        // Should not happen — awaiting_outbound implies assistant_text was set.
        this.log(
          'warn',
          `pending outbound ${row.id} has no assistant_text; marking failed`,
        );
        this.opts.inbound.markFailed(
          row.id,
          'awaiting_outbound row missing assistant_text',
        );
        continue;
      }
      await this.sendOutbound(row.id, row.source_chat_id, row.assistant_text);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wakeup !== null) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
  }
}
