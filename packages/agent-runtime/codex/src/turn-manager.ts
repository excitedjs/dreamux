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
  extractAssistantText,
  subscribeTurnCollection,
  submitTurnStart,
  type CollectedTurn,
  type TurnCollector,
} from './events.js';
import {
  compileCodexOutputSchema,
  type CodexOutputSchemaCodec,
} from './output-schema-codec.js';
import type { CodexWsClient } from './rpc.js';
import {
  DEFAULT_MESSAGE_ID_DEDUPE_WINDOW,
  unsupportedFeatureError,
} from '@excitedjs/dreamux-utils';
import type {
  InboundTurnInput,
  InboundDeliveryResult,
  AgentRuntimeTextInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

interface ActiveTurnSlot {
  collector: TurnCollector;
  codec: CodexOutputSchemaCodec | null;
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
  private readonly seenTextInputIds = new Set<string>();
  private readonly seenTextInputIdOrder: string[] = [];
  private stopped = false;
  private activeTurnSlot: ActiveTurnSlot | null = null;
  private activeTurnId: string | null = null;
  /**
   * Turn ids submitted to Codex that have not yet reached `turn/completed`. On
   * `stop()` each still-pending turn is settled as `stopped` so a teammate turn
   * interrupted by teardown is not lost.
   */
  private readonly pendingTurns = new Map<
    string,
    { codec: CodexOutputSchemaCodec | null }
  >();
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;
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

  isBusy(): boolean {
    return this.activeTurnSlot !== null || this.pendingTurns.size > 0;
  }

  waitIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    // All concurrent waiters share one promise for the current busy period; it
    // is replaced with a fresh one the next time the runtime goes busy.
    if (this.idlePromise === null) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolve = resolve;
      });
    }
    return this.idlePromise;
  }

  /**
   * Submit one accepted inbound message to Codex. Returns duplicate when this
   * process already saw the message_id.
   */
  async enqueue(input: InboundTurnInput): Promise<InboundDeliveryResult> {
    if (this.stopped) return { status: 'stopped' };
    if (!this.rememberMessageId(input.sourceId)) {
      return { status: 'duplicate' };
    }
    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      const error = new Error('inbound submitted without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    let activeTurn: ReturnType<TurnManager['claimActiveTurnSlot']>;
    try {
      activeTurn = this.claimActiveTurnSlot(threadId, null);
    } catch (err) {
      const error = asError(err);
      this.log('error', error.message, error);
      return { status: 'failed', error };
    }
    activeTurn.slot.pendingSubmissions += 1;

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

  async submitTextInput(input: AgentRuntimeTextInput): Promise<InboundDeliveryResult> {
    if (this.stopped) return { status: 'stopped' };
    if (
      input.sourceId !== undefined &&
      input.sourceId !== '' &&
      !this.rememberTextInputId(input.sourceId)
    ) {
      return { status: 'duplicate' };
    }
    const threadId = this.opts.getThreadId();
    if (threadId === null) {
      const error = new Error('text input submitted without thread_id');
      this.log('error', error.message);
      return { status: 'failed', error };
    }

    let codec: CodexOutputSchemaCodec | null = null;
    if (input.outputSchema !== undefined) {
      try {
        codec = compileCodexOutputSchema(input.outputSchema);
      } catch (err) {
        const error = asError(err);
        this.log('error', error.message, error);
        return { status: 'failed', error };
      }
    }
    let activeTurn: ReturnType<TurnManager['claimActiveTurnSlot']>;
    try {
      activeTurn = this.claimActiveTurnSlot(threadId, codec);
    } catch (err) {
      const error = asError(err);
      this.log('error', error.message, error);
      return { status: 'failed', error };
    }
    activeTurn.slot.pendingSubmissions += 1;

    let res: Awaited<ReturnType<typeof submitTurnStart>>;
    try {
      res = await submitTurnStart(
        this.opts.client,
        threadId,
        input.text,
        this.opts.turnCwd ?? null,
        activeTurn.slot.codec?.wireSchema,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordTurnStartFailure(activeTurn.slot, error, activeTurn.primary);
      this.log('error', `text turn/start submission failed: ${error.message}`, error);
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

  async stop(): Promise<void> {
    this.stopped = true;
    const activeSlot = this.activeTurnSlot;
    this.activeTurnSlot = null;
    if (activeSlot !== null) {
      activeSlot.collector.dispose();
      activeSlot.codec = null;
    }
    if (activeSlot !== null && activeSlot.turnId === null) {
      activeSlot.rejectTurnId(new Error('codex turn stopped before acceptance'));
    }
    // Any turn still in flight at teardown will never reach `turn/completed`
    // (the WS is closing). Settle each as `stopped` so an interrupted teammate
    // turn is delivered with a status rather than vanishing.
    for (const turnId of this.pendingTurns.keys()) {
      this.opts.onTurnSettled?.({
        turnId,
        status: 'stopped',
        result: { text: null },
      });
    }
    this.pendingTurns.clear();
    this.activeTurnId = null;
    this.resolveIdleWaitersIfIdle();
  }

  private claimActiveTurnSlot(
    threadId: string,
    codec: CodexOutputSchemaCodec | null,
  ): {
    slot: ActiveTurnSlot;
    primary: boolean;
  } {
    const active = this.activeTurnSlot;
    if (active !== null) {
      assertCompatibleCodec(active.codec, codec);
      return { slot: active, primary: false };
    }

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
      codec,
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
      slot.collector.dispose();
      slot.codec = null;
      slot.rejectTurnId(error);
      this.resolveIdleWaitersIfIdle();
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
    slot: ActiveTurnSlot,
  ): void {
    if (this.pendingTurns.has(turnId)) return;
    this.pendingTurns.set(turnId, { codec: slot.codec });
    this.activeTurnId = turnId;
    void collector.awaitTurn(turnId).then(
      (turn) => {
        // Only forward completion if this turn was still pending. If `stop()`
        // already settled it as `stopped`, the delete returns false and we drop
        // the late completion so a turn is never settled twice.
        const pending = this.pendingTurns.get(turnId);
        if (pending !== undefined && this.pendingTurns.delete(turnId)) {
          if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
          if (this.activeTurnId === turnId) this.activeTurnId = null;
          let completedTurn: CollectedTurn;
          try {
            completedTurn = pending.codec === null
              ? turn
              : restoreCollectedTurn(turn, pending.codec);
          } catch (err) {
            this.opts.onTurnSettled?.({
              turnId,
              status: 'failed',
              result: { text: null },
              error: asError(err),
            });
            this.resolveIdleWaitersIfIdle();
            return;
          }
          this.opts.onTurnCompleted?.(completedTurn);
          this.resolveIdleWaitersIfIdle();
        }
      },
      (err) => {
        // Same mutual-exclusion guard as the completed path: only settle as
        // `failed` if `stop()` did not already settle it as `stopped`.
        if (this.pendingTurns.delete(turnId)) {
          if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
          if (this.activeTurnId === turnId) this.activeTurnId = null;
          this.opts.onTurnSettled?.({
            turnId,
            status: 'failed',
            result: { text: null },
            error: err instanceof Error ? err : new Error(String(err)),
          });
          this.resolveIdleWaitersIfIdle();
        }
      },
    );
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

  private rememberTextInputId(id: string): boolean {
    if (this.seenTextInputIds.has(id)) return false;
    this.seenTextInputIds.add(id);
    this.seenTextInputIdOrder.push(id);
    while (this.seenTextInputIdOrder.length > this.messageIdDedupeWindow) {
      const evicted = this.seenTextInputIdOrder.shift();
      if (evicted !== undefined) this.seenTextInputIds.delete(evicted);
    }
    return true;
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.isBusy()) return;
    const resolve = this.idleResolve;
    this.idlePromise = null;
    this.idleResolve = null;
    resolve?.();
  }
}

function assertCompatibleCodec(
  active: CodexOutputSchemaCodec | null,
  candidate: CodexOutputSchemaCodec | null,
): void {
  if (active === null && candidate === null) return;
  if (active !== null && candidate !== null) {
    if (active.fingerprint === candidate.fingerprint) return;
    throw unsupportedFeatureError(
      'outputSchema',
      'codex active turn has an incompatible outputSchema',
    );
  }
  throw unsupportedFeatureError(
    'outputSchema',
    active === null
      ? 'codex cannot fold structured output into an active unstructured turn'
      : 'codex cannot fold unstructured input into an active structured turn',
  );
}

function restoreCollectedTurn(
  turn: CollectedTurn,
  codec: CodexOutputSchemaCodec,
): CollectedTurn {
  const text = extractAssistantText(turn);
  if (text === null) {
    throw new Error(
      `codex outputSchema restoration for turn ${turn.turnId}: ` +
        'completed turn has no assistant JSON text',
    );
  }
  const restoredText = codec.restore(text);
  let replaced = false;
  const items = [...turn.items].reverse().map((item) => {
    if (replaced || item.type !== 'agentMessage' || item.text !== text) {
      return item;
    }
    replaced = true;
    return { ...item, text: restoredText };
  }).reverse();
  if (!replaced) {
    throw new Error(
      `codex outputSchema restoration for turn ${turn.turnId}: ` +
        'assistant JSON text was not found',
    );
  }
  return { ...turn, items };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
