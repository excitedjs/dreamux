/**
 * How one live runtime activity lands on a presentation.
 *
 * These are the two steps that are identical for every recipient: the turn is
 * still the one this state is presenting, the state still has somewhere to
 * present into, and the projected card events either open a card or extend the
 * one already open. Who owns the state — a TeamLeader's standing card or a
 * single Dispatcher turn — is decided before this file is reached.
 */
import type {
  TeammateTurnMessageEvent,
  TeammateTurnToolCallEvent,
} from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type { CotLogScope } from './feishu-cot-diagnostics.js';
import {
  textMessageEvents,
  toolCallResultEvents,
  toolCallStartEvents,
} from './feishu-cot-events.js';
import {
  cotOpenCallKey,
  cotStateAdmitsTurn,
  cotStateHasAnchor,
  rememberOpenToolCall,
  type CotPresentation,
  type CotState,
} from './feishu-cot-state.js';

/** What the adapter lends this step: its card engine, nothing else. */
export interface CotActivitySink {
  readonly channelId: string | undefined;
  readonly openToolCallsMax: number;
  /** Open a card for this turn if needed, then admit the events onto it. */
  acceptOpening(
    key: string,
    state: CotState,
    turnId: string,
    events: FeishuCotEventInput[],
  ): boolean;
  admitOutbox(
    state: CotState,
    presentation: CotPresentation,
    events: FeishuCotEventInput[],
  ): boolean;
  scheduleFlush(
    key: string,
    state: CotState,
    presentation: CotPresentation,
  ): void;
  debug(scope: CotLogScope, fields: Record<string, string>, what: string): void;
  logScope(state: CotState): CotLogScope;
}

function presentable(state: CotState, turnId: string): boolean {
  return cotStateAdmitsTurn(state, turnId) &&
    cotStateHasAnchor(state) &&
    state.disabledGeneration !== state.generation;
}

export function acceptToolCallActivity(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: TeammateTurnToolCallEvent,
): void {
  if (!presentable(state, event.turn_id)) return;
  if (event.status === 'started') {
    const events = toolCallStartEvents(event, sink.channelId);
    if (events.length === 0) return;
    const accepted = sink.acceptOpening(key, state, event.turn_id, events);
    if (accepted) {
      rememberOpenToolCall(
        state.openCalls,
        state.generation,
        cotOpenCallKey(event.turn_id, event.call_id),
        sink.openToolCallsMax,
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
  const events = toolCallResultEvents(event, sink.channelId);
  state.openCalls.delete(callKey);
  if (events.length === 0) return;
  if (sink.admitOutbox(state, presentation, events) &&
      presentation.phase === 'writing') {
    sink.scheduleFlush(key, state, presentation);
  }
}

export function acceptAssistantMessage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: TeammateTurnMessageEvent,
): void {
  if (!presentable(state, event.turn_id)) return;
  const events = textMessageEvents({
    sourceId: event.event_id,
    role: 'assistant',
    content: event.content,
  });
  if (events.length === 0) {
    sink.debug(
      sink.logScope(state),
      { activity: 'assistant', reason: 'empty_after_projection' },
      'Feishu COT dropped activity with no safe display content',
    );
    return;
  }
  sink.acceptOpening(key, state, event.turn_id, events);
}
