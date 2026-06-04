/**
 * Per-dispatcher in-memory turn worker.
 *
 * Contract:
 *   - one serialized worker per dispatcher;
 *   - accepted inbound messages are not persisted;
 *   - consecutive pending messages from the same chat are coalesced into one
 *     Codex turn;
 *   - Feishu message_id redelivery is deduped within this server process;
 *   - Codex text output alone does not send anything to Feishu.
 */

import { runTurn } from '../codex/events.js';
import type { CodexWsClient } from '../codex/rpc.js';

export const DEFAULT_MESSAGE_ID_DEDUPE_WINDOW = 1024;

export interface InboundTurnSource {
  source_chat_id: string;
  source_message_id: string | null;
  sender_id: string | null;
}

export interface InboundTurnInput extends InboundTurnSource {
  parsed_text: string;
}

interface TurnBatch extends InboundTurnSource {
  id: number;
  messages: InboundTurnInput[];
}

export interface TurnManagerOptions {
  dispatcherId: string;
  /** Lazily resolved Codex thread id (set after thread/start | resume). */
  getThreadId(): string | null;
  client: CodexWsClient;
  /**
   * Codex cwd to pass on each turn/start. Issue #2 Q1: for MVP we leave
   * this null because thread cwd is set once at thread/start time.
   */
  turnCwd?: string | null;
  /** Process-local Feishu message_id dedupe window size. */
  messageIdDedupeWindow?: number;
  /** Optional logger; defaults to console.error. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
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
  private readonly messageIdDedupeWindow: number;

  constructor(private readonly opts: TurnManagerOptions) {
    this.log = opts.log ?? ((lvl, msg, err) => {
      const prefix = `[turn-manager ${opts.dispatcherId}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.messageIdDedupeWindow = Math.max(
      0,
      opts.messageIdDedupeWindow ?? DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
    );
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
      this.log('error', `turn batch ${batch.id} dequeued without thread_id`);
      return;
    }

    try {
      await runTurn(
        this.opts.client,
        threadId,
        batchPrompt(batch),
        this.opts.turnCwd ?? null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `turn execution failed for batch ${batch.id}: ${msg}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
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
