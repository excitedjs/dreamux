/**
 * Unit tests for `src/runtime-submissions.ts`: the pure translation from
 * forwarded `ClaudeProtocolEvent`s (see `rpc.test.ts` for how those are
 * derived from native stream-json lines) into
 *  - settlement of the accepted `RuntimeSubmission`s (completed / failed), and
 *  - live `AgentRuntimeActivitySink` events (assistant text, tool call/result).
 *
 * No IO, no process, no RPC — `handleProtocolEvent` is driven directly with
 * hand-built `ClaudeProtocolEvent` values, exactly like a real
 * `ClaudeCodeSession`'s `onProtocolEvent` callback would receive them.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeSubmission,
  handleProtocolEvent,
  type ActiveTurn,
  type SubmissionDeferred,
} from '../src/runtime-submissions.js';
import type { ClaudeProtocolEvent, TurnOutcome } from '../src/types.js';
import type {
  RuntimeActivityEvent,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    isError: false,
    text: 'final answer',
    sessionId: 'thread-1',
    subtype: 'success',
    errors: [],
    hasStructuredOutput: false,
    ...overrides,
  };
}

interface Harness {
  active: ActiveTurn;
  deferredByUuid: Map<string, SubmissionDeferred>;
  activityEvents: RuntimeActivityEvent[];
  logs: Array<{ level: string; message: string }>;
  fire(event: ClaudeProtocolEvent): void;
  /** Await settlement of one submitted command uuid. */
  settled(uuid: string): Promise<RuntimeSubmissionSettlement>;
}

function makeHarness(
  commandUuids: string[],
  options: { threadId?: string | null; outputSchemaEnabled?: boolean } = {},
): Harness {
  const deferredByUuid = new Map<string, SubmissionDeferred>();
  const submissions = new Map<string, SubmissionDeferred>();
  for (const uuid of commandUuids) {
    const deferred = createRuntimeSubmission();
    deferredByUuid.set(uuid, deferred);
    submissions.set(uuid, deferred);
  }
  const active: ActiveTurn = {
    initialCommandUuid: commandUuids[0]!,
    submissions,
    started: [],
    completedCommands: new Set(),
    activitySequence: 0,
    tools: new Map(),
    session: null,
    sessionReady: new Promise(() => undefined),
    resolveSession: () => undefined,
    rejectSession: () => undefined,
    steerQueue: Promise.resolve(),
    generation: 0,
  };
  const activityEvents: RuntimeActivityEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  return {
    active,
    deferredByUuid,
    activityEvents,
    logs,
    fire(event) {
      handleProtocolEvent(active, event, {
        threadId: options.threadId ?? 'thread-1',
        outputSchemaEnabled: options.outputSchemaEnabled ?? false,
        activitySink: (event) => activityEvents.push(event),
        log: (level, message) => logs.push({ level, message }),
      });
    },
    settled(uuid) {
      const deferred = deferredByUuid.get(uuid);
      if (deferred === undefined) throw new Error(`no deferred for ${uuid}`);
      return deferred.submission.settled;
    },
  };
}

function started(commandUuid: string): ClaudeProtocolEvent {
  return { kind: 'command_lifecycle', commandUuid, state: 'started' };
}

function resultEvent(o: TurnOutcome): ClaudeProtocolEvent {
  return { kind: 'result', outcome: o };
}

function streamAssistantText(text: string, messageId = 'msg-1'): ClaudeProtocolEvent {
  return {
    kind: 'stream',
    line: {
      kind: 'assistant',
      text,
      sessionId: 'thread-1',
      raw: { message: { id: messageId, content: [{ type: 'text', text }] } },
    },
  };
}

function streamToolUse(
  callId: string,
  name: string,
  input: Record<string, unknown>,
  messageId = 'msg-1',
): ClaudeProtocolEvent {
  return {
    kind: 'stream',
    line: {
      kind: 'assistant',
      text: '',
      sessionId: 'thread-1',
      raw: {
        message: {
          id: messageId,
          content: [{ type: 'tool_use', id: callId, name, input }],
        },
      },
    },
  };
}

function streamToolResult(
  callId: string,
  content: unknown,
  isError: boolean,
  messageId = 'msg-2',
): ClaudeProtocolEvent {
  return {
    kind: 'stream',
    line: {
      kind: 'other',
      type: 'user',
      subtype: null,
      raw: {
        message: {
          id: messageId,
          content: [
            { type: 'tool_result', tool_use_id: callId, content, is_error: isError },
          ],
        },
      },
    },
  };
}

describe('handleProtocolEvent settlement', () => {
  it('settles the single accepted submission as completed with the native result text', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ text: 'the answer' })));
    const settlement = await h.settled('cmd-1');
    expect(settlement).toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'the answer', truncated: false },
    });
  });

  it('settles as failed when the native result carries isError', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ isError: true, errors: ['boom'], text: '' })));
    const settlement = await h.settled('cmd-1');
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion' && settlement.completion.status === 'failed') {
      expect(settlement.completion.error.message).toContain('boom');
    } else {
      throw new Error('expected a failed completion');
    }
  });

  it('settles as failed (not silently completed) when the result session id contradicts the pinned thread', async () => {
    const h = makeHarness(['cmd-1'], { threadId: 'thread-1' });
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ sessionId: 'a-different-thread' })));
    const settlement = await h.settled('cmd-1');
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion') {
      expect(settlement.completion.status).toBe('failed');
    }
  });

  it('settles as failed when a --json-schema session returns no structured_output', async () => {
    const h = makeHarness(['cmd-1'], { outputSchemaEnabled: true });
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ hasStructuredOutput: false })));
    const settlement = await h.settled('cmd-1');
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion') {
      expect(settlement.completion.status).toBe('failed');
    }
  });

  it('folds several started commands answered by one native result into completions sharing the SAME completion object (fold identity)', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2', 'cmd-3']);
    h.fire(started('cmd-1'));
    h.fire(started('cmd-2'));
    h.fire(started('cmd-3'));
    h.fire(resultEvent(outcome({ text: 'one answer for all three' })));
    const [s1, s2, s3] = await Promise.all([
      h.settled('cmd-1'),
      h.settled('cmd-2'),
      h.settled('cmd-3'),
    ]);
    expect(s1.kind).toBe('completion');
    expect(s2.kind).toBe('completion');
    expect(s3.kind).toBe('completion');
    // Reference identity: the exact same RuntimeCompletion instance settles
    // every folded command, so a downstream consumer can dedupe by reference.
    if (s1.kind === 'completion' && s2.kind === 'completion' && s3.kind === 'completion') {
      expect(s1.completion).toBe(s2.completion);
      expect(s2.completion).toBe(s3.completion);
    }
  });

  it('fails every pending submission loudly when a result cannot be attributed to any started command', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    // Neither command was ever reported started, and there are two pending
    // submissions: the result cannot be safely attributed to either.
    h.fire(resultEvent(outcome()));
    const [s1, s2] = await Promise.all([h.settled('cmd-1'), h.settled('cmd-2')]);
    expect(s1.kind).toBe('failed');
    expect(s2.kind).toBe('failed');
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('attributes an unstarted result to the sole pending submission of a single-command turn', async () => {
    // Some Claude Code builds omit `started` for a fast turn; a turn with
    // exactly one submission still has an unambiguous owner.
    const h = makeHarness(['cmd-1']);
    h.fire(resultEvent(outcome({ text: 'fast answer' })));
    const settlement = await h.settled('cmd-1');
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion' && settlement.completion.status === 'completed') {
      expect(settlement.completion.resultText).toBe('fast answer');
    }
  });
});

describe('handleProtocolEvent live activity', () => {
  it('emits an assistant.message activity for streamed text, addressed to the started command as its submission', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamAssistantText('hello there'));
    expect(h.activityEvents).toHaveLength(1);
    expect(h.activityEvents[0]!.activity).toMatchObject({
      kind: 'assistant.message',
      text: 'hello there',
    });
    expect(h.activityEvents[0]!.submission).toBe(
      h.deferredByUuid.get('cmd-1')!.submission,
    );
  });

  it('emits a started tool.call, then correlates its result by tool_use_id into a completed tool.call', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Read', { file_path: '/tmp/x' }));
    h.fire(streamToolResult('call-1', 'file contents', false));
    expect(h.activityEvents).toHaveLength(2);
    expect(h.activityEvents[0]!.activity).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      toolName: 'Read',
      status: 'started',
      action: 'read',
    });
    expect(h.activityEvents[1]!.activity).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      toolName: 'Read',
      status: 'completed',
      result: 'file contents',
    });
  });

  it('marks a tool_result carrying is_error as a failed tool.call and surfaces a display error', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Bash', { command: 'false' }));
    h.fire(streamToolResult('call-1', 'command failed', true));
    const finalActivity = h.activityEvents.at(-1)!.activity;
    expect(finalActivity).toMatchObject({
      kind: 'tool.call',
      status: 'failed',
      action: 'run',
      error: 'command failed',
    });
  });

  it('drops live activity when no started command and no sole submission can own it (no representative)', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    // Neither command has been reported started, and there are two candidates:
    // no safe representative to attribute this activity to.
    h.fire(streamAssistantText('orphaned text'));
    expect(h.activityEvents).toHaveLength(0);
  });

  it('does not fail the turn when the activity sink throws (a projection failure only logs a warning)', async () => {
    const deferred = createRuntimeSubmission();
    const submissions = new Map([['cmd-1', deferred]]);
    const active: ActiveTurn = {
      initialCommandUuid: 'cmd-1',
      submissions,
      started: [],
      completedCommands: new Set(),
      activitySequence: 0,
      tools: new Map(),
      session: null,
      sessionReady: new Promise(() => undefined),
      resolveSession: () => undefined,
      rejectSession: () => undefined,
      steerQueue: Promise.resolve(),
      generation: 0,
    };
    const log = vi.fn();
    const throwingSink = vi.fn(() => {
      throw new Error('sink exploded');
    });
    handleProtocolEvent(active, started('cmd-1'), {
      threadId: null,
      outputSchemaEnabled: false,
      activitySink: throwingSink,
      log: (level, message, error) => log(level, message, error),
    });
    handleProtocolEvent(active, streamAssistantText('text'), {
      threadId: null,
      outputSchemaEnabled: false,
      activitySink: throwingSink,
      log: (level, message, error) => log(level, message, error),
    });
    expect(throwingSink).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', expect.any(String), expect.any(Error));
    // The turn is still live: settling it afterwards must still work.
    // sessionId: null since this harness pins no threadId (threadId: null
    // below) — resultTextFromTurnOutcome only validates a NON-null result
    // session id against the pinned thread.
    handleProtocolEvent(active, resultEvent(outcome({ text: 'ok', sessionId: null })), {
      threadId: null,
      outputSchemaEnabled: false,
      activitySink: throwingSink,
      log: (level, message, error) => log(level, message, error),
    });
    await expect(deferred.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'ok' },
    });
  });
});

describe('createRuntimeSubmission', () => {
  it('settle() is idempotent: the first call wins and later calls return false without re-settling', async () => {
    const deferred = createRuntimeSubmission();
    expect(deferred.settle({ kind: 'stopped' })).toBe(true);
    expect(deferred.settle({ kind: 'failed', error: new Error('too late') })).toBe(false);
    await expect(deferred.submission.settled).resolves.toEqual({ kind: 'stopped' });
  });
});
