/**
 * Per-dispatcher in-memory inbound submitter.
 *
 * Contract:
 *   - accepted inbound messages are not persisted;
 *   - Feishu message_id redelivery is deduped within this server process;
 *   - one accepted inbound message becomes one Codex `turn/start` submission;
 *   - Codex text output alone does not send anything to Feishu.
 */

import {
  subscribeTurnCollection,
  submitTurnStart,
  type CollectedTurn,
} from './events.js';
import type { CodexWsClient } from './rpc.js';
import {
  DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
  type InboundTurnInput,
  type InboundDeliveryResult,
  type NoticeInjectionResult,
  type InboundDeliveryHooks,
} from '../../turn.js';

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
  /** Best-effort runtime-local snapshot hook for `AgentRuntime.getLast()`. */
  onTurnCompleted?: (turn: CollectedTurn) => void;
}

export class TurnManager {
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private stopped = false;
  /**
   * Set once any real inbound has been accepted and handed to Codex. There is
   * no FIFO queue here — inbound submission folds onto Codex's active turn — so
   * this flag is what lets a best-effort restart-notice injection detect an
   * in-flight inbound and skip rather than wake the thread twice (issue #78).
   */
  private inboundSubmitted = false;
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
    if (!this.rememberMessageId(input.sourceId)) {
      return { status: 'duplicate' };
    }
    // Mark before any await so a concurrent restart-notice injection observes
    // that a real inbound is in flight and skips itself.
    this.inboundSubmitted = true;

    await this.notifyAccepted(input, hooks);

    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      const error = new Error('inbound submitted without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    try {
      const collector = subscribeTurnCollection(this.opts.client, threadId);
      const res = await submitTurnStart(
        this.opts.client,
        threadId,
        input.text,
        this.opts.turnCwd ?? null,
      );
      void collector.awaitTurn().then(
        (turn) => this.opts.onTurnCompleted?.(turn),
        () => undefined,
      );
      return { status: 'submitted', turnId: res.turn.id };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log(
        'error',
        `turn/start submission failed for message ${input.sourceId === '' ? '<none>' : input.sourceId}: ${error.message}`,
        error,
      );
      return { status: 'failed', error };
    }
  }

  /**
   * Best-effort one-shot notice injected after a `daemon restart --notify-
   * resumed` resumes this dispatcher's thread. Skips if the manager is stopped,
   * if a real inbound has already woken the thread, or if no thread is bound.
   * A submission failure is reported, never thrown — it must not fail the
   * dispatcher's start or the restart.
   */
  async injectNotice(text: string): Promise<NoticeInjectionResult> {
    if (this.stopped) return { status: 'stopped' };
    if (this.inboundSubmitted) return { status: 'skipped' };

    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      const error = new Error('restart notice injected without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    // Mark before submitting so a racing real inbound is not double-counted and
    // a second injection cannot fire.
    this.inboundSubmitted = true;
    try {
      const collector = subscribeTurnCollection(this.opts.client, threadId);
      const res = await submitTurnStart(
        this.opts.client,
        threadId,
        text,
        this.opts.turnCwd ?? null,
      );
      void collector.awaitTurn().then(
        (turn) => this.opts.onTurnCompleted?.(turn),
        () => undefined,
      );
      this.log('info', `injected restart notice into thread ${threadId}`);
      return { status: 'submitted', turnId: res.turn.id };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log('warn', `restart notice injection failed: ${error.message}`, error);
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
        `accepted-inbound hook failed for message ${input.sourceId === '' ? '<none>' : input.sourceId}`,
        err,
      );
    }
  }

  private rememberMessageId(messageId: string): boolean {
    if (messageId === '') return true;
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
