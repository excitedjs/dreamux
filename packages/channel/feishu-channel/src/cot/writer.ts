/**
 * The bounded asynchronous write pipeline for one COT card.
 *
 * One presentation at a time reaches the platform through this owner:
 * admission into its bounded outbox, the create call, paced append batches,
 * and the terminal. It holds no recipient policy — which card exists, which
 * anchor it hangs under, and why it stopped are the adapter's facts; this
 * module only writes the card it is handed.
 *
 * Appends are paced start to start: the next call may start 500ms after the
 * previous call began, whether that call finished quickly or slowly. A call
 * that takes longer than the cadence therefore needs no extra wait, while a
 * fast one leaves its successor to wait out the remainder. The wait happens
 * before a batch is taken, so increments that arrive during the cadence window
 * still join that batch; the stamp is written immediately before the call.
 */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import type {
  FeishuCotClient,
  FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import { appendBatchFits } from './bytes.js';
import { runTerminalEvent } from './card.js';
import { cotLogScope, type CotLogScope } from './diagnostics.js';
import { FeishuCotIo, type FeishuCotIoHandle } from './io.js';
import type {
  CotAdjacentMerge,
  CotPresentation,
  CotState,
} from './recipients.js';

const FEISHU_COT_APPEND_INTERVAL_MS = 500;

interface PacingWait {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly release: () => void;
}

export interface CotCardWriterOptions {
  readonly dispatcherId: string;
  readonly channelId: string | undefined;
  readonly log: DreamuxLogger;
  readonly cotClient: FeishuCotClient | undefined;
  readonly signal: AbortSignal;
  /** Tell the adapter one queued task finished, so it can reap idle state. */
  readonly onSettled: (key: string, state: CotState) => void;
}

export class CotCardWriter {
  private readonly io: FeishuCotIo;
  private readonly pending = new Set<Promise<void>>();
  private readonly pacingWaits = new Set<PacingWait>();

  constructor(private readonly opts: CotCardWriterOptions) {
    this.io = new FeishuCotIo({
      log: opts.log,
      cotClient: opts.cotClient,
      signal: opts.signal,
    });
  }

  /** Admit events into one presentation's bounded outbox. */
  admit(
    state: CotState,
    presentation: CotPresentation,
    events: readonly FeishuCotEventInput[],
    mergeAdjacent?: CotAdjacentMerge,
  ): boolean {
    const admission = presentation.outbox.admit(events, mergeAdjacent);
    if (!admission.accepted && admission.firstDrop) {
      this.opts.log.warn(
        {
          ...this.logScope(state),
          presentation_id: presentation.id,
          phase: presentation.phase,
          buffered_events: admission.bufferedEvents,
          buffered_bytes: admission.bufferedBytes,
        },
        'Feishu COT buffer is full; dropping newest activity',
      );
    }
    return admission.accepted;
  }

  /** Queue one flush of the presentation's outbox, unless one is queued already. */
  schedule(key: string, state: CotState, presentation: CotPresentation): void {
    if (presentation.flushQueued) return;
    presentation.flushQueued = true;
    this.enqueue(key, state, async () => {
      presentation.flushQueued = false;
      await this.runFlush(state, presentation);
    });
  }

  /** Queue the create call for a presentation that has no card yet. */
  open(key: string, state: CotState, presentation: CotPresentation): void {
    this.enqueue(key, state, () => this.runCreate(state, presentation));
  }

  /**
   * Wait for queued writes, bounded by `ms`, then clear any cadence timer the
   * drain window outlived.
   *
   * Releasing a wait does not itself start an append: the flush resumes after
   * this function's own caller is queued, so the session's abort runs before
   * the append call. The regression test for that ordering is the stalled-I/O
   * case in `feishu-cot-reasoning.test.ts`.
   */
  async drain(ms: number): Promise<void> {
    if (this.pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      await Promise.race([
        Promise.allSettled([...this.pending]).then(() => undefined),
        drained,
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    this.releasePacingWaits();
  }

  /** Hold the next append until the presentation's cadence allows it. */
  private async waitForAppendSlot(
    presentation: CotPresentation,
  ): Promise<void> {
    const last = presentation.lastAppendStartedAt;
    if (last === null) return;
    const remaining = last + FEISHU_COT_APPEND_INTERVAL_MS - Date.now();
    if (remaining > 0) await this.wait(remaining);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let entry: PacingWait;
      const release = (): void => {
        this.pacingWaits.delete(entry);
        resolve();
      };
      entry = { timer: setTimeout(release, ms), release };
      this.pacingWaits.add(entry);
    });
  }

  private releasePacingWaits(): void {
    for (const entry of [...this.pacingWaits]) {
      this.pacingWaits.delete(entry);
      clearTimeout(entry.timer);
      entry.release();
    }
  }

  private enqueue(
    key: string,
    state: CotState,
    task: () => Promise<void>,
  ): void {
    state.inFlight += 1;
    const run = async (): Promise<void> => {
      try {
        await task();
      } finally {
        state.inFlight -= 1;
        this.opts.onSettled(key, state);
      }
    };
    const next = state.tail.then(run, run).then(
      () => undefined,
      () => undefined,
    );
    state.tail = next;
    this.pending.add(next);
    void next.finally(() => this.pending.delete(next));
  }

  private async runCreate(
    state: CotState,
    presentation: CotPresentation,
  ): Promise<void> {
    const io = this.openIo(state, presentation);
    if (io === undefined) {
      this.abandon(state, presentation, 'cot_unavailable');
      return;
    }
    try {
      const created = await io.create({
        chatId: presentation.chatId,
        originMessageId: presentation.originMessageId,
        cotHidden: false,
        enableBadge: false,
        updateFeedRank: false,
      });
      presentation.cotId = created.cotId;
      presentation.messageId = created.messageId;
      presentation.phase = 'writing';
      this.opts.log.info(
        { ...this.logScope(state), presentation_id: presentation.id },
        'Feishu COT created',
      );
    } catch {
      this.abandon(state, presentation, 'create_failed');
      return;
    }
    await this.runFlush(state, presentation);
  }

  private async runFlush(
    state: CotState,
    presentation: CotPresentation,
  ): Promise<void> {
    const io = this.openIo(state, presentation);
    const cotId = presentation.cotId;
    const messageId = presentation.messageId;
    if (io === undefined || cotId === null || messageId === null) return;
    while (!presentation.closed) {
      if (
        !presentation.outbox.hasEvents() &&
        presentation.terminalIntent === null
      ) {
        return;
      }
      // Wait first, then take the batch: increments that arrive during the
      // cadence window belong to this batch, not the next one.
      await this.waitForAppendSlot(presentation);
      const batch = presentation.outbox.takeAppendBatch(cotId, messageId);
      if (batch.length === 0 && presentation.outbox.hasEvents()) {
        this.abandon(state, presentation, 'append_batch_too_large');
        await io.completeWithError({ cotId, messageId });
        return;
      }
      let finishing = false;
      if (
        !presentation.outbox.hasEvents() &&
        presentation.terminalIntent !== null
      ) {
        const terminal = runTerminalEvent(
          presentation.id,
          presentation.terminalIntent,
        );
        if (appendBatchFits(cotId, messageId, [...batch, terminal])) {
          batch.push(terminal);
          finishing = true;
        }
      }
      if (batch.length === 0) return;
      presentation.lastAppendStartedAt = Date.now();
      try {
        await io.append({ cotId, messageId, events: batch });
      } catch {
        this.abandon(state, presentation, 'append_failed');
        await io.completeWithError({ cotId, messageId });
        return;
      }
      if (finishing) {
        presentation.closed = true;
        presentation.outbox.clear();
        this.opts.log.info(
          {
            ...this.logScope(state),
            presentation_id: presentation.id,
            terminal: presentation.terminalIntent,
            dropped_events: presentation.outbox.droppedEvents,
          },
          'Feishu COT finished',
        );
        return;
      }
    }
  }

  /**
   * Give up on one card, and only on that card.
   *
   * The presentation is what failed; the recipient's standing anchor is not.
   * Dropping the active reference here is the whole of the recovery: the next
   * opening activity finds no card, sees the anchor still standing, and tries
   * to create one there again.
   */
  private abandon(
    state: CotState,
    presentation: CotPresentation,
    reason: string,
  ): void {
    presentation.closed = true;
    presentation.outbox.clear();
    if (state.active === presentation) state.active = null;
    this.opts.log.warn(
      {
        ...this.logScope(state),
        presentation_id: presentation.id,
        reason,
      },
      'Feishu COT presentation abandoned',
    );
  }

  private logScope(state: CotState | undefined): CotLogScope {
    return cotLogScope({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      recipient: state?.identity,
    });
  }

  private openIo(
    state: CotState,
    presentation: CotPresentation,
  ): FeishuCotIoHandle | undefined {
    return this.io.open({
      logScope: this.logScope(state),
      presentationId: presentation.id,
    });
  }
}
