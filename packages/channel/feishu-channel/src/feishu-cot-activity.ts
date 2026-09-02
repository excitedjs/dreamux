/**
 * How one live runtime activity lands on a presentation.
 *
 * These are the two steps that are identical for every recipient: the state
 * still has somewhere to present into, and the projected card events either
 * open a card or extend the one already open. Which recipient owns the state —
 * a TeamLeader or the Dispatcher Agent — is decided before this file is
 * reached, and makes no difference once it is.
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
  cotStateHasAnchor,
  rememberOpenToolCall,
  type CotPresentation,
  type CotState,
} from './feishu-cot-state.js';

/** What the adapter lends this step: its card engine, nothing else. */
export interface CotActivitySink {
  readonly channelId: string | undefined;
  readonly openToolCallsMax: number;
  /** Open a card if this recipient has none, then admit the events onto it. */
  acceptOpening(
    key: string,
    state: CotState,
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
  /** Consume the exact turn this Channel recognized from its caller-owned id. */
  takeOwnUserBody(key: string, turnId: string): boolean;
}

/**
 * Whether this recipient can be shown anything at all.
 *
 * The only reason it cannot is that it has no anchor — there is nowhere to put
 * a card, which is a fact about placement and not a filter on the source or
 * kind of what arrived. A card that failed to create or append is not such a
 * reason: the standing anchor outlives it, and the next opening activity tries
 * again there.
 */
function presentable(state: CotState): boolean {
  return cotStateHasAnchor(state);
}

export function acceptToolCallActivity(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: TeammateTurnToolCallEvent,
): void {
  if (!presentable(state)) return;
  if (event.status === 'started') {
    const events = toolCallStartEvents(event, sink.channelId);
    if (events.length === 0) return;
    const accepted = sink.acceptOpening(key, state, events);
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

/**
 * One projected conversation message, whichever side wrote it.
 *
 * The one exception is the exact user turn this Channel just anchored from its
 * already-visible inbound message. That body is consumed once; task, cron,
 * system, future-producer, and other Channel turns still display normally.
 */
export function acceptConversationMessage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: TeammateTurnMessageEvent,
): void {
  if (!presentable(state)) return;
  if (
    event.message_role === 'user' &&
    sink.takeOwnUserBody(key, event.turn_id)
  ) {
    return;
  }
  const events = textMessageEvents({
    sourceId: event.event_id,
    role: event.message_role,
    content: event.content,
  });
  if (events.length === 0) {
    sink.debug(
      sink.logScope(state),
      { activity: event.message_role, reason: 'empty_after_projection' },
      'Feishu COT dropped activity with no safe display content',
    );
    return;
  }
  sink.acceptOpening(key, state, events);
}
