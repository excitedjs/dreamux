/** Session-owned visible-message COT state machine. */
import { randomUUID } from 'node:crypto';

import type {
  ChannelBindingRouteEvent,
  ChannelTeamStateEvent,
  ChannelTurnMessageEvent,
  ChannelTurnSettledEvent,
  ChannelTurnSubmittedEvent,
  ChannelTurnToolCallEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import type {
  FeishuCotClient,
  FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

import {
  cotLogScope,
  type CotLogScope,
} from './feishu-cot-diagnostics.js';
import { admitDispatcherTurn } from './feishu-cot-dispatcher-admission.js';
import {
  runFinishedEvent,
  runStartedEvent,
  textMessageEvents,
  toolCallResultEvents,
  toolCallStartEvents,
  type FeishuCotRunStatus,
} from './feishu-cot-events.js';
import { FeishuCotIo, type FeishuCotIoHandle } from './feishu-cot-io.js';
import {
  admitCotOutboxEvents,
  appendCotTerminalIfFits,
  clearCotOutbox,
  cotOutboxHasEvents,
  createCotOutbox,
  takeCotAppendBatch,
} from './feishu-cot-outbox.js';
import {
  cotLeaderKey,
  cotOpenCallKey,
  cotStateAdmitsTurn,
  cotStateHasAnchor,
  ensureLeaderState,
  reapCotState,
  releaseLeaderTurn,
  refreshLeaderNextAnchor,
  rememberOpenToolCall,
  setLeaderFallbackAnchorIfAbsent,
  visibleAnchorFromOrigin,
  type CotPresentation,
  type CotState,
  DispatcherCotStateStore,
  LeaderLifecycleFence,
  type LeaderState,
  type VisibleMessageAnchor,
  type VisibleMessageReceipt,
} from './feishu-cot-state.js';

const FEISHU_COT_OPEN_TOOL_CALLS_MAX = 512;
const FEISHU_COT_PENDING_TURNS_MAX = 512;
const FEISHU_COT_CLOSE_DRAIN_MS = 5_000;
const FEISHU_COT_RECEIVED_TEXT = '已收到消息，开始处理。';

export interface FeishuCotAdapterOptions {
  readonly dispatcherId: string;
  readonly channelId: string | undefined;
  readonly log: DreamuxLogger;
  readonly cotClient: () => FeishuCotClient | undefined;
}

export class FeishuCotAdapter {
  private readonly leaders = new Map<string, LeaderState>();
  private readonly leaderFence = new LeaderLifecycleFence();
  private readonly dispatcher = new DispatcherCotStateStore();
  private readonly pending = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly io: FeishuCotIo;
  private closed = false;

  constructor(private readonly opts: FeishuCotAdapterOptions) {
    this.io = new FeishuCotIo({
      log: opts.log,
      cotClient: opts.cotClient,
      signal: this.controller.signal,
    });
  }

  setFallbackAnchorIfAbsent(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageAnchor,
  ): void {
    if (this.closed) return;
    const key = cotLeaderKey(teamName, leaderName);
    if (this.leaderFence.blocksAnchor(key, anchor, this.opts.channelId)) return;
    setLeaderFallbackAnchorIfAbsent(this.leaders, teamName, leaderName, anchor);
  }

  refreshNextAnchor(
    teamName: string,
    leaderName: string,
    anchor: VisibleMessageReceipt,
  ): void {
    if (this.closed) return;
    refreshLeaderNextAnchor(this.leaders, teamName, leaderName, anchor);
  }

  onTurnSubmitted(event: ChannelTurnSubmittedEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      const started = admitDispatcherTurn(this.dispatcher, event, this.opts);
      if (started === null) return;
      this.acceptOpeningActivityForState(
        started.key,
        started.state,
        event.turn_id,
        textMessageEvents({
          sourceId: `receipt:${event.turn_id}`,
          role: 'assistant',
          content: FEISHU_COT_RECEIVED_TEXT,
        }),
      );
      return;
    }
    if (event.role !== 'team_leader') return;
    const origin = event.channel_origin;
    const key = cotLeaderKey(event.team_name, event.agent_name);
    if (origin === undefined) {
      if (event.turn_source !== 'completion' && event.turn_source !== 'scheduled') {
        return;
      }
      const state = this.leaders.get(key);
      if (
        state === undefined ||
        (state.anchor === null && state.nextAnchor === null) ||
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
      return;
    }
    const anchor = visibleAnchorFromOrigin(origin, this.opts.channelId);
    if (
      anchor !== null &&
      this.leaderFence.blocksAnchor(key, anchor, this.opts.channelId)
    ) {
      return;
    }
    const state = ensureLeaderState(this.leaders, event.team_name, event.agent_name);
    if (anchor === null) {
      this.advanceAnchor(key, state, null, null, 'interrupted');
      this.opts.log.debug(
        { ...this.logScope(state), reason: 'origin_not_presentable' },
        'Feishu COT cleared its visible-message anchor',
      );
      return;
    }
    this.advanceAnchor(key, state, anchor, event.turn_id, 'done');
    this.acceptOpeningActivityForState(
      key,
      state,
      event.turn_id,
      textMessageEvents({
        sourceId: `receipt:${event.turn_id}`,
        role: 'assistant',
        content: FEISHU_COT_RECEIVED_TEXT,
      }),
    );
  }

  onTurnMessage(event: ChannelTurnMessageEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      this.onDispatcherTurnMessage(event);
      return;
    }
    if (event.role !== 'team_leader') return;
    const key = cotLeaderKey(event.team_name, event.agent_name);
    const state = this.leaders.get(key);
    if (state === undefined) return;
    if (event.message_role === 'user') {
      const pending = state.pendingTurns.get(event.turn_id);
      if (pending === undefined) return;
      state.pendingTurns.delete(event.turn_id);
      if (
        pending.generation !== state.generation ||
        (state.anchor === null && state.nextAnchor === null) ||
        state.disabledGeneration === state.generation
      ) {
        return;
      }
      const events = textMessageEvents({
        sourceId: event.event_id,
        role: 'user',
        content: event.content,
      });
      if (events.length === 0) return;
      this.acceptOpeningActivityForState(key, state, event.turn_id, events);
      return;
    }
    this.onAssistantMessageForState(key, state, event);
  }

  onTurnToolCall(event: ChannelTurnToolCallEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      const found = this.dispatcher.find(event.agent_name, event.turn_id);
      if (found === null) return;
      this.onTurnToolCallForState(found.key, found.state, event);
      return;
    }
    if (event.role !== 'team_leader') return;
    const key = cotLeaderKey(event.team_name, event.agent_name);
    const state = this.leaders.get(key);
    if (state === undefined) return;
    this.onTurnToolCallForState(key, state, event);
  }

  private onTurnToolCallForState(
    key: string,
    state: CotState,
    event: ChannelTurnToolCallEvent,
  ): void {
    if (!cotStateAdmitsTurn(state, event.turn_id)) return;
    if (!cotStateHasAnchor(state) ||
        state.disabledGeneration === state.generation) return;
    if (event.status === 'started') {
      const events = toolCallStartEvents(event, this.opts.channelId);
      if (events.length === 0) return;
      const accepted = this.acceptOpeningActivityForState(
        key,
        state,
        event.turn_id,
        events,
      );
      if (accepted) {
        rememberOpenToolCall(
          state.openCalls,
          state.generation,
          cotOpenCallKey(event.turn_id, event.call_id),
          FEISHU_COT_OPEN_TOOL_CALLS_MAX,
        );
      }
      return;
    }
    const callKey = cotOpenCallKey(event.turn_id, event.call_id);
    const opened = state.openCalls.get(callKey);
    if (opened === undefined) return;
    if (opened.generation !== state.generation) {
      state.openCalls.delete(callKey);
      return;
    }
    const presentation = state.active;
    if (
      presentation === null ||
      presentation.generation !== state.generation ||
      presentation.closed ||
      presentation.terminalIntent !== null
    ) {
      state.openCalls.delete(callKey);
      return;
    }
    const events = toolCallResultEvents(event, this.opts.channelId);
    state.openCalls.delete(callKey);
    if (events.length === 0) return;
    if (this.admitOutbox(state, presentation, events) &&
        presentation.phase === 'writing') {
      this.scheduleFlush(key, state, presentation);
    }
  }

  onTurnSettled(event: ChannelTurnSettledEvent): void {
    if (this.closed) return;
    if (event.role === 'dispatcher') {
      const found = this.dispatcher.settle(event.agent_name, event.turn_id);
      if (found === null) return;
      found.state.openCalls.clear();
      found.state.pendingTurns.clear();
      this.detach(
        found.key,
        found.state,
        event.status === 'completed' ? 'done' : 'interrupted',
      );
      this.reapState(found.key, found.state);
      return;
    }
    if (event.role !== 'team_leader') return;
    const key = cotLeaderKey(event.team_name, event.agent_name);
    const state = this.leaders.get(key);
    if (state === undefined) return;
    releaseLeaderTurn(state, event.turn_id);
    if (state.active?.turnId !== event.turn_id) return;
    this.detach(
      key,
      state,
      event.status === 'completed' ? 'done' : 'interrupted',
    );
  }

  private onDispatcherTurnMessage(
    event: ChannelTurnMessageEvent & { readonly role: 'dispatcher' },
  ): void {
    if (event.message_role === 'user') return;
    const found = this.dispatcher.find(event.agent_name, event.turn_id);
    if (found === null) return;
    this.onAssistantMessageForState(found.key, found.state, event);
  }

  private onAssistantMessageForState(
    key: string,
    state: CotState,
    event: ChannelTurnMessageEvent,
  ): void {
    if (!cotStateAdmitsTurn(state, event.turn_id)) return;
    if (!cotStateHasAnchor(state) ||
        state.disabledGeneration === state.generation) return;
    const events = textMessageEvents({
      sourceId: event.event_id,
      role: 'assistant',
      content: event.content,
    });
    if (events.length === 0) {
      this.opts.log.debug(
        {
          ...this.logScope(state),
          activity: 'assistant',
          reason: 'empty_after_projection',
        },
        'Feishu COT dropped activity with no safe display content',
      );
      return;
    }
    this.acceptOpeningActivityForState(key, state, event.turn_id, events);
  }

  onTeamState(event: ChannelTeamStateEvent): void {
    if (this.closed) return;
    this.leaderFence.onTeamState(event, this.leaders, (key, state) =>
      this.advanceAnchor(key, state, null, null, 'interrupted'));
  }

  onBindingRoute(event: ChannelBindingRouteEvent): void {
    if (this.closed) return;
    this.leaderFence.onBindingRoute(
      event,
      this.leaders,
      this.opts.channelId,
      (key, state) => this.advanceAnchor(
        key,
        state,
        null,
        null,
        'interrupted',
      ),
    );
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
    for (const { key, state } of this.dispatcher.all()) {
      state.generation += 1;
      state.anchor = null;
      state.disabledGeneration = null;
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
    this.leaderFence.clear();
    this.dispatcher.clear();
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
      if (state.kind === 'leader' && nextAnchor !== null) {
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
