/**
 * How one live runtime activity lands on a presentation.
 *
 * These are the two steps that are identical for every recipient: the state
 * still has somewhere to present into, and the projected card events either
 * open a card or extend the one already open. Which recipient owns the state —
 * a TeamLeader or the Dispatcher Agent — is decided before this file is
 * reached, and makes no difference once it is.
 */
import type { RuntimeActivity } from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import type { CotLogScope } from './feishu-cot-diagnostics.js';

type CotToolCallActivity = Extract<RuntimeActivity, { kind: 'tool.call' }>;
type CotAssistantMessage = Extract<RuntimeActivity, { kind: 'assistant.message' }>;
type CotTokenUsage = Extract<RuntimeActivity, { kind: 'token.usage' }>;
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
        event.id,
        sink.openToolCallsMax,
      );
    }
    return;
  }
  const opened = state.openCalls.get(event.id);
  if (opened === undefined) return;
  if (opened.generation !== state.generation) {
    state.openCalls.delete(event.id);
    return;
  }
  const presentation = state.active;
  if (
    presentation === null ||
    presentation.generation !== state.generation ||
    presentation.closed ||
    presentation.terminalIntent !== null
  ) {
    state.openCalls.delete(event.id);
    return;
  }
  const events = toolCallResultEvents(event);
  state.openCalls.delete(event.id);
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
  acceptDisplayText(sink, key, state, 'assistant', event.id, event.text, 'message');
}

/** A compaction is one line, never the summary the runtime wrote for itself. */
export function acceptContextCompacted(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: Extract<RuntimeActivity, { kind: 'context.compacted' }>,
): void {
  acceptFixedLabel(sink, key, state, event.id, 'COMPACTED SESSION', 'compacted');
}

/** The interrupt line on this recipient's card, in Claude Code's own words. */
export function acceptTurnInterrupted(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: Extract<RuntimeActivity, { kind: 'turn.interrupted' }>,
): void {
  acceptFixedLabel(sink, key, state, event.id, '[Request interrupted by user]', 'interrupted');
}

function acceptFixedLabel(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  eventId: string,
  label: string,
  namespace: string,
): void {
  if (!presentable(state)) return;
  acceptDisplayText(sink, key, state, 'assistant', eventId, label, namespace);
}

/**
 * The turn's cumulative token counters, on this recipient's card. The card
 * shows the same one-line summary runtimes used to emit as a message; the
 * structured counters themselves are not conversation content.
 */
export function acceptTokenUsage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  event: CotTokenUsage,
): void {
  if (!presentable(state)) return;
  acceptDisplayText(sink, key, state, 'assistant', event.id, tokenUsageSummary(event), 'usage');
}

/** Render cumulative counters in the runtime's historical one-line shape. */
export function tokenUsageSummary(event: CotTokenUsage): string {
  const context = event.context;
  let contextUsage = 'n/a';
  if (context !== null) {
    contextUsage = context.windowTokens !== null && context.windowTokens > 0
      ? `${Math.round(context.usedTokens / context.windowTokens * 100)}%`
      : formatTokenCount(context.usedTokens);
  }
  const total = event.inputTokens + event.outputTokens;
  return `Context usage ${contextUsage} | Token usage: total=${formatTokenCount(total)} input=${formatTokenCount(event.inputTokens)} output=${formatTokenCount(event.outputTokens)}`;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  const units = ['k', 'm', 'b'];
  let value = count / 1_000;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit++;
  }
  return `${Math.round(value * 10) / 10}${units[unit]}`;
}

/**
 * One input Core admitted, on this recipient's card.
 *
 * The caller has already decided this is not the body the operator can see in
 * their own Feishu message, and which text stands for it: a person's or an
 * Agent's own words, or the one-line label an automated push-back gets.
 */
export function acceptInputMessage(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  input: { readonly displayId: string; readonly content: string },
): void {
  if (!presentable(state)) return;
  acceptDisplayText(sink, key, state, 'user', input.displayId, input.content, 'input');
}

export function acceptDisplayText(
  sink: CotActivitySink,
  key: string,
  state: CotState,
  role: 'user' | 'assistant',
  displayId: string,
  content: string,
  namespace: string,
): void {
  const events = textMessageEvents({ namespace, sourceId: displayId, role, content });
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
