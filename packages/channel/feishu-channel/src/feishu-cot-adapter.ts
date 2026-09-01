/**
 * Session-owned visible-message COT state machine.
 *
 * One recipient owns one standing anchor and at most one open card. Three
 * facts move it, and nothing else does:
 *
 * - A Channel user message becomes that recipient's anchor once Core reports
 *   that it was admitted, and if a card is already open it is closed and its
 *   successor opened under the new message at once — never deferred to a
 *   settlement or a native turn end. A rejected, failed, or ambiguous admission
 *   changes nothing.
 * - Everything Core projects for that recipient is shown, once it has an
 *   anchor: assistants, tools, and every input whatever its source name. The
 *   only hidden body is the Feishu message already visible at the anchor, and
 *   only when the mark exists before the body arrives.
 * - The runtime's one native turn end closes the card. Logical settlement
 *   (`teammate.turn.settled`) is a per-submission lifecycle fact and closes
 *   nothing, because a provider folds any number of submissions into one turn.
 *
 * The standing anchor outlives every card. A create or append that fails
 * abandons that one presentation and nothing else: the anchor stays, and the
 * next opening activity tries to open a card there again.
 */
import { randomUUID } from 'node:crypto';

import type {
  DreamuxLogger,
  TeamStateEvent,
  TeammateNativeTurnEndedEvent,
  TeammateTurnMessageEvent,
  TeammateTurnSubmittedEvent,
  TeammateTurnToolCallEvent,
} from '@excitedjs/dreamux-types';
import type {
  FeishuCotClient,
  FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import {
  cotLogScope,
  type CotLogScope,
} from './feishu-cot-diagnostics.js';
import {
  runFinishedEvent,
  runStartedEvent,
  textMessageEvents,
  type FeishuCotRunStatus,
} from './feishu-cot-events.js';
import {
  acceptConversationMessage,
  acceptToolCallActivity,
  type CotActivitySink,
} from './feishu-cot-activity.js';
import { FeishuCotIo, type FeishuCotIoHandle } from './feishu-cot-io.js';
import {
  admitCotOutboxEvents,
  appendCotTerminalIfFits,
  clearCotOutbox,
  cotOutboxHasEvents,
  createCotOutbox,
  takeCotAppendBatch,
} from './feishu-cot-outbox.js';
import type { FeishuTarget } from './routing/target.js';
import {
  cotRecipientKey,
  cotRecipientOf,
  ensureCotState,
  prepareVisibleAnchor,
  reapCotState,
  suppressChannelBody,
  LeaderLifecycleFence,
  type CotPresentation,
  type CotRecipientIdentity,
  type CotState,
  type VisibleMessageAnchor,
} from './feishu-cot-state.js';

const FEISHU_COT_OPEN_TOOL_CALLS_MAX = 512;
const FEISHU_COT_CLOSE_DRAIN_MS = 5_000;
const FEISHU_COT_RECEIVED_TEXT = '已收到消息，开始处理。';

export interface FeishuCotAdapterOptions {
  readonly dispatcherId: string;
  readonly channelId: string | undefined;
  readonly log: DreamuxLogger;
  readonly cotClient: () => FeishuCotClient | undefined;
}

export class FeishuCotAdapter {
  private readonly states = new Map<string, CotState>();
  private readonly leaderFence = new LeaderLifecycleFence();
  private readonly pending = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly io: FeishuCotIo;
  private readonly activity: CotActivitySink;
  private closed = false;

  constructor(private readonly opts: FeishuCotAdapterOptions) {
    this.io = new FeishuCotIo({
      log: opts.log,
      cotClient: opts.cotClient,
      signal: this.controller.signal,
    });
    this.activity = {
      channelId: opts.channelId,
      openToolCallsMax: FEISHU_COT_OPEN_TOOL_CALLS_MAX,
      acceptOpening: (key, state, events) =>
        this.acceptOpeningActivityForState(key, state, events),
      admitOutbox: (state, presentation, events) =>
        this.admitOutbox(state, presentation, events),
      scheduleFlush: (key, state, presentation) =>
        this.scheduleFlush(key, state, presentation),
      debug: (scope, fields, what) => {
        this.opts.log.debug({ ...scope, ...fields }, what);
      },
      logScope: (state) => this.logScope(state),
    };
  }

  /**
   * A Team was just bound, and its bind card is on screen.
   *
   * It is the one anchor a recipient may acquire without a Channel user
   * message, and only while it has none: a leader with no conversation yet has
   * nowhere else to present, and the card announcing the binding is a visible
   * message in the chat it will answer. A recipient that already has a standing
   * anchor keeps it, so this can only initialize and never replace. The
   * Dispatcher has no equivalent: its first anchor is always a user message.
   */
  setFallbackAnchorIfAbsent(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    if (this.closed) return;
    const identity = leaderIdentity(teamName, leaderName);
    if (identity === null) return;
    const prepared = prepareVisibleAnchor(anchor);
    if (prepared === null) return;
    const key = cotRecipientKey(identity);
    if (this.leaderFence.blocksAnchor(key, prepared)) return;
    const state = ensureCotState(this.states, identity);
    if (state.anchor !== null) return;
    state.anchor = prepared;
  }

  /**
   * The Channel's own inbound message was admitted as this exact turn.
   *
   * This is the whole correlation: the session recorded the visible message it
   * was about to submit, Core answered with a `turn_id`, and the submitted
   * event carrying that `turn_id` says who received it. Core carries no origin,
   * no presentation id, and no anchor. Only a proven admission reaches here, so
   * a rejected, failed, or ambiguous attempt moves no anchor and opens no card.
   *
   * The recipient is read from the event, which is also what makes the narrow
   * body suppression exact: this Channel knows the message it just made visible
   * and the turn it became, including when its own routing deliberately fell
   * back to the Dispatcher. The mark is best effort — Core usually publishes
   * that body before the admitting call returns, and this Channel neither
   * buffers nor reorders facts to catch it.
   */
  onAnchoredSubmission(input: {
    readonly event: TeammateTurnSubmittedEvent;
    readonly anchor: VisibleMessageAnchor;
  }): void {
    if (this.closed) return;
    const anchor = prepareVisibleAnchor(input.anchor);
    if (anchor === null) return;
    const identity = cotRecipientOf(input.event);
    if (identity === null) return;
    const key = cotRecipientKey(identity);
    if (
      identity.kind === 'leader' &&
      this.leaderFence.blocksAnchor(key, anchor)
    ) {
      return;
    }
    const state = ensureCotState(this.states, identity);
    // The body belongs to the anchor this call is establishing, so the card
    // must not repeat it. Best effort: Core normally publishes it before the
    // submit that produced this call returned, and nothing is buffered or
    // reordered to catch that.
    suppressChannelBody(state, input.event.turn_id);
    this.advanceAnchor(key, state, anchor, 'done');
    this.openReceipt(key, state);
  }

  /** The one line a card opens with, so the operator sees it was received. */
  private openReceipt(key: string, state: CotState): void {
    this.acceptOpeningActivityForState(
      key,
      state,
      textMessageEvents({
        sourceId: `receipt:${randomUUID()}`,
        role: 'assistant',
        content: FEISHU_COT_RECEIVED_TEXT,
      }),
    );
  }

  onTurnMessage(event: TeammateTurnMessageEvent): void {
    const found = this.stateFor(event);
    if (found === null) return;
    acceptConversationMessage(this.activity, found.key, found.state, event);
  }

  onTurnToolCall(event: TeammateTurnToolCallEvent): void {
    const found = this.stateFor(event);
    if (found === null) return;
    acceptToolCallActivity(this.activity, found.key, found.state, event);
  }

  /**
   * The runtime stopped producing, so the card it was writing is finished.
   *
   * This is the only terminal a card has. It names no logical turn — a provider
   * folded whatever it folded — so it closes whatever this recipient currently
   * has open, which is exactly the one card the operator is watching.
   *
   * It is a terminal and never an opening activity: with no card open there is
   * nothing to finish, so the fact is ignored rather than turned into a card
   * that exists only to be closed. That also makes a repeated end harmless.
   */
  onNativeTurnEnded(event: TeammateNativeTurnEndedEvent): void {
    const found = this.stateFor(event);
    if (found === null) return;
    if (found.state.active === null) return;
    found.state.openCalls.clear();
    this.detach(
      found.key,
      found.state,
      event.status === 'completed' ? 'done' : 'interrupted',
    );
    this.reapState(found.key, found.state);
  }

  onTeamState(event: TeamStateEvent): void {
    if (this.closed) return;
    this.leaderFence.onTeamState(event, this.states, (key, state) =>
      this.advanceAnchor(key, state, null, 'interrupted'));
  }

  /** This Channel removed or moved a binding away from a Team. */
  onRouteReleased(input: { teamName: string; target: FeishuTarget }): void {
    if (this.closed) return;
    this.leaderFence.onRouteReleased(input, this.states, (key, state) =>
      this.advanceAnchor(key, state, null, 'interrupted'));
  }

  /** This Channel installed a binding, so the Team may present there again. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    if (this.closed) return;
    this.leaderFence.onRouteClaimed(input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [key, state] of [...this.states]) {
      state.generation += 1;
      state.anchor = null;
      state.openCalls.clear();
      state.suppressedUserTurns.clear();
      this.detach(key, state, 'interrupted');
    }
    if (this.pending.size > 0) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, FEISHU_COT_CLOSE_DRAIN_MS);
      });
      await Promise.race([
        Promise.allSettled([...this.pending]).then(() => undefined),
        drained,
      ]);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
    this.controller.abort();
    this.states.clear();
    this.leaderFence.clear();
  }

  private stateFor(event: {
    role: string;
    team_name: string | null;
    teammate_name: string;
  }): { key: string; state: CotState } | null {
    if (this.closed) return null;
    const identity = cotRecipientOf(event);
    if (identity === null) return null;
    const key = cotRecipientKey(identity);
    const state = this.states.get(key);
    return state === undefined ? null : { key, state };
  }

  /**
   * Replace this recipient's anchor, closing whatever it currently shows.
   *
   * Whoever calls this has already earned the transition — an admission Core
   * confirmed, or a lifecycle fence — so there is nothing left to decide here.
   * A native turn still running keeps producing into the successor card,
   * because the operator's newest message is where they are now looking; a
   * `null` anchor is the fence retiring the recipient's presentation entirely.
   */
  private advanceAnchor(
    key: string,
    state: CotState,
    anchor: VisibleMessageAnchor | null,
    reason: FeishuCotRunStatus,
  ): void {
    state.generation += 1;
    this.detach(key, state, reason);
    state.anchor = anchor;
    if (anchor === null) {
      state.openCalls.clear();
      state.suppressedUserTurns.clear();
    }
    this.reapState(key, state);
  }

  private detach(
    key: string,
    state: CotState,
    reason: FeishuCotRunStatus,
  ): void {
    const presentation = state.active;
    state.active = null;
    if (
      presentation === null ||
      presentation.terminalIntent !== null ||
      presentation.closed
    ) {
      return;
    }
    presentation.terminalIntent = reason;
    if (presentation.phase === 'writing') {
      this.scheduleFlush(key, state, presentation);
    }
  }

  /**
   * Put displayable events on this recipient's card, opening one if needed.
   *
   * Opening is retried freely: the anchor is standing state and a card that
   * failed is gone, so the next activity simply tries again there. Repeated
   * failure costs one create attempt per activity, which is the price of not
   * letting a transient platform error silence a live conversation.
   */
  private acceptOpeningActivityForState(
    key: string,
    state: CotState,
    events: FeishuCotEventInput[],
  ): boolean {
    const presentation = state.active;
    if (presentation === null) {
      const anchor = state.anchor;
      if (anchor === null) return false;
      const created: CotPresentation = {
        id: randomUUID(),
        generation: state.generation,
        chatId: anchor.chatId,
        originMessageId: anchor.messageId,
        phase: 'creating',
        cotId: null,
        messageId: null,
        outbox: createCotOutbox(),
        terminalIntent: null,
        flushQueued: false,
        closed: false,
      };
      if (!this.admitOutbox(
        state,
        created,
        [runStartedEvent(created.id), ...events],
      )) {
        return false;
      }
      state.active = created;
      this.enqueue(key, state, () => this.runCreate(state, created));
      return true;
    }
    if (
      presentation.closed ||
      presentation.terminalIntent !== null
    ) {
      return false;
    }
    const accepted = this.admitOutbox(state, presentation, events);
    if (accepted && presentation.phase === 'writing') {
      this.scheduleFlush(key, state, presentation);
    }
    return accepted;
  }

  private admitOutbox(
    state: CotState,
    presentation: CotPresentation,
    events: readonly FeishuCotEventInput[],
  ): boolean {
    const admission = admitCotOutboxEvents(presentation.outbox, events);
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

  private scheduleFlush(
    key: string,
    state: CotState,
    presentation: CotPresentation,
  ): void {
    if (presentation.flushQueued) return;
    presentation.flushQueued = true;
    this.enqueue(key, state, async () => {
      presentation.flushQueued = false;
      await this.runFlush(state, presentation);
    });
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
        this.reapState(key, state);
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
      const batch = takeCotAppendBatch(presentation.outbox, cotId, messageId);
      if (batch.length === 0 && cotOutboxHasEvents(presentation.outbox)) {
        this.abandon(state, presentation, 'append_batch_too_large');
        await io.completeWithError({ cotId, messageId });
        return;
      }
      let finishing = false;
      if (!cotOutboxHasEvents(presentation.outbox) &&
          presentation.terminalIntent !== null) {
        const terminal = runFinishedEvent(
          presentation.id,
          presentation.terminalIntent,
        );
        finishing = appendCotTerminalIfFits(
          batch,
          terminal,
          cotId,
          messageId,
        );
      }
      if (batch.length === 0) return;
      try {
        await io.append({ cotId, messageId, events: batch });
      } catch {
        this.abandon(state, presentation, 'append_failed');
        await io.completeWithError({ cotId, messageId });
        return;
      }
      if (finishing) {
        presentation.closed = true;
        clearCotOutbox(presentation.outbox);
        this.opts.log.info(
          {
            ...this.logScope(state),
            presentation_id: presentation.id,
            status: presentation.terminalIntent,
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
    clearCotOutbox(presentation.outbox);
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

  private reapState(key: string, state: CotState): void {
    reapCotState(this.closed, key, state, this.states);
  }

  private logScope(state: CotState | undefined): CotLogScope {
    return cotLogScope({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      ...(state !== undefined ? { recipient: state.identity } : {}),
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

function leaderIdentity(
  teamName: string,
  leaderName: string,
): CotRecipientIdentity | null {
  return typeof teamName === 'string' && teamName !== '' &&
    typeof leaderName === 'string' && leaderName !== ''
    ? { kind: 'leader', teamName, leaderName }
    : null;
}
