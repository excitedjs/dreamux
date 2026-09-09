import { turnFailureMessage } from './runtime-session.js';
import { toolDisplay } from './tool-display.js';
import type {
  ClaudeActivityLine,
  ClaudeProtocolEvent,
} from './types.js';
import type {
  JsonValue,
  RuntimeActivity,
  AgentRuntimeActivitySink,
} from '@excitedjs/dreamux-types';

/** Resident activity is independent of request admission and settlement. */
export interface NativeActivityState {
  activitySequence: number;
  tools: Map<string, { name: string; arguments: JsonValue | null }>;
}

export interface ProtocolEventContext {
  activity: NativeActivityState;
  activitySink: AgentRuntimeActivitySink;
}

/**
 * Report a native turn's end on the display line.
 *
 * `status` and `reason` are claude's own terminal fact and nothing else: a
 * `result` completed or failed with its errors, a run that died, a teardown
 * that interrupted. What the push-back line then makes of it (a result text it
 * cannot extract, a command it cannot attribute, a submission already settled)
 * is push-back's own outcome and never colours the card.
 *
 * The runtime keeps no display state: it does not know, and does not ask,
 * whether a native turn is open before reporting an end. Whether the end is
 * *shown* is not this layer's decision. A card belongs to no turn
 * (`feishu-cot-conversation-cards` requirement, rule 1), and a native end
 * "closes an existing open card but never opens a new one; when no card is
 * open, Feishu ignores it" (rule 8). This layer pushes; the Channel decides.
 */
export function endNativeTurn(
  status: 'completed' | 'failed' | 'interrupted',
  reason: string | null,
  sink: AgentRuntimeActivitySink,
): void {
  emitActivity({ kind: 'turn.ended', occurredAt: Date.now(), status, reason }, sink);
}

/** The sink is Core's and never throws (`AgentRuntimeActivitySink`). */
function emitActivity(activity: RuntimeActivity, sink: AgentRuntimeActivitySink): void {
  sink(Object.freeze(activity));
}

export function handleProtocolEvent(
  event: ClaudeProtocolEvent,
  context: ProtocolEventContext,
): void {
  if (event.kind === 'command_lifecycle') return;
  if (event.kind === 'result' || event.kind === 'interrupted') {
    const interrupted = event.kind === 'interrupted';
    if (interrupted) emitActivity(interruptedActivity(context.activity), context.activitySink);
    const usage = event.outcome?.tokenUsage;
    if (usage !== undefined) {
      const contextTokens = event.outcome?.contextTokens;
      const contextUsage = contextTokens == null ? 'n/a' : formatTokenCount(contextTokens);
      emitActivity({
        kind: 'assistant.message',
        occurredAt: Date.now(),
        id: `stream-${context.activity.activitySequence++}:usage`,
        text: `Context usage ${contextUsage} | Token usage: total=${formatTokenCount(usage.inputTokens + usage.outputTokens)} input=${formatTokenCount(usage.inputTokens)} output=${formatTokenCount(usage.outputTokens)}`,
      }, context.activitySink);
    }
    // `result` is claude's native terminal, and the display line ends on it:
    // attribution, completion and request settlement are
    // push-back's work on the same fact, and none of them may change the end,
    // delay it, or withhold it.
    endNativeTurn(
      interrupted ? 'interrupted' : event.outcome.isError ? 'failed' : 'completed',
      !interrupted && event.outcome.isError ? turnFailureMessage(event.outcome) : null,
      context.activitySink,
    );
    context.activity.tools.clear();
    return;
  }
  emitStreamActivity(event.line, context);
}

/**
 * Put what claude said and did on this agent's activity stream.
 *
 * Activity belongs to the resident agent, including native background work
 * that answers no explicit request. It needs no submission lookup.
 *
 * The envelope decides what a block means, not the block's own type. An
 * `assistant` envelope carries the model's words and its tool calls. A `user`
 * envelope carries what those tools returned — and, as plain text blocks, the
 * context the CLI injected into its own conversation: the body of a skill it
 * just loaded, hook output, reminders. None of that text is the agent's, and
 * none of it is the operator's (stdin is never echoed back), so it is not
 * displayed at all: every `user` envelope is hidden.
 */
function emitStreamActivity(
  line: ClaudeActivityLine,
  { activity: activityState, activitySink }: ProtocolEventContext,
): void {
  if (line.kind === 'compact_boundary') {
    emitActivity(compactedActivity(activityState), activitySink);
    return;
  }
  const message = recordValue(line.raw['message']) ?? line.raw;
  const messageId = stringValue(message['id']) ?? `stream-${activityState.activitySequence++}`;
  const content = Array.isArray(message['content']) ? message['content'] : [];
  for (const [blockIndex, candidate] of content.entries()) {
    const block = recordValue(candidate);
    if (block === null) continue;
    const activity = line.kind === 'assistant'
      ? assistantBlockActivity(activityState, messageId, blockIndex, block)
      : toolResultActivity(activityState, messageId, block);
    if (activity === null) continue;
    emitActivity(activity, activitySink);
  }
}

// The compaction summary is too long for a card; display only that compaction happened.
const COMPACTED_SESSION_MESSAGE = 'COMPACTED SESSION';

function compactedActivity(activityState: NativeActivityState): RuntimeActivity {
  return {
    kind: 'assistant.message',
    occurredAt: Date.now(),
    id: `stream-${activityState.activitySequence++}:compacted`,
    text: COMPACTED_SESSION_MESSAGE,
  };
}

/**
 * The one line the card shows for an interrupted turn, in Claude Code's own
 * words. The CLI writes this sentence itself, but as a text block on a `user`
 * envelope, and those blocks are not displayed (see the `user` note above) —
 * an interrupted tool call otherwise leaves only a red tool row saying claude
 * was told not to proceed. So the provider pushes the marker as an assistant
 * message, the same shape used for `COMPACTED SESSION`: no new activity kind,
 * one more assistant message carrying the line. This line reaching the COT is
 * what an interrupt owes the card; the card's terminal status matters less.
 */
const INTERRUPTED_MESSAGE = '[Request interrupted by user]';

function interruptedActivity(activityState: NativeActivityState): RuntimeActivity {
  return {
    kind: 'assistant.message',
    occurredAt: Date.now(),
    id: `stream-${activityState.activitySequence++}:interrupted`,
    text: INTERRUPTED_MESSAGE,
  };
}

/** What the model said, or a tool it called. */
function assistantBlockActivity(
  activityState: NativeActivityState,
  messageId: string,
  blockIndex: number,
  block: Record<string, unknown>,
): RuntimeActivity | null {
  if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
    return {
      kind: 'assistant.message',
      occurredAt: Date.now(),
      id: `${messageId}:text:${blockIndex}`,
      text: block['text'],
    };
  }
  if (block['type'] !== 'tool_use') return null;
  const callId = stringValue(block['id']);
  const name = stringValue(block['name']);
  if (callId === null || callId === '' || name === null) return null;
  const args = toJsonValue(block['input']);
  activityState.tools.set(callId, { name, arguments: args });
  return {
    kind: 'tool.call',
    occurredAt: Date.now(),
    id: `${messageId}:${callId}:started`,
    callId,
    toolName: name,
    ...toolDisplay(name, args),
    status: 'started',
    arguments: args,
    result: null,
    error: null,
  };
}

/** What a tool returned, correlated to the call the model made. */
function toolResultActivity(
  activityState: NativeActivityState,
  messageId: string,
  block: Record<string, unknown>,
): RuntimeActivity | null {
  if (block['type'] !== 'tool_result') return null;
  const callId = stringValue(block['tool_use_id']);
  if (callId === null || callId === '') return null;
  const known = activityState.tools.get(callId);
  const failed = block['is_error'] === true;
  const result = normalizeTextBlocks(block['content']);
  return {
    kind: 'tool.call',
    occurredAt: Date.now(),
    id: `${messageId}:${callId}:result`,
    callId,
    toolName: known?.name ?? 'tool',
    ...toolDisplay(known?.name, known?.arguments ?? null),
    status: failed ? 'failed' : 'completed',
    arguments: known?.arguments ?? null,
    result,
    error: failed ? displayError(result) : null,
  };
}

function displayError(value: JsonValue | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeTextBlocks(value: unknown): JsonValue | null {
  if (!Array.isArray(value)) return toJsonValue(value);
  if (value.length === 0) return null;
  const texts = value.map((entry) => {
    const record = recordValue(entry);
    return record?.['type'] === 'text' && typeof record['text'] === 'string'
      ? record['text']
      : null;
  });
  return texts.every((text): text is string => text !== null)
    ? texts.join('\n')
    : toJsonValue(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
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
