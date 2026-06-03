/**
 * Per-dispatcher in-memory turn worker.
 *
 * Task 7 / top-level design contract:
 *   - one serialized worker per dispatcher;
 *   - accepted inbound messages are not persisted;
 *   - consecutive pending messages from the same chat are coalesced into one
 *     Codex turn;
 *   - Feishu message_id redelivery is deduped within this server process.
 */

import type { CodexWsClient } from '../codex/rpc.js';
import { extractAssistantText, runTurn } from '../codex/events.js';
import {
  outboundTargetForInbound,
  type InboundOutboundSource,
  type OutboundSink,
} from '../channel/outbound.js';

export const DEFAULT_MESSAGE_ID_DEDUPE_WINDOW = 1024;

export interface InboundTurnInput extends InboundOutboundSource {
  parsed_text: string;
}

interface TurnBatch extends InboundOutboundSource {
  id: number;
  messages: InboundTurnInput[];
}

export interface TurnManagerOptions {
  dispatcherId: string;
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
  /** Process-local Feishu message_id dedupe window size. */
  messageIdDedupeWindow?: number;
  /** Tracks the currently running chat for approval rejection hints. */
  onCurrentChat?: (chatId: string | null) => void;
  /** Optional logger; defaults to console.error. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  /**
   * Fallback assistant text when codex finished a turn without an
   * `agentMessage` item. Issue #2 §"开放问题 Q4".
   */
  emptyTurnPlaceholder?: string;
}

export class TurnManager {
  private readonly queue: TurnBatch[] = [];
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private running = false;
  private stopped = false;
  private drainScheduled = false;
  private wakeup: (() => void) | null = null;
  private nextBatchId = 1;
  private readonly log: NonNullable<TurnManagerOptions['log']>;
  private readonly outboundRetries: number;
  private readonly outboundRetryDelayMs: number;
  private readonly messageIdDedupeWindow: number;
  private readonly emptyTurnPlaceholder: string;

  constructor(private readonly opts: TurnManagerOptions) {
    this.log = opts.log ?? ((lvl, msg, err) => {
      const prefix = `[turn-manager ${opts.dispatcherId}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.outboundRetries = opts.outboundRetries ?? 3;
    this.outboundRetryDelayMs = opts.outboundRetryDelayMs ?? 1000;
    this.messageIdDedupeWindow = Math.max(
      0,
      opts.messageIdDedupeWindow ?? DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
    );
    this.emptyTurnPlaceholder =
      opts.emptyTurnPlaceholder ?? '本轮没有文本回复。';
  }

  /**
   * Queue one accepted inbound message. Returns false when the message_id was
   * already seen in this server process.
   */
  enqueue(input: InboundTurnInput): boolean {
    if (this.stopped) return false;
    if (!this.rememberMessageId(input.source_message_id)) return false;

    const pending = this.queue.find(
      (batch) => batch.source_chat_id === input.source_chat_id,
    );
    if (pending !== undefined) {
      pending.messages.push(input);
      pending.source_message_id = input.source_message_id;
      pending.sender_id = input.sender_id;
    } else {
      this.queue.push({
        id: this.nextBatchId++,
        source_chat_id: input.source_chat_id,
        source_message_id: input.source_message_id,
        sender_id: input.sender_id,
        messages: [input],
      });
    }

    this.notify();
    return true;
  }

  /** Notify the worker that new work may be available. */
  private notify(): void {
    if (this.stopped) return;
    if (this.wakeup !== null) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
      return;
    }
    if (this.running || this.drainScheduled) return;
    this.drainScheduled = true;
    setTimeout(() => {
      this.drainScheduled = false;
      if (!this.stopped) void this.drainLoop();
    }, 0);
  }

  /** Drain queued batches until the queue is empty or we're stopped. */
  private async drainLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const batch = this.queue.shift();
        if (batch === undefined) {
          await this.waitForNotify();
          if (this.stopped) return;
          continue;
        }
        await this.processBatch(batch);
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

  private async processBatch(batch: TurnBatch): Promise<void> {
    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      // Should not happen — dispatcher is "ready" only after thread is set.
      this.log('error', `turn batch ${batch.id} dequeued without thread_id`);
      return;
    }

    this.opts.onCurrentChat?.(batch.source_chat_id);
    let assistantText: string;
    try {
      const turn = await runTurn(
        this.opts.client,
        threadId,
        batchPrompt(batch),
        this.opts.turnCwd ?? null,
      );
      assistantText =
        extractAssistantText(turn) ?? this.emptyTurnPlaceholder;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `turn execution failed for batch ${batch.id}: ${msg}`);
      // Best-effort tell the user something went wrong.
      try {
        await this.opts.outbound.send(
          outboundTargetForInbound(batch),
          `本次请求执行失败：${msg}`,
        );
      } catch (sendErr) {
        this.log('warn', `error notification also failed`, sendErr);
      }
      this.opts.onCurrentChat?.(null);
      return;
    }

    this.opts.onCurrentChat?.(null);
    await this.sendOutbound(batch, assistantText);
  }

  /** Send assistant text to feishu with bounded in-process retry. */
  private async sendOutbound(batch: TurnBatch, text: string): Promise<void> {
    let lastError: unknown;
    const target = outboundTargetForInbound(batch);
    for (let attempt = 0; attempt <= this.outboundRetries; attempt++) {
      try {
        await this.opts.outbound.send(target, text);
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
    this.log('error', `outbound send failed for batch ${batch.id}: ${msg}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    this.opts.onCurrentChat?.(null);
    if (this.wakeup !== null) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
  }

  private rememberMessageId(messageId: string | null): boolean {
    if (messageId === null || messageId === '') return true;
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.add(messageId);
    this.seenMessageIdOrder.push(messageId);
    while (this.seenMessageIdOrder.length > this.messageIdDedupeWindow) {
      const evicted = this.seenMessageIdOrder.shift();
      if (evicted !== undefined) this.seenMessageIds.delete(evicted);
    }
    return true;
  }
}

function batchPrompt(batch: TurnBatch): string {
  return batch.messages.map((message) => message.parsed_text).join('\n\n');
}
