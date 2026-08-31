/** Session-owned visible-message COT state machine. */
import { randomUUID } from 'node:crypto';

import type {
  DreamuxLogger,
  TeamStateEvent,
  TeammateTurnMessageEvent,
  TeammateTurnSettledEvent,
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
  acceptAssistantMessage,
  acceptToolCallActivity,
  type CotActivitySink,
} from './feishu-cot-activity.js';
import { admitDispatcherTurn } from './feishu-cot-dispatcher-admission.js';
import {
  DispatcherCotStateStore,
  type KeyedDispatcherTurn,
} from './feishu-cot-dispatcher-state.js';
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
  cotLeaderKey,
  cotStateAdmitsTurn,
  cotStateHasAnchor,
  ensureLeaderState,
  prepareVisibleAnchor,
  reapCotState,
  releaseLeaderTurn,
  refreshLeaderNextAnchor,
  setLeaderFallbackAnchorIfAbsent,
  type CotPresentation,
  type CotState,
  LeaderLifecycleFence,
  type LeaderState,
  type VisibleMessageAnchor,
} from './feishu-cot-state.js';

const FEISHU_COT_OPEN_TOOL_CALLS_MAX = 512;
const FEISHU_COT_PENDING_TURNS_MAX = 512;
const FEISHU_COT_CLOSE_DRAIN_MS = 5_000;
const FEISHU_COT_RECEIVED_TEXT = '已收到消息，开始处理。';

/**
 * Turns this Channel did not submit but still presents.
 *
 * `turn_source` is an open published name and Core decides nothing by it, so
 * which provenances a conversation shows is this Channel's own presentation
 * policy. It shows work that continues the conversation on the Team's own
 * initiative — a finished task reported back, and a due cron fire — because
 * those are what the people watching the card are waiting for. Anything else
 * arrived out of band and is not narrated into a chat that did not ask for it.
 */
const FEISHU_COT_CONTINUATION_SOURCES: ReadonlySet<string> = new Set([
  'task-notification',
  'cron',
]);

export interface FeishuCotAdapterOptions {
  readonly dispatcherId: string;
  readonly channelId: string | undefined;
  readonly log: DreamuxLogger;
  readonly cotClient: () => FeishuCotClient | undefined;
}

export class FeishuCotAdapter {
  private readonly leaders = new Map<string, LeaderState>();
  private readonly dispatcher = new DispatcherCotStateStore();
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
      acceptOpening: (key, state, turnId, events) =>
        this.acceptOpeningActivityForState(key, state, turnId, events),
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

  setFallbackAnchorIfAbsent(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    if (this.closed) return;
    const key = cotLeaderKey(teamName, leaderName);
    if (this.leaderFence.blocksAnchor(key, anchor)) return;
    setLeaderFallbackAnchorIfAbsent(this.leaders, teamName, leaderName, anchor);
  }

  refreshNextAnchor(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    if (this.closed) return;
    refreshLeaderNextAnchor(this.leaders, teamName, leaderName, anchor);
  }

  /**
   * The Channel's own inbound message became this exact turn.
   *
   * This is the whole correlation: the session recorded the visible message it
   * was about to submit, Core answered with a `turn_id`, and the submitted
   * event carrying that `turn_id` says who received it. Core carries no
   * origin, no presentation id, and no anchor. Both recipients are presented,
   * because both are recipients: a bound conversation reaches its TeamLeader,
   * an unbound one reaches the Dispatcher Agent.
   */
  onAnchoredSubmission(input: {
    readonly event: TeammateTurnSubmittedEvent;
    readonly anchor: VisibleMessageAnchor;
  }): void {
    if (this.closed) return;
    const anchor = prepareVisibleAnchor(input.anchor);
    if (anchor === null) return;
    const { event } = input;
    if (event.role === 'dispatcher') {
      this.openDispatcherTurn(event.teammate_name, event.turn_id, anchor);
      return;
    }
    if (event.role !== 'team_leader' || event.team_name === null) return;
    const key = cotLeaderKey(event.team_name, event.teammate_name);
    if (this.leaderFence.blocksAnchor(key, anchor)) return;
    const state = ensureLeaderState(
      this.leaders,
      event.team_name,
      event.teammate_name,
    );
    this.advanceAnchor(key, state, anchor, event.turn_id, 'done');
    this.openReceipt(key, state, event.turn_id);
  }

  private openDispatcherTurn(
    agentName: string,
    turnId: string,
    anchor: VisibleMessageAnchor,
  ): void {
    const started = admitDispatcherTurn(
      this.dispatcher,
      { agentName, turnId, anchor },
      this.opts,
    );
    if (started === null) return;
    this.openReceipt(started.key, started.state, turnId);
  }

  /** The one line a card opens with, so the operator sees it was received. */
  private openReceipt(key: string, state: CotState, turnId: string): void {
    this.acceptOpeningActivityForState(
      key,
      state,
      turnId,
      textMessageEvents({
        sourceId: `receipt:${turnId}`,
        role: 'assistant',
        content: FEISHU_COT_RECEIVED_TEXT,
      }),
    );
  }

  /**
   * A turn this Channel did not submit.
   *
   * A completion or a cron fire continues the same conversation the operator
   * is already watching, so it is admitted onto the leader's existing anchor —
   * but only after its own user message arrives, so an empty card is never
   * opened for work that produced nothing to show.
   */
  onTurnSubmitted(event: TeammateTurnSubmittedEvent): void {
    if (this.closed) return;
    if (event.role !== 'team_leader' || event.team_name === null) return;
    if (!FEISHU_COT_CONTINUATION_SOURCES.has(event.turn_source)) return;
    const key = cotLeaderKey(event.team_name, event.teammate_name);
    const state = this.leaders.get(key);
    if (
      state === undefined ||
      !cotStateHasAnchor(state) ||
      state.disabledGeneration === state.generation
    ) {
      return;
    }
    if (state.pendingTurns.size >= FEISHU_COT_PENDING_TURNS_MAX) {
      this.opts.log.warn(
        { ...this.logScope(state), reason: 'pending_turns_full' },
        'Feishu COT pending turn map is full; dropping newest turn',
      );
      return;
    }
    state.pendingTurns.set(event.turn_id, { generation: state.generation });
    state.admittedTurnId = event.turn_id;
  }

  onTurnMessage(event: TeammateTurnMessageEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      // The visible message is the user's own; a Dispatcher card narrates the
      // answer to it, never a copy of it.
      if (event.message_role === 'user') return;
      const found = this.dispatcher.find(event.teammate_name, event.turn_id);
      if (found === null) return;
      acceptAssistantMessage(this.activity, found.key, found.state, event);
      return;
    }
    const state = this.leaderFor(event);
    if (state === null) return;
    if (event.message_role === 'user') {
      const pending = state.state.pendingTurns.get(event.turn_id);
      if (pending === undefined) return;
      state.state.pendingTurns.delete(event.turn_id);
      if (
        pending.generation !== state.state.generation ||
        !cotStateHasAnchor(state.state) ||
        state.state.disabledGeneration === state.state.generation
      ) {
        return;
      }
      const events = textMessageEvents({
        sourceId: event.event_id,
        role: 'user',
        content: event.content,
      });
      if (events.length === 0) return;
      this.acceptOpeningActivityForState(
        state.key,
        state.state,
        event.turn_id,
        events,
      );
      return;
    }
    acceptAssistantMessage(this.activity, state.key, state.state, event);
  }

  onTurnToolCall(event: TeammateTurnToolCallEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      const found = this.dispatcher.find(event.teammate_name, event.turn_id);
      if (found === null) return;
      acceptToolCallActivity(this.activity, found.key, found.state, event);
      return;
    }
    const state = this.leaderFor(event);
    if (state === null) return;
    acceptToolCallActivity(this.activity, state.key, state.state, event);
  }

  onTurnSettled(event: TeammateTurnSettledEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      const settled = this.dispatcher.settle(
        event.teammate_name,
        event.turn_id,
      );
      if (settled === null) return;
      settled.state.openCalls.clear();
      settled.state.pendingTurns.clear();
      this.detach(
        settled.key,
        settled.state,
        event.status === 'completed' ? 'done' : 'interrupted',
      );
      this.reapState(settled.key, settled.state);
      return;
    }
    const found = this.leaderFor(event);
    if (found === null) return;
    releaseLeaderTurn(found.state, event.turn_id);
    if (found.state.active?.turnId !== event.turn_id) return;
    this.detach(
      found.key,
      found.state,
      event.status === 'completed' ? 'done' : 'interrupted',
    );
  }

  onTeamState(event: TeamStateEvent): void {
    if (this.closed) return;
    this.leaderFence.onTeamState(event, this.leaders, (key, state) =>
      this.advanceAnchor(key, state, null, null, 'interrupted'));
  }

  /** This Channel removed or moved a binding away from a Team. */
  onRouteReleased(input: { teamName: string; target: FeishuTarget }): void {
    if (this.closed) return;
    this.leaderFence.onRouteReleased(input, this.leaders, (key, state) =>
      this.advanceAnchor(key, state, null, null, 'interrupted'));
  }

  /** This Channel installed a binding, so the Team may present there again. */
  onRouteClaimed(input: { teamName: string; target: FeishuTarget }): void {
    if (this.closed) return;
    this.leaderFence.onRouteClaimed(input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [key, state] of [...this.leaders]) {
      state.generation += 1;
      state.anchor = null;
      state.nextAnchor = null;
      state.admittedTurnId = null;
      state.disabledGeneration = null;
      state.openCalls.clear();
      state.pendingTurns.clear();
      this.detach(key, state, 'interrupted');
    }
    for (const { key, state } of [...this.dispatcherTurns()]) {
      state.openCalls.clear();
      state.pendingTurns.clear();
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
    this.leaders.clear();
    this.dispatcher.clear();
    this.leaderFence.clear();
  }

  private dispatcherTurns(): readonly KeyedDispatcherTurn[] {
    return [...this.dispatcher.all()];
  }

  private leaderFor(event: {
    role: string;
    team_name: string | null;
    teammate_name: string;
  }): { key: string; state: LeaderState } | null {
    if (event.role !== 'team_leader' || event.team_name === null) return null;
    const key = cotLeaderKey(event.team_name, event.teammate_name);
    const state = this.leaders.get(key);
    return state === undefined ? null : { key, state };
  }

  private advanceAnchor(
    key: string,
    state: LeaderState,
    anchor: VisibleMessageAnchor | null,
    admittedTurnId: string | null,
    reason: FeishuCotRunStatus,
  ): void {
    state.generation += 1;
    this.detach(key, state, reason);
    state.anchor = anchor;
    state.admittedTurnId = admittedTurnId;
    state.nextAnchor = null;
    state.disabledGeneration = null;
    state.pendingTurns.clear();
    if (anchor === null) state.openCalls.clear();
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

  private acceptOpeningActivityForState(
    key: string,
    state: CotState,
    turnId: string,
    events: FeishuCotEventInput[],
  ): boolean {
    if (!cotStateAdmitsTurn(state, turnId)) return false;
    if (state.disabledGeneration === state.generation) {
      return false;
    }
    const presentation = state.active;
    if (presentation === null) {
      const nextAnchor = state.kind === 'leader' ? state.nextAnchor : null;
      const anchor = nextAnchor ?? state.anchor;
      if (anchor === null) return false;
      const created: CotPresentation = {
        id: randomUUID(),
        generation: state.generation,
        turnId,
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
      if (nextAnchor !== null && state.kind === 'leader') {
        state.anchor = nextAnchor;
        state.nextAnchor = null;
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
      this.abandon(state, presentation, 'cot_unavailable', true);
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
      this.abandon(state, presentation, 'create_failed', true);
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
        this.abandon(state, presentation, 'append_batch_too_large', true);
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
        this.abandon(state, presentation, 'append_failed', true);
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

  private abandon(
    state: CotState,
    presentation: CotPresentation,
    reason: string,
    disableGeneration: boolean,
  ): void {
    const isActive = state.active === presentation;
    presentation.closed = true;
    clearCotOutbox(presentation.outbox);
    if (isActive) state.active = null;
    if (
      disableGeneration &&
      isActive &&
      state.generation === presentation.generation
    ) {
      state.disabledGeneration = presentation.generation;
      if (state.kind === 'leader') state.admittedTurnId = null;
    }
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
    reapCotState(this.closed, key, state, this.leaders, this.dispatcher);
  }

  private logScope(state: CotState | undefined): CotLogScope {
    return cotLogScope({
      dispatcherId: this.opts.dispatcherId,
      channelId: this.opts.channelId,
      ...(state?.kind === 'leader' ? { leader: state } : {}),
      ...(state?.kind === 'dispatcher'
        ? { dispatcherAgent: { agentName: state.agentName } }
        : {}),
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
