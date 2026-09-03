import { resultTextFromTurnOutcome } from './runtime-session.js';
import type { ClaudeCodeSession } from './supervisor.js';
import type { ClaudeProtocolEvent, TurnOutcome } from './types.js';
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
  /** The display line's own state; the runtime owns it across windows. */
  display: NativeTurnDisplay;
}

/**
 * Whether claude is running a native turn, and so still owes its end.
 *
 * The display line reports what the provider is doing, so it keeps its own
 * state instead of reading the push-back window: an `ActiveTurn` is a resident
 * window that answers several commands with a `result` each, it is dropped the
 * moment the window closes, and whether a submission is left in it says
 * nothing about whether claude is still working. claude names no native turn,
 * so this is one open flag rather than a map keyed by turn id — it is the same
 * fact, held the only way claude's protocol allows.
 */
export class NativeTurnDisplay {
  private open = false;

  constructor(
    private readonly sink: AgentRuntimeActivitySink,
    private readonly log: (
      level: 'info' | 'warn' | 'error',
      message: string,
      error?: unknown,
    ) => void,
  ) {}

  /** claude is running a native turn: its end is now owed. */
  note(): void {
    this.open = true;
  }

  /**
   * Report a native turn's end, because claude itself said the turn is over.
   *
   * `status` and `reason` are that terminal fact and nothing else. What the
   * push-back line then makes of it (a result text it cannot extract, a command
   * it cannot attribute, a submission already settled) is push-back's own
   * outcome and never colours the card.
   *
   * Whether the end is *shown* is not this layer's decision either. A card
   * belongs to no turn (`feishu-cot-conversation-cards` requirement, rule 1),
   * and a native end "closes an existing open card but never opens a new one;
   * when no card is open, Feishu ignores it" (rule 8).
   */
  end(status: 'completed' | 'failed' | 'interrupted', reason: string | null): void {
    this.open = false;
    emitActivity(
      { kind: 'turn.ended', occurredAt: Date.now(), status, reason },
      this.sink,
      this.log,
    );
  }

  /**
   * End the native turn claude is still running, because nothing will report
   * it: the run died or was torn down. A turn that already reported its own
   * terminal is over, and this adds no second end to it.
   */
  endOpen(status: 'failed' | 'interrupted', reason: string | null): void {
    if (this.open) this.end(status, reason);
  }
}

function emitActivity(
  activity: RuntimeActivity,
  sink: AgentRuntimeActivitySink,
  log: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void,
): void {
  try {
    sink(Object.freeze(activity));
  } catch (error) {
    log('warn', 'claude activity projection failed', error);
  }
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
    // Only `started` says claude is running something. The terminal states are
    // push-back's drainage bookkeeping, and `completed` arrives *after* the
    // `result` that ended the native turn — treating it as news from claude
    // would re-open a turn that is over and hand the teardown one to interrupt.
    if (event.state !== 'started') return;
    context.display.note();
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
    // `result` is claude's native terminal, and the display line ends on it
    // and on nothing else: the attribution, the completion and the settlements
    // below are push-back's work on the same fact, and none of them may change
    // the end, delay it, or withhold it.
    context.display.end(
      event.outcome.isError ? 'failed' : 'completed',
      event.outcome.isError ? turnFailureMessage(event.outcome) : null,
    );
    completeStartedGroup(active, event.outcome, context);
    return;
  }
  // claude is producing output, so a native turn is running and owes an end.
  context.display.note();
  const raw = recordValue(event.line.raw);
  if (raw !== null) emitStreamActivity(active, raw, context);
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
 * Put what claude said on this agent's activity stream.
 *
 * No submission is looked up. A window folds any number of commands into one
 * native turn, so naming one of them as the activity's owner was always a
 * guess — and when the guess failed, which it did for anything claude emitted
 * before a command's `started` lifecycle arrived, the fact was dropped
 * entirely. The agent is the subject, and it is always known.
 */
function emitStreamActivity(
  active: ActiveTurn,
  raw: Record<string, unknown>,
  context: ProtocolEventContext,
): void {
  const message = recordValue(raw['message']) ?? raw;
  const messageId = stringValue(message['id']) ?? `stream-${active.activitySequence++}`;
  const content = Array.isArray(message['content']) ? message['content'] : [];
  for (const [blockIndex, candidate] of content.entries()) {
    const block = recordValue(candidate);
    if (block === null) continue;
    const activity = activityForBlock(active, messageId, blockIndex, block);
    if (activity === null) continue;
    emitActivity(activity, context.activitySink, context.log);
  }
}

function activityForBlock(
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
  if (block['type'] === 'tool_use') {
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
