/**
 * Per-dispatcher in-memory inbound submitter.
 *
 * Contract:
 *   - accepted inbound messages are not persisted;
 *   - Feishu message_id redelivery is deduped within this server process;
 *   - one accepted inbound message becomes one Codex `turn/start` submission;
 *   - Codex text output alone does not send anything to Feishu.
 */

import { submitTurnStart } from '../codex/events.js';
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

export type InboundDeliveryResult =
  | { status: 'duplicate' }
  | { status: 'stopped' }
  | { status: 'submitted'; turnId: string }
  | { status: 'failed'; error: Error };

export interface InboundDeliveryHooks {
  /**
   * Called after process-local dedupe accepts the message and before
   * `turn/start` is submitted.
   */
  onAccepted?: (input: InboundTurnInput) => void | Promise<void>;
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
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private stopped = false;
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
   * Submit one accepted inbound message to Codex. Returns duplicate when this
   * process already saw the message_id.
   */
  async enqueue(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<InboundDeliveryResult> {
    if (this.stopped) return { status: 'stopped' };
    if (!this.rememberMessageId(input.source_message_id)) {
      return { status: 'duplicate' };
    }

    await this.notifyAccepted(input, hooks);

    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      const error = new Error('inbound submitted without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    try {
      const res = await submitTurnStart(
        this.opts.client,
        threadId,
        input.parsed_text,
        this.opts.turnCwd ?? null,
      );
      return { status: 'submitted', turnId: res.turn.id };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log(
        'error',
        `turn/start submission failed for message ${input.source_message_id ?? '<none>'}: ${error.message}`,
        error,
      );
      return { status: 'failed', error };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async notifyAccepted(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks,
  ): Promise<void> {
    if (hooks.onAccepted === undefined) return;
    try {
      await hooks.onAccepted(input);
    } catch (err) {
      this.log(
        'warn',
        `accepted-inbound hook failed for message ${input.source_message_id ?? '<none>'}`,
        err,
      );
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
