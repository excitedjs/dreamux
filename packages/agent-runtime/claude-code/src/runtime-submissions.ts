import { resultTextFromTurnOutcome } from './runtime-session.js';
import type { ClaudeCodeSession } from './supervisor.js';
import type { ClaudeProtocolEvent, TurnOutcome } from './types.js';
import type {
  JsonValue,
  RuntimeActivity,
  AgentRuntimeActivitySink,
  AgentRuntimeNativeTurnSink,
  RuntimeCompletion,
  RuntimeNativeTurnEnd,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';

export interface SubmissionDeferred {
  submission: RuntimeSubmission;
  settle: (settlement: RuntimeSubmissionSettlement) => boolean;
}

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
  /**
   * Whether this native turn already reported its one end.
   *
   * A turn is ended by exactly one thing — the terminal `result`, a failed run,
   * or a stop — but more than one of those can be observed for the same turn
   * (a `result` that lands and is then followed by a generation assertion
   * throwing). The flag is what makes "one end per native turn" true rather
   * than merely usual.
   */
  nativeTurnEnded: boolean;
}

export interface ProtocolEventContext {
  threadId: string | null;
  outputSchemaEnabled: boolean;
  activitySink: AgentRuntimeActivitySink;
  nativeTurnSink: AgentRuntimeNativeTurnSink;
  log: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void;
}

/**
 * Report this native turn's one end, at most once.
 *
 * The sink is display-only, so a throwing consumer is logged and the turn
 * proceeds; the flag is still set, because a second attempt would be the same
 * end reported twice, not a retry.
 */
export function endNativeTurn(
  active: ActiveTurn,
  status: RuntimeNativeTurnEnd['status'],
  sink: AgentRuntimeNativeTurnSink,
  log: (level: 'info' | 'warn' | 'error', message: string, error?: unknown) => void,
): void {
  if (active.nativeTurnEnded) return;
  active.nativeTurnEnded = true;
  try {
    sink(Object.freeze({ status, occurredAt: Date.now() }));
  } catch (error) {
    log('warn', 'claude native turn end projection failed', error);
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
    if (
      event.state === 'started' &&
      active.submissions.has(event.commandUuid) &&
      !active.completedCommands.has(event.commandUuid) &&
      !active.started.includes(event.commandUuid)
    ) {
      active.started.push(event.commandUuid);
    }
    return;
  }
  if (event.kind === 'result') {
    completeStartedGroup(active, event.outcome, context);
    return;
  }
  const raw = recordValue(event.line.raw);
  if (raw !== null) emitStreamActivity(active, raw, context);
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
      error: new Error(outcome.errors.join('; ') || outcome.subtype || 'claude turn failed'),
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
  // The `result` is claude's one native terminal, so the native turn ends here
  // regardless of how many commands were folded into it.
  endNativeTurn(
    active,
    completion.status === 'completed' ? 'completed' : 'failed',
    context.nativeTurnSink,
    context.log,
  );
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
  endNativeTurn(active, 'failed', context.nativeTurnSink, context.log);
}

function emitStreamActivity(
  active: ActiveTurn,
  raw: Record<string, unknown>,
  context: ProtocolEventContext,
): void {
  const representativeUuid = active.started[0] ?? (active.submissions.size === 1
    ? active.submissions.keys().next().value
    : undefined);
  if (representativeUuid === undefined) return;
  const representative = active.submissions.get(representativeUuid);
  if (representative === undefined) return;
  const message = recordValue(raw['message']) ?? raw;
  const messageId = stringValue(message['id']) ?? `stream-${active.activitySequence++}`;
  const content = Array.isArray(message['content']) ? message['content'] : [];
  for (const [blockIndex, candidate] of content.entries()) {
    const block = recordValue(candidate);
    if (block === null) continue;
    const activity = activityForBlock(active, messageId, blockIndex, block);
    if (activity === null) continue;
    try {
      context.activitySink(Object.freeze({
        submission: representative.submission,
        activity: Object.freeze(activity),
        occurredAt: Date.now(),
      }));
    } catch (error) {
      context.log('warn', 'claude activity projection failed', error);
    }
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
