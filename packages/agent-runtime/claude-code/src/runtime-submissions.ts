import { resultTextFromTurnOutcome } from './runtime-session.js';
import type { ClaudeCodeSession } from './supervisor.js';
import type {
  ClaudeActivityLine,
  ClaudeProtocolEvent,
  TurnOutcome,
} from './types.js';
import type {
  JsonValue,
  RuntimeActivity,
  AgentRuntimeActivitySink,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';

export interface SubmissionDeferred {
  submission: RuntimeSubmission;
  settle: (settlement: RuntimeSubmissionSettlement) => boolean;
}

/**
 * One resident execution window: the commands claude is serving together.
 *
 * It is not one native turn. A window is opened by an initial command and can
 * legally produce several sequential `result` boundaries — one native turn each
 * — as commands steered or queued into it run after the earlier ones were
 * answered.
 */
export interface ActiveTurn {
  initialCommandUuid: string;
  submissions: Map<string, SubmissionDeferred>;
  started: string[];
  completedCommands: Set<string>;
  activitySequence: number;
  tools: Map<string, { name: string; arguments: JsonValue | null }>;
  session: ClaudeCodeSession | null;
  sessionReady: Promise<ClaudeCodeSession>;
  resolveSession: (session: ClaudeCodeSession) => void;
  rejectSession: (error: Error) => void;
  steerQueue: Promise<void>;
  generation: number;
}

export interface ProtocolEventContext {
  threadId: string | null;
  outputSchemaEnabled: boolean;
  activitySink: AgentRuntimeActivitySink;
  log: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void;
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

export function createRuntimeSubmission(): SubmissionDeferred {
  let resolve!: (settlement: RuntimeSubmissionSettlement) => void;
  let settled = false;
  const submission = Object.freeze({
    settled: new Promise<RuntimeSubmissionSettlement>((value) => {
      resolve = value;
    }),
  });
  return {
    submission,
    settle(settlement) {
      if (settled) return false;
      settled = true;
      resolve(settlement);
      return true;
    },
  };
}

export function handleProtocolEvent(
  active: ActiveTurn,
  event: ClaudeProtocolEvent,
  context: ProtocolEventContext,
): void {
  if (event.kind === 'command_lifecycle') {
    // `started` is the one lifecycle state recorded here: it is the
    // attribution input for the group the next `result` completes. The
    // terminal states are drainage bookkeeping that arrives after that
    // `result`.
    if (event.state !== 'started') return;
    if (
      active.submissions.has(event.commandUuid) &&
      !active.completedCommands.has(event.commandUuid) &&
      !active.started.includes(event.commandUuid)
    ) {
      active.started.push(event.commandUuid);
    }
    return;
  }
  if (event.kind === 'result') {
    // `result` is claude's native terminal, and the display line ends on it:
    // the attribution, the completion and the settlements below are
    // push-back's work on the same fact, and none of them may change the end,
    // delay it, or withhold it.
    endNativeTurn(
      event.outcome.isError ? 'failed' : 'completed',
      event.outcome.isError ? turnFailureMessage(event.outcome) : null,
      context.activitySink,
    );
    completeStartedGroup(active, event.outcome, context);
    return;
  }
  emitStreamActivity(active, event.line, context);
}

/** claude's own words for why its turn failed. */
function turnFailureMessage(outcome: TurnOutcome): string {
  return outcome.errors.join('; ') || outcome.subtype || 'claude turn failed';
}

function completeStartedGroup(
  active: ActiveTurn,
  outcome: TurnOutcome,
  context: ProtocolEventContext,
): void {
  const commandUuids = active.started.splice(0);
  if (
    commandUuids.length === 0 &&
    (active.submissions.size > 1 || active.completedCommands.size > 0)
  ) {
    failUnattributedResult(active, context);
    return;
  }
  for (const uuid of commandUuids) active.completedCommands.add(uuid);
  let representative = commandUuids
    .map(uuid => active.submissions.get(uuid))
    .find((deferred): deferred is SubmissionDeferred => deferred !== undefined);
  if (representative === undefined && active.submissions.size === 1) {
    const only = active.submissions.entries().next().value as
      | [string, SubmissionDeferred]
      | undefined;
    if (only !== undefined) {
      commandUuids.push(only[0]);
      representative = only[1];
    }
  }
  if (representative === undefined) {
    failUnattributedResult(active, context);
    return;
  }

  let completion: RuntimeCompletion;
  if (outcome.isError) {
    completion = Object.freeze({
      status: 'failed',
      error: new Error(turnFailureMessage(outcome)),
    });
  } else {
    try {
      completion = Object.freeze({
        status: 'completed',
          resultText: resultTextFromTurnOutcome(
          outcome,
          context.threadId,
          context.outputSchemaEnabled,
        ),
        truncated: false,
      });
    } catch (error) {
      completion = Object.freeze({
        status: 'failed',
          error: asError(error),
      });
    }
  }
  for (const uuid of commandUuids) {
    active.submissions.get(uuid)?.settle({ kind: 'completion', completion });
  }
}

function failUnattributedResult(
  active: ActiveTurn,
  context: ProtocolEventContext,
): void {
  const error = new Error(
    active.completedCommands.size > 0
      ? 'claude emitted a conflicting result without a new started command'
      : 'claude result cannot be attributed without command started lifecycle',
  );
  context.log('error', error.message, error);
  for (const deferred of active.submissions.values()) {
    deferred.settle({ kind: 'failed', error });
  }
}

/**
 * Put what claude said and did on this agent's activity stream.
 *
 * No submission is looked up. A window folds any number of commands into one
 * native turn, so naming one of them as the activity's owner was always a
 * guess — and when the guess failed, which it did for anything claude emitted
 * before a command's `started` lifecycle arrived, the fact was dropped
 * entirely. The agent is the subject, and it is always known.
 *
 * The envelope decides what a block means, not the block's own type. An
 * `assistant` envelope carries the model's words and its tool calls. A `user`
 * envelope carries what those tools returned — and, as plain text blocks, the
 * context the CLI injected into its own conversation: the body of a skill it
 * just loaded, hook output, reminders. None of that text is the agent's, and
 * none of it is the operator's (stdin is never echoed back), so it is not
 * displayed at all. Operator ruling, 2026-09-03: 「所有的 user 消息都隐藏即可」.
 */
function emitStreamActivity(
  active: ActiveTurn,
  line: ClaudeActivityLine,
  context: ProtocolEventContext,
): void {
  const message = recordValue(line.raw['message']) ?? line.raw;
  const messageId = stringValue(message['id']) ?? `stream-${active.activitySequence++}`;
  const content = Array.isArray(message['content']) ? message['content'] : [];
  for (const [blockIndex, candidate] of content.entries()) {
    const block = recordValue(candidate);
    if (block === null) continue;
    const activity = line.kind === 'assistant'
      ? assistantBlockActivity(active, messageId, blockIndex, block)
      : toolResultActivity(active, messageId, block);
    if (activity === null) continue;
    emitActivity(activity, context.activitySink);
  }
}

/** What the model said, or a tool it called. */
function assistantBlockActivity(
  active: ActiveTurn,
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
      truncated: false,
    };
  }
  if (block['type'] !== 'tool_use') return null;
  const callId = stringValue(block['id']);
  const name = stringValue(block['name']);
  if (callId === null || callId === '' || name === null) return null;
  const args = toJsonValue(block['input']);
  active.tools.set(callId, { name, arguments: args });
  return {
    kind: 'tool.call',
    occurredAt: Date.now(),
    id: `${messageId}:${callId}:started`,
    callId,
    toolName: name,
    action: namedToolAction(name),
    status: 'started',
    arguments: args,
    result: null,
    error: null,
  };
}

/** What a tool returned, correlated to the call the model made. */
function toolResultActivity(
  active: ActiveTurn,
  messageId: string,
  block: Record<string, unknown>,
): RuntimeActivity | null {
  if (block['type'] !== 'tool_result') return null;
  const callId = stringValue(block['tool_use_id']);
  if (callId === null || callId === '') return null;
  const known = active.tools.get(callId);
  const failed = block['is_error'] === true;
  const result = normalizeTextBlocks(block['content']);
  return {
    kind: 'tool.call',
    occurredAt: Date.now(),
    id: `${messageId}:${callId}:result`,
    callId,
    toolName: known?.name ?? 'tool',
    action: namedToolAction(known?.name),
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

function namedToolAction(value: unknown): RuntimeToolAction | null {
  switch (value) {
    case 'Read': return 'read';
    case 'Grep':
    case 'Glob':
    case 'WebSearch': return 'search';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return 'edit';
    case 'Bash':
    case 'PowerShell': return 'run';
    default: return null;
  }
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
