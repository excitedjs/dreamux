/**
 * How one live runtime activity lands on a presentation.
 *
 * These are the two steps that are identical for every recipient: the state
 * still has somewhere to present into, and the projected card events either
 * open a card or extend the one already open. Which recipient owns the state —
 * a TeamLeader or the Dispatcher Agent — is decided before this file is
 * reached, and makes no difference once it is.
 */
import type { TeammateActivity } from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type { CotLogScope } from './feishu-cot-diagnostics.js';

type CotToolCallActivity = Extract<TeammateActivity, { kind: 'tool.call' }>;
type CotAssistantMessage = Extract<TeammateActivity, { kind: 'assistant.message' }>;
import {
  textMessageEvents,
  toolCallResultEvents,
  toolCallStartEvents,
} from './feishu-cot-events.js';
import {
  cotStateHasAnchor,
  rememberOpenToolCall,
  type CotPresentation,
  type CotState,
} from './feishu-cot-state.js';

/** What the adapter lends this step: its card engine, nothing else. */
export interface CotActivitySink {
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
  event: CotToolCallActivity,
): void {
  if (!presentable(state)) return;
  if (event.status === 'started') {
    const events = toolCallStartEvents(event);
    if (events.length === 0) return;
    const accepted = sink.acceptOpening(key, state, events);
    if (accepted) {
      // Keyed on the runtime's own call id: a provider folds any number of
      // submissions into one native turn, so there is no turn half to add.
      rememberOpenToolCall(
        state.openCalls,
        state.generation,
        event.call_id,
        sink.openToolCallsMax,
      );
    }
    return;
  }
  const opened = state.openCalls.get(event.call_id);
  if (opened === undefined) return;
  if (opened.generation !== state.generation) {
    state.openCalls.delete(event.call_id);
    return;
  }
  const presentation = state.active;
  if (
    presentation === null ||
    presentation.generation !== state.generation ||
    presentation.closed ||
    presentation.terminalIntent !== null
  ) {
    state.openCalls.delete(event.call_id);
    return;
  }
  const events = toolCallResultEvents(event);
  state.openCalls.delete(event.call_id);
  if (events.length === 0) return;
  if (sink.admitOutbox(state, presentation, events) &&
      presentation.phase === 'writing') {
    sink.scheduleFlush(key, state, presentation);
  }
}

/** One thing the assistant said, on this recipient's card. */
export function acceptAssistantMessage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: CotAssistantMessage,
): void {
  if (!presentable(state)) return;
  acceptDisplayText(sink, key, state, 'assistant', event.event_id, event.content);
}

/**
 * One body Core admitted as input, on this recipient's card.
 *
 * The caller has already decided this is not the body the operator can see in
 * their own Feishu message; everything else — cron fires, task push-backs,
 * restart notices, another Channel's message — displays normally.
 */
export function acceptInputMessage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  input: { readonly displayId: string; readonly content: string },
): void {
  if (!presentable(state)) return;
  acceptDisplayText(sink, key, state, 'user', input.displayId, input.content);
}

function acceptDisplayText(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  role: 'user' | 'assistant',
  displayId: string,
  content: string,
): void {
  const events = textMessageEvents({ sourceId: displayId, role, content });
  if (events.length === 0) {
    sink.debug(
      sink.logScope(state),
      { activity: role, reason: 'empty_after_projection' },
      'Feishu COT dropped activity with no safe display content',
    );
    return;
  }
  sink.acceptOpening(key, state, events);
}
