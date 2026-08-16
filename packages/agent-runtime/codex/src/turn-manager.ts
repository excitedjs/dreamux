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
  AgentRuntimeTextInput,
  RuntimeAdmission,
  RuntimeTurn,
  RuntimeTurnOutcome,
} from '@excitedjs/dreamux-types';

interface ActiveTurnSlot {
  collector: TurnCollector;
  codec: CodexOutputSchemaCodec | null;
  runtimeTurn: RuntimeTurn;
  settle: (outcome: RuntimeTurnOutcome) => boolean;
  turnId: string | null;
  pendingSubmissions: number;
  nextSubmissionIndex: number;
  acceptedTurnIds: Map<number, string>;
  pendingNativeTurnIds: Set<string>;
  completedNativeTurns: Map<string, CollectedTurn>;
  nativeFailures: Map<string, Error>;
  lastSubmissionError: Error | null;
  stopped: boolean;
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
  /** Provider-private terminal observer used by focused diagnostics/tests. */
  onTurnCompleted?: (turn: CollectedTurn) => void;
}

export class TurnManager {
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageIdOrder: string[] = [];
  private readonly seenTextInputIds = new Set<string>();
  private readonly seenTextInputIdOrder: string[] = [];
  private readonly pendingMessageIds = new Map<
    string,
    Promise<RuntimeAdmission>
  >();
  private readonly pendingTextInputIds = new Map<
    string,
    Promise<RuntimeAdmission>
  >();
  private readonly pendingAdmissions = new Set<Promise<RuntimeAdmission>>();
  private stopped = false;
  private activeTurnSlot: ActiveTurnSlot | null = null;
  /**
   * Turn ids submitted to Codex that have not yet reached `turn/completed`. On
   * `stop()` each still-pending turn is settled as `stopped` so a teammate turn
   * interrupted by teardown is not lost.
   */
  private readonly pendingTurns = new Map<string, ActiveTurnSlot>();
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
  enqueue(input: InboundTurnInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.reserveSource(
      input.sourceId,
      this.seenMessageIds,
      this.seenMessageIdOrder,
      this.pendingMessageIds,
      () => this.enqueueUnreserved(input),
    ));
  }

  private async enqueueUnreserved(
    input: InboundTurnInput,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
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
    const submissionIndex = activeTurn.slot.nextSubmissionIndex++;
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
      this.recordTurnStartFailure(activeTurn.slot, error);
      this.log(
        'error',
        `turn/start submission failed for message ${input.sourceId === '' ? '<none>' : input.sourceId}: ${error.message}`,
        error,
      );
      return { status: 'ambiguous', error };
    }
    this.recordTurnStartSuccess(
      activeTurn.slot,
      res.turn.id,
      submissionIndex,
    );
    return { status: 'submitted', turn: activeTurn.slot.runtimeTurn };
  }

  submitTextInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission> {
    return this.trackAdmission(this.reserveSource(
      input.sourceId,
      this.seenTextInputIds,
      this.seenTextInputIdOrder,
      this.pendingTextInputIds,
      () => this.submitTextInputUnreserved(input),
    ));
  }

  private async submitTextInputUnreserved(
    input: AgentRuntimeTextInput,
  ): Promise<RuntimeAdmission> {
    if (this.stopped) return { status: 'stopped' };
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
    const submissionIndex = activeTurn.slot.nextSubmissionIndex++;
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
      this.recordTurnStartFailure(activeTurn.slot, error);
      this.log('error', `text turn/start submission failed: ${error.message}`, error);
      return { status: 'ambiguous', error };
    }
    this.recordTurnStartSuccess(
      activeTurn.slot,
      res.turn.id,
      submissionIndex,
    );
    return { status: 'submitted', turn: activeTurn.slot.runtimeTurn };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const activeSlot = this.activeTurnSlot;
    this.activeTurnSlot = null;
    if (activeSlot !== null) {
      activeSlot.stopped = true;
      activeSlot.collector.dispose();
      activeSlot.codec = null;
      activeSlot.settle({ status: 'stopped' });
    }
    // Any turn still in flight at teardown will never reach `turn/completed`
    // (the WS is closing). Settle each as `stopped` so an interrupted teammate
    // turn is delivered with a status rather than vanishing.
    for (const slot of this.pendingTurns.values()) {
      slot.settle({ status: 'stopped' });
    }
    this.pendingTurns.clear();
    this.resolveIdleWaitersIfIdle();
    while (this.pendingAdmissions.size > 0) {
      await Promise.allSettled([...this.pendingAdmissions]);
    }
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

    const runtimeTurn = createRuntimeTurn();
    const slot: ActiveTurnSlot = {
      collector: subscribeTurnCollection(this.opts.client, threadId, {
        retainAfterTerminal: true,
      }),
      codec,
      runtimeTurn: runtimeTurn.turn,
      settle: runtimeTurn.settle,
      turnId: null,
      pendingSubmissions: 0,
      nextSubmissionIndex: 0,
      acceptedTurnIds: new Map(),
      pendingNativeTurnIds: new Set(),
      completedNativeTurns: new Map(),
      nativeFailures: new Map(),
      lastSubmissionError: null,
      stopped: false,
    };
    this.activeTurnSlot = slot;
    return { slot, primary: true };
  }

  private recordTurnStartSuccess(
    slot: ActiveTurnSlot,
    turnId: string,
    submissionIndex: number,
  ): void {
    slot.pendingSubmissions = Math.max(0, slot.pendingSubmissions - 1);
    if (this.stopped) {
      slot.settle({ status: 'stopped' });
      return;
    }
    slot.acceptedTurnIds.set(submissionIndex, turnId);
    slot.turnId ??= turnId;
    this.trackTurn(turnId, slot.collector, slot);
    this.finalizeSlotIfReady(slot);
  }

  private recordTurnStartFailure(
    slot: ActiveTurnSlot,
    error: Error,
  ): void {
    slot.pendingSubmissions = Math.max(0, slot.pendingSubmissions - 1);
    slot.lastSubmissionError = error;
    this.finalizeSlotIfReady(slot);
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
    if (slot.pendingNativeTurnIds.has(turnId)) return;
    slot.pendingNativeTurnIds.add(turnId);
    this.pendingTurns.set(turnId, slot);
    void collector.awaitTurn(turnId).then(
      (turn) => {
        // Only forward completion if this turn was still pending. If `stop()`
        // already settled it as `stopped`, the delete returns false and we drop
        // the late completion so a turn is never settled twice.
        const pending = this.pendingTurns.get(turnId);
        if (pending !== undefined && this.pendingTurns.delete(turnId)) {
          pending.pendingNativeTurnIds.delete(turnId);
          let completedTurn: CollectedTurn;
          try {
            completedTurn = pending.codec === null
              ? turn
              : restoreCollectedTurn(turn, pending.codec);
          } catch (err) {
            pending.nativeFailures.set(turnId, asError(err));
            this.finalizeSlotIfReady(pending);
            return;
          }
          pending.completedNativeTurns.set(turnId, completedTurn);
          this.finalizeSlotIfReady(pending);
        }
      },
      (err) => {
        // Same mutual-exclusion guard as the completed path: only settle as
        // `failed` if `stop()` did not already settle it as `stopped`.
        if (this.pendingTurns.delete(turnId)) {
          slot.pendingNativeTurnIds.delete(turnId);
          slot.nativeFailures.set(
            turnId,
            err instanceof Error ? err : new Error(String(err)),
          );
          this.finalizeSlotIfReady(slot);
        }
      },
    );
  }

  private finalizeSlotIfReady(slot: ActiveTurnSlot): void {
    if (
      slot.stopped ||
      slot.pendingSubmissions !== 0 ||
      slot.pendingNativeTurnIds.size !== 0
    ) {
      return;
    }
    const accepted = [...slot.acceptedTurnIds.entries()]
      .sort(([left], [right]) => left - right);
    if (accepted.length === 0 && slot.lastSubmissionError === null) return;
    if (this.activeTurnSlot === slot) this.activeTurnSlot = null;
    slot.collector.dispose();
    slot.codec = null;
    const nativeFailure = accepted
      .map(([, turnId]) => slot.nativeFailures.get(turnId))
      .find((error): error is Error => error !== undefined);
    if (nativeFailure !== undefined) {
      slot.settle({ status: 'failed', error: nativeFailure });
    } else if (accepted.length === 0) {
      slot.settle({ status: 'failed', error: slot.lastSubmissionError! });
    } else {
      const finalTurnId = accepted.at(-1)![1];
      const finalTurn = slot.completedNativeTurns.get(finalTurnId);
      if (finalTurn === undefined) {
        throw new Error(
          `codex logical Turn lost terminal output for native turn ${finalTurnId}`,
        );
      }
      this.opts.onTurnCompleted?.(finalTurn);
      slot.settle({
        status: 'completed',
        resultText: extractAssistantText(finalTurn),
        truncated: false,
      });
    }
    this.resolveIdleWaitersIfIdle();
  }

  private reserveSource(
    sourceId: string | undefined,
    committed: Set<string>,
    order: string[],
    pending: Map<string, Promise<RuntimeAdmission>>,
    operation: () => Promise<RuntimeAdmission>,
  ): Promise<RuntimeAdmission> {
    if (sourceId === undefined || sourceId === '') return operation();
    if (committed.has(sourceId)) {
      return Promise.resolve({ status: 'duplicate' });
    }
    const existing = pending.get(sourceId);
    if (existing !== undefined) return existing;
    const task = Promise.resolve()
      .then(operation)
      .catch((error: unknown): RuntimeAdmission => ({
        status: 'ambiguous',
        error: asError(error),
      }));
    pending.set(sourceId, task);
    void task.then((admission) => {
      if (
        admission.status === 'submitted' ||
        admission.status === 'ambiguous'
      ) {
        committed.add(sourceId);
        order.push(sourceId);
        while (order.length > this.messageIdDedupeWindow) {
          const evicted = order.shift();
          if (evicted !== undefined) committed.delete(evicted);
        }
      }
      if (pending.get(sourceId) === task) pending.delete(sourceId);
    });
    return task;
  }

  private trackAdmission(
    admission: Promise<RuntimeAdmission>,
  ): Promise<RuntimeAdmission> {
    this.pendingAdmissions.add(admission);
    void admission.finally(() => {
      this.pendingAdmissions.delete(admission);
    }).catch(() => undefined);
    return admission;
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
      'codex outputSchema restoration failed: completed turn has no ' +
        'assistant JSON text',
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
      'codex outputSchema restoration failed: assistant JSON text was not found',
    );
  }
  return { ...turn, items };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createRuntimeTurn(): {
  turn: RuntimeTurn;
  settle: (outcome: RuntimeTurnOutcome) => boolean;
} {
  let resolve!: (outcome: RuntimeTurnOutcome) => void;
  let settled = false;
  const turn = Object.freeze({
    settled: new Promise<RuntimeTurnOutcome>((value) => {
      resolve = value;
    }),
  });
  return {
    turn,
    settle(outcome): boolean {
      if (settled) return false;
      settled = true;
      resolve(outcome);
      return true;
    },
  };
}
