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
  type TurnCollector,
} from './events.js';
import type { CodexWsClient } from './rpc.js';
import {
  DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
  type InboundTurnInput,
  type InboundDeliveryResult,
  type NoticeInjectionResult,
  type InboundDeliveryHooks,
  type TurnSettledSignal,
} from '../../turn.js';

interface ActiveTurnSlot {
  collector: TurnCollector;
  turnId: string | null;
  candidateTurnId: string | null;
  primaryFailed: boolean;
  pendingSubmissions: number;
  turnIdPromise: Promise<string>;
  resolveTurnId: (turnId: string) => void;
  rejectTurnId: (err: Error) => void;
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
  /** Best-effort runtime-local snapshot hook for `AgentRuntime.getLast()`. */
  onTurnCompleted?: (turn: CollectedTurn) => void;
  /**
   * Fired when a submitted turn is cut short by `stop()` before it reached
   * `turn/completed` (a crashed or torn-down runtime). The successful
   * `completed` settlement is fired by the runtime from its `onTurnCompleted`
   * handler; this hook only covers the `stopped` case so an in-flight teammate
   * turn never vanishes silently.
   */
  onTurnSettled?: (settled: TurnSettledSignal) => void;
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
  private activeTurnSlot: ActiveTurnSlot | null = null;
  private activeTurnId: string | null = null;
  /**
   * Turn ids submitted to Codex that have not yet reached `turn/completed`. On
   * `stop()` each still-pending turn is settled as `stopped` so a teammate turn
   * interrupted by teardown is not lost.
   */
  private readonly pendingTurnIds = new Set<string>();
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

    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      await this.notifyAccepted(input, hooks);
      const error = new Error('inbound submitted without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    const activeTurn = this.claimActiveTurnSlot(threadId);
    activeTurn.slot.pendingSubmissions += 1;
    await this.notifyAccepted(input, hooks);

    let res: Awaited<ReturnType<typeof submitTurnStart>>;
    try {
      res = await submitTurnStart(
        this.opts.client,
        threadId,
        input.text,
        this.opts.turnCwd ?? null,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordTurnStartFailure(activeTurn.slot, error, activeTurn.primary);
      this.log(
        'error',
        `turn/start submission failed for message ${input.sourceId === '' ? '<none>' : input.sourceId}: ${error.message}`,
        error,
      );
      return { status: 'failed', error };
    }
    const turnId = this.recordTurnStartSuccess(
      activeTurn.slot,
      res.turn.id,
      activeTurn.primary,
    );
    try {
      return {
        status: 'submitted',
        turnId: turnId ?? await activeTurn.slot.turnIdPromise,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
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
      this.trackTurn(res.turn.id, collector);
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
    const activeSlot = this.activeTurnSlot;
    this.activeTurnSlot = null;
    if (activeSlot !== null && activeSlot.turnId === null) {
      activeSlot.rejectTurnId(new Error('codex turn stopped before acceptance'));
    }
    // Any turn still in flight at teardown will never reach `turn/completed`
    // (the WS is closing). Settle each as `stopped` so an interrupted teammate
    // turn is delivered with a status rather than vanishing.
    for (const turnId of this.pendingTurnIds) {
      this.opts.onTurnSettled?.({ turnId, status: 'stopped' });
    }
    this.pendingTurnIds.clear();
    this.activeTurnId = null;
  }

  private claimActiveTurnSlot(threadId: string): {
    slot: ActiveTurnSlot;
    primary: boolean;
  } {
    const active = this.activeTurnSlot;
    if (active !== null) return { slot: active, primary: false };

    let resolveTurnId!: (turnId: string) => void;
    let rejectTurnId!: (err: Error) => void;
    const turnIdPromise = new Promise<string>((resolve, reject) => {
      resolveTurnId = resolve;
      rejectTurnId = reject;
    });
    // The primary submitter returns its own failure directly. The shared promise
    // only exists for concurrent followers waiting for that primary turn id, so
    // reject it without producing an unhandled rejection when there are none.
    turnIdPromise.catch(() => undefined);
    const slot: ActiveTurnSlot = {
      collector: subscribeTurnCollection(this.opts.client, threadId),
      turnId: null,
      candidateTurnId: null,
      primaryFailed: false,
      pendingSubmissions: 0,
      turnIdPromise,
      resolveTurnId,
      rejectTurnId,
    };
    this.activeTurnSlot = slot;
    return { slot, primary: true };
  }

  private recordTurnStartSuccess(
    slot: ActiveTurnSlot,
    turnId: string,
    primary: boolean,
  ): string | null {
    slot.pendingSubmissions = Math.max(0, slot.pendingSubmissions - 1);
    if (slot.turnId !== null) return slot.turnId;
    if (this.stopped) {
      slot.rejectTurnId(new Error('codex turn stopped before acceptance'));
      return null;
    }
    if (primary || slot.primaryFailed) {
      this.activateTurnSlot(slot, turnId);
      return turnId;
    }
    slot.candidateTurnId ??= turnId;
    return null;
  }

  private recordTurnStartFailure(
    slot: ActiveTurnSlot,
    error: Error,
    primary: boolean,
  ): void {
    slot.pendingSubmissions = Math.max(0, slot.pendingSubmissions - 1);
    if (slot.turnId !== null) return;
    if (primary) slot.primaryFailed = true;
    if (slot.primaryFailed && slot.candidateTurnId !== null) {
      this.activateTurnSlot(slot, slot.candidateTurnId);
      return;
    }
    if (slot.primaryFailed && slot.pendingSubmissions === 0) {
      if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
      slot.rejectTurnId(error);
    }
  }

  private activateTurnSlot(slot: ActiveTurnSlot, turnId: string): void {
    if (slot.turnId !== null) return;
    slot.turnId = turnId;
    this.trackTurn(turnId, slot.collector, slot);
    slot.resolveTurnId(turnId);
  }

  /**
   * Record a submitted turn as pending and wire its completion. On
   * `turn/completed` the turn is removed from the pending set and the snapshot
   * hook fires (which is where the runtime emits the `completed` settlement). On
   * a terminal turn failure (collector rejects: codex `error` with
   * `willRetry: false`, or a `turn/completed` carrying `turn.error`) the turn is
   * settled as `failed` here, so a teammate turn that errors at the model level
   * is delivered with a status instead of hanging until teardown.
   */
  private trackTurn(
    turnId: string,
    collector: TurnCollector,
    slot?: ActiveTurnSlot,
  ): void {
    if (this.pendingTurnIds.has(turnId)) return;
    this.pendingTurnIds.add(turnId);
    this.activeTurnId = turnId;
    void collector.awaitTurn(turnId).then(
      (turn) => {
        // Only forward completion if this turn was still pending. If `stop()`
        // already settled it as `stopped`, the delete returns false and we drop
        // the late completion so a turn is never settled twice.
        if (this.pendingTurnIds.delete(turnId)) {
          if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
          if (this.activeTurnId === turnId) this.activeTurnId = null;
          this.opts.onTurnCompleted?.(turn);
        }
      },
      (err) => {
        // Same mutual-exclusion guard as the completed path: only settle as
        // `failed` if `stop()` did not already settle it as `stopped`.
        if (this.pendingTurnIds.delete(turnId)) {
          if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
          if (this.activeTurnId === turnId) this.activeTurnId = null;
          this.opts.onTurnSettled?.({
            turnId,
            status: 'failed',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      },
    );
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
