/**
 * Claude Code native-result attribution and live activity projection.
 *
 * These tests drive the REAL protocol seam: a `ClaudeCodeStreamRpc` over a fake
 * stdin, whose `onProtocolEvent` output is fed straight into
 * `handleProtocolEvent()` against a hand-built `ActiveTurn`. The fakes replay
 * nothing but native NDJSON stdout lines — `system/init`, `command_lifecycle`,
 * `assistant`, `user` (tool results) and `result`. No fake is ever told how many
 * completions to produce; fold vs queue is expressed purely as "which command
 * uuids are in the started set when a `result` arrives", and the assertions are
 * on the resulting completion-token identity and count.
 *
 * Contract under test:
 *  - one native result => exactly one FROZEN `RuntimeCompletion` token;
 *  - folded submissions settle with an `Object.is`-identical token;
 *  - each further native result mints a DISTINCT token, even byte-identical text;
 *  - `result.user_message_uuid` is diagnostics only;
 *  - an unattributable / conflicting result fails loudly and mints NO token;
 *  - the interrupt artifact and non-`completed` lifecycle states mint NO token;
 *  - activity is pushed LIVE from the stream, before the terminal result,
 *    referencing the display representative, and a folded follower never
 *    replays it.
 */

import type { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import {
  createRuntimeSubmission,
  handleProtocolEvent,
  type ActiveTurn,
  type ProtocolEventContext,
  type SubmissionDeferred,
} from '../src/runtime-submissions.js';
import type { ClaudeCodeSession } from '../src/types.js';
import type {
  RuntimeActivityEvent,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  error?: unknown;
}

/** stdin double: records the written NDJSON and confirms writes synchronously. */
class FakeStdin {
  writable = true;
  readonly writes: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk);
    callback?.(null);
    return true;
  }
}

class Harness {
  readonly stdin = new FakeStdin();
  readonly activities: RuntimeActivityEvent[] = [];
  /** Logs raised by `handleProtocolEvent` (attribution failures, sink faults). */
  readonly protocolLogs: LogEntry[] = [];
  /** Logs raised by the RPC itself (interrupt artifact, declined commands). */
  readonly rpcLogs: LogEntry[] = [];
  reapCalls = 0;
  readonly active: ActiveTurn;
  readonly rpc: ClaudeCodeStreamRpc;

  private sink: (event: RuntimeActivityEvent) => void = (event) => {
    this.activities.push(event);
  };

  private submitPromise: Promise<void> | null = null;

  constructor(initialCommandUuid: string) {
    this.active = createActiveTurn(initialCommandUuid);
    const context: ProtocolEventContext = {
      threadId: TEST_SESSION_ID,
      outputSchemaEnabled: false,
      activitySink: (event) => {
        this.sink(event);
      },
      log: (level, message, error) => {
        this.protocolLogs.push({ level, message, error });
      },
    };
    this.rpc = new ClaudeCodeStreamRpc(this.stdin as unknown as Writable, {
      turnTimeoutMs: 60_000,
      log: (level, message, error) => {
        this.rpcLogs.push({ level, message, error });
      },
      reapOnTimeout: () => {
        this.reapCalls += 1;
      },
      onProtocolEvent: (event) => {
        handleProtocolEvent(this.active, event, context);
      },
    });
  }

  /** The initial native command of this resident execution window. */
  submit(commandUuid: string, text: string): SubmissionDeferred {
    const deferred = this.addSubmission(commandUuid);
    this.submitPromise = this.rpc.submitTurn(text, {}, commandUuid);
    void this.submitPromise.catch(() => undefined);
    return deferred;
  }

  /** A live steer written into the same execution window. */
  async steer(
    commandUuid: string,
    text: string,
    priority: 'now' | 'next' = 'next',
  ): Promise<SubmissionDeferred> {
    const deferred = this.addSubmission(commandUuid);
    await this.rpc.steerTurn(text, { priority }, commandUuid);
    return deferred;
  }

  emit(line: Record<string, unknown>): void {
    this.rpc.onStdoutChunk(`${JSON.stringify(line)}\n`);
  }

  /** Resolves once every submitted command drained and a result was seen. */
  async drained(): Promise<void> {
    await this.submitPromise;
  }

  failActivitySink(error: Error): void {
    this.sink = (event) => {
      this.activities.push(event);
      throw error;
    };
  }

  dispose(): void {
    this.rpc.failPending(new Error('test teardown'));
  }

  private addSubmission(commandUuid: string): SubmissionDeferred {
    const deferred = createRuntimeSubmission();
    this.active.submissions.set(commandUuid, deferred);
    return deferred;
  }
}

function createActiveTurn(initialCommandUuid: string): ActiveTurn {
  let resolveSession!: (session: ClaudeCodeSession) => void;
  let rejectSession!: (error: Error) => void;
  const sessionReady = new Promise<ClaudeCodeSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  void sessionReady.catch(() => undefined);
  return {
    initialCommandUuid,
    submissions: new Map(),
    started: [],
    completedCommands: new Set(),
    activitySequence: 0,
    tools: new Map(),
    session: null,
    sessionReady,
    resolveSession,
    rejectSession,
    steerQueue: Promise.resolve(),
    generation: 0,
  };
}

// ─── native stdout line builders (real wire shapes only) ────────────────────

function initLine(capabilities: readonly string[]): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: TEST_SESSION_ID,
    model: 'claude-sonnet-4-5',
    capabilities,
  };
}

function lifecycleLine(
  commandUuid: string,
  state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded' | 'refused',
): Record<string, unknown> {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state };
}

function successResultLine(
  text: string,
  userMessageUuid?: string,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: TEST_SESSION_ID,
    ...(userMessageUuid !== undefined
      ? { user_message_uuid: userMessageUuid }
      : {}),
  };
}

function errorResultLine(
  subtype: string,
  errors: readonly string[],
): Record<string, unknown> {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors,
    session_id: TEST_SESSION_ID,
  };
}

/**
 * The artifact a `priority: 'now'` interrupt leaves behind: an
 * `error_during_execution` result with no final text and no
 * `user_message_uuid`. It is not a native answer boundary.
 */
function interruptArtifactLine(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: TEST_SESSION_ID,
  };
}

function assistantTextLine(
  messageId: string,
  ...texts: readonly string[]
): Record<string, unknown> {
  return {
    type: 'assistant',
    session_id: TEST_SESSION_ID,
    message: {
      id: messageId,
      role: 'assistant',
      content: texts.map((text) => ({ type: 'text', text })),
    },
  };
}

function assistantToolUseLine(
  messageId: string,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    session_id: TEST_SESSION_ID,
    message: {
      id: messageId,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
    },
  };
}

function toolResultLine(
  messageId: string,
  toolUseId: string,
  content: unknown,
  isError = false,
): Record<string, unknown> {
  return {
    type: 'user',
    session_id: TEST_SESSION_ID,
    message: {
      id: messageId,
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

// ─── assertion helpers ──────────────────────────────────────────────────────

function completionOf(settlement: RuntimeSubmissionSettlement): RuntimeCompletion {
  if (settlement.kind !== 'completion') {
    throw new Error(`expected a completion settlement, got ${settlement.kind}`);
  }
  return settlement.completion;
}

function completedOf(
  settlement: RuntimeSubmissionSettlement,
): Extract<RuntimeCompletion, { status: 'completed' }> {
  const completion = completionOf(settlement);
  if (completion.status !== 'completed') {
    throw new Error(`expected a completed token, got ${completion.status}`);
  }
  return completion;
}

function failureOf(settlement: RuntimeSubmissionSettlement): Error {
  if (settlement.kind !== 'failed') {
    throw new Error(`expected a failed settlement, got ${settlement.kind}`);
  }
  return settlement.error;
}

function toolCallOf(
  event: RuntimeActivityEvent | undefined,
): Extract<RuntimeActivityEvent['activity'], { kind: 'tool.call' }> {
  if (event === undefined) throw new Error('missing activity event');
  if (event.activity.kind !== 'tool.call') {
    throw new Error(`expected tool.call, got ${event.activity.kind}`);
  }
  return event.activity;
}

function assistantMessageOf(
  event: RuntimeActivityEvent | undefined,
): Extract<RuntimeActivityEvent['activity'], { kind: 'assistant.message' }> {
  if (event === undefined) throw new Error('missing activity event');
  if (event.activity.kind !== 'assistant.message') {
    throw new Error(`expected assistant.message, got ${event.activity.kind}`);
  }
  return event.activity;
}

interface Tracked {
  settled: boolean;
  settlement: RuntimeSubmissionSettlement | null;
}

function track(submission: RuntimeSubmission): Tracked {
  const state: Tracked = { settled: false, settlement: null };
  void submission.settled.then((settlement) => {
    state.settled = true;
    state.settlement = settlement;
  });
  return state;
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

const harnesses: Harness[] = [];

function harness(initialCommandUuid = 'cmd-a'): Harness {
  const created = new Harness(initialCommandUuid);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose();
});

describe('claude native result attribution', () => {
  it('two commands started before one native result settle with the identical frozen token', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    h.emit(lifecycleLine('cmd-b', 'started'));
    // One native result while BOTH uuids are in the started set => one fold.
    h.emit(successResultLine('folded answer'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    await h.drained();

    const first = completionOf(await a.submission.settled);
    const second = completionOf(await b.submission.settled);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    const completed = completedOf(await a.submission.settled);
    expect(completed.resultText).toBe('folded answer');
    expect(completed.truncated).toBe(false);
    // The display representative is the first command that entered `started`.
    expect(completed.displaySubmission).toBe(a.submission);
    expect(completed.displaySubmission).not.toBe(b.submission);
  });

  it('a command that starts only after the first result gets its own distinct token', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    // The steer is only queued when the first result lands: no fold.
    h.emit(lifecycleLine('cmd-b', 'queued'));
    h.emit(successResultLine('answer one'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'started'));
    h.emit(successResultLine('answer two'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    await h.drained();

    const first = completedOf(await a.submission.settled);
    const second = completedOf(await b.submission.settled);
    expect(first).not.toBe(second);
    expect(first.resultText).toBe('answer one');
    expect(second.resultText).toBe('answer two');
    expect(first.displaySubmission).toBe(a.submission);
    expect(second.displaySubmission).toBe(b.submission);
  });

  it('three native results in one execution window attribute per started command', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    const b = await h.steer('cmd-b', 'second');
    const c = await h.steer('cmd-c', 'third');

    h.emit(lifecycleLine('cmd-a', 'started'));
    h.emit(successResultLine('one'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'started'));
    h.emit(successResultLine('two'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    h.emit(lifecycleLine('cmd-c', 'started'));
    h.emit(successResultLine('three'));
    h.emit(lifecycleLine('cmd-c', 'completed'));
    await h.drained();

    const first = completedOf(await a.submission.settled);
    const second = completedOf(await b.submission.settled);
    const third = completedOf(await c.submission.settled);
    expect([first.resultText, second.resultText, third.resultText]).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(first).not.toBe(second);
    expect(second).not.toBe(third);
    expect(first).not.toBe(third);
    expect(first.displaySubmission).toBe(a.submission);
    expect(second.displaySubmission).toBe(b.submission);
    expect(third.displaySubmission).toBe(c.submission);
  });

  it('two native results with byte-identical text still mint two distinct tokens', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    h.emit(successResultLine('identical body'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'started'));
    h.emit(successResultLine('identical body'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    await h.drained();

    const first = completedOf(await a.submission.settled);
    const second = completedOf(await b.submission.settled);
    expect(first.resultText).toBe(second.resultText);
    expect(first).not.toBe(second);
    expect(first.displaySubmission).not.toBe(second.displaySubmission);
  });

  it('result.user_message_uuid is diagnostics only and never steals attribution', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    const c = await h.steer('cmd-c', 'third');
    h.emit(lifecycleLine('cmd-b', 'started'));
    // The uuid names the SECOND command; the started set still owns attribution.
    h.emit(successResultLine('folded answer', 'cmd-b'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'completed'));

    h.emit(lifecycleLine('cmd-c', 'started'));
    // No uuid at all on the second result: identical handling.
    h.emit(successResultLine('third answer'));
    h.emit(lifecycleLine('cmd-c', 'completed'));
    await h.drained();

    const folded = completedOf(await a.submission.settled);
    expect(completionOf(await b.submission.settled)).toBe(folded);
    expect(folded.displaySubmission).toBe(a.submission);

    const third = completedOf(await c.submission.settled);
    expect(third).not.toBe(folded);
    expect(third.resultText).toBe('third answer');
    expect(third.displaySubmission).toBe(c.submission);
    expect(h.reapCalls).toBe(0);
  });

  it('an error-subtype result still mints one completion token with status failed', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    h.emit(errorResultLine('error_max_turns', ['max turns exceeded']));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    await h.drained();

    const settlement = await a.submission.settled;
    // A native error result is still a native answer: a token, not {kind:'failed'}.
    expect(settlement.kind).toBe('completion');
    const completion = completionOf(settlement);
    expect(completion.status).toBe('failed');
    expect(Object.isFrozen(completion)).toBe(true);
    if (completion.status !== 'failed') throw new Error('unreachable');
    expect(completion.error.message).toMatch(/max turns exceeded/u);
    expect(completion.displaySubmission).toBe(a.submission);
  });
});

describe('claude unattributable native results', () => {
  it('a second result with no newly started command fails loudly and mints no token', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    h.emit(successResultLine('answer one'));
    const firstToken = completedOf(await a.submission.settled);

    // Conflicting terminal: a result arrives while nothing new started and a
    // command has already been attributed.
    h.emit(successResultLine('impossible second answer'));
    await flush();

    const failure = failureOf(await b.submission.settled);
    expect(failure.message).toMatch(/conflicting result/u);
    expect(
      h.protocolLogs.some(
        (entry) =>
          entry.level === 'error' && /conflicting result/u.test(entry.message),
      ),
    ).toBe(true);
    // The already-settled submission keeps its original token: the duplicate
    // terminal created no second completion.
    expect(completionOf(await a.submission.settled)).toBe(firstToken);
    expect(firstToken.resultText).toBe('answer one');
  });

  it('a result with no started lifecycle and several submissions fails loudly instead of guessing', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    const b = await h.steer('cmd-b', 'second');
    // No `command_lifecycle` started fact ever arrives for either command.
    h.emit(successResultLine('ambiguous answer'));
    await flush();

    const firstFailure = failureOf(await a.submission.settled);
    const secondFailure = failureOf(await b.submission.settled);
    expect(firstFailure.message).toMatch(
      /cannot be attributed without command started lifecycle/u,
    );
    expect(secondFailure).toBe(firstFailure);
    expect(h.activities).toHaveLength(0);
  });

  it('a lone submission with no lifecycle capability is still attributed to that submission', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'only');
    // No `msg_lifecycle_v1`: this build will never emit command_lifecycle.
    h.emit(initLine([]));
    h.emit(successResultLine('single answer'));
    await h.drained();

    const completion = completedOf(await a.submission.settled);
    expect(completion.resultText).toBe('single answer');
    expect(completion.displaySubmission).toBe(a.submission);
    expect(h.protocolLogs).toHaveLength(0);
  });
});

describe('claude non-answer native events', () => {
  it('the priority:now interrupt artifact mints no token and the real later result does', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'interrupting steer', 'now');
    const trackedA = track(a.submission);
    const trackedB = track(b.submission);

    h.emit(interruptArtifactLine());
    await flush();
    expect(trackedA.settled).toBe(false);
    expect(trackedB.settled).toBe(false);
    expect(
      h.rpcLogs.some(
        (entry) =>
          entry.level === 'warn' &&
          /interrupt result artifact ignored/u.test(entry.message),
      ),
    ).toBe(true);

    h.emit(lifecycleLine('cmd-b', 'started'));
    h.emit(successResultLine('real answer'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    await h.drained();

    const completion = completedOf(await a.submission.settled);
    expect(completionOf(await b.submission.settled)).toBe(completion);
    expect(completion.resultText).toBe('real answer');
  });

  it('cancelled, refused and discarded lifecycle states mint no completion token', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    const b = await h.steer('cmd-b', 'second');
    const c = await h.steer('cmd-c', 'third');
    const d = await h.steer('cmd-d', 'fourth');
    const tracked = [b, c, d].map((deferred) => track(deferred.submission));

    h.emit(lifecycleLine('cmd-b', 'cancelled'));
    h.emit(lifecycleLine('cmd-c', 'refused'));
    h.emit(lifecycleLine('cmd-d', 'discarded'));
    await flush();
    expect(tracked.map((state) => state.settled)).toEqual([false, false, false]);
    expect(h.activities).toHaveLength(0);

    h.emit(lifecycleLine('cmd-a', 'started'));
    h.emit(successResultLine('surviving answer'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    await h.drained();

    const completion = completedOf(await a.submission.settled);
    expect(completion.displaySubmission).toBe(a.submission);
    // Internal-only lifecycle states never produced a token of their own.
    expect(tracked.map((state) => state.settled)).toEqual([false, false, false]);
  });
});

describe('claude live activity projection', () => {
  it('projects assistant activity for one no-lifecycle submission before completion', async () => {
    const h = harness();
    const only = h.submit('cmd-a', 'only');
    h.emit(initLine([]));

    h.emit(assistantTextLine('msg_1', 'live without lifecycle'));
    expect(h.activities).toHaveLength(1);
    expect(assistantMessageOf(h.activities[0]).text).toBe(
      'live without lifecycle',
    );
    expect(h.activities[0]?.submission).toBe(only.submission);
    expect(track(only.submission).settled).toBe(false);

    h.emit(successResultLine('final answer'));
    await h.drained();
    expect(completedOf(await only.submission.settled).resultText).toBe(
      'final answer',
    );
  });

  it('projects tool use and result for one no-lifecycle submission before completion', async () => {
    const h = harness();
    const only = h.submit('cmd-a', 'only');
    h.emit(initLine([]));

    h.emit(assistantToolUseLine('msg_1', 'toolu_1', 'Bash', { command: 'pwd' }));
    h.emit(toolResultLine('msg_2', 'toolu_1', '/workspace'));
    expect(h.activities).toHaveLength(2);
    expect(toolCallOf(h.activities[0])).toMatchObject({
      callId: 'toolu_1',
      toolName: 'Bash',
      action: 'run',
      status: 'started',
      arguments: { command: 'pwd' },
    });
    expect(toolCallOf(h.activities[1])).toMatchObject({
      callId: 'toolu_1',
      toolName: 'Bash',
      action: 'run',
      status: 'completed',
      result: '/workspace',
    });
    expect(h.activities.every((event) => event.submission === only.submission))
      .toBe(true);

    h.emit(successResultLine('tool finished'));
    await h.drained();
    expect(completedOf(await only.submission.settled).resultText).toBe(
      'tool finished',
    );
  });

  it('classifies named tool actions without inferring unknown tools', () => {
    const h = harness();
    h.submit('cmd-a', 'only');
    h.emit(initLine([]));

    const cases = [
      ['Read', 'read'],
      ['Glob', 'search'],
      ['Grep', 'search'],
      ['WebSearch', 'search'],
      ['Write', 'edit'],
      ['Edit', 'edit'],
      ['MultiEdit', 'edit'],
      ['NotebookEdit', 'edit'],
      ['Bash', 'run'],
      ['PowerShell', 'run'],
      ['Task', null],
      ['TodoWrite', null],
      ['WebFetch', null],
      ['mcp__docs__lookup', null],
    ] as const;
    for (const [index, [toolName]] of cases.entries()) {
      h.emit(assistantToolUseLine(
        `msg_${index}`,
        `toolu_${index}`,
        toolName,
        { value: index },
      ));
    }

    expect(h.activities.map((event) => toolCallOf(event).action)).toEqual(
      cases.map(([, action]) => action),
    );
  });

  it('normalizes tool-result text blocks and preserves mixed provider content', () => {
    const h = harness();
    h.submit('cmd-a', 'only');
    h.emit(initLine([]));

    h.emit(assistantToolUseLine('msg_1', 'toolu_1', 'Read', { path: 'one' }));
    h.emit(toolResultLine('msg_2', 'toolu_1', [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]));
    h.emit(assistantToolUseLine('msg_3', 'toolu_2', 'Read', { path: 'mixed' }));
    h.emit(toolResultLine('msg_4', 'toolu_2', [
      { type: 'text', text: 'text' },
      { type: 'image', source: 'opaque' },
    ]));
    h.emit(assistantToolUseLine('msg_5', 'toolu_3', 'Read', { path: 'empty' }));
    h.emit(toolResultLine('msg_6', 'toolu_3', []));
    h.emit(assistantToolUseLine('msg_7', 'toolu_4', 'Read', { path: 'failed' }));
    h.emit(toolResultLine('msg_8', 'toolu_4', [
      { type: 'text', text: 'failed output' },
    ], true));
    h.emit(assistantToolUseLine('msg_9', 'toolu_5', 'Read', { path: 'unknown' }));
    h.emit(toolResultLine('msg_10', 'toolu_5', [], true));

    const results = h.activities
      .map((event) => toolCallOf(event))
      .filter((activity) => activity.status !== 'started');
    expect(results).toMatchObject([
      { action: 'read', result: 'one\ntwo', error: null },
      {
        action: 'read',
        result: [
          { type: 'text', text: 'text' },
          { type: 'image', source: 'opaque' },
        ],
        error: null,
      },
      { action: 'read', result: null, error: null },
      {
        action: 'read',
        status: 'failed',
        result: 'failed output',
        error: 'failed output',
      },
      {
        action: 'read',
        status: 'failed',
        result: null,
        error: null,
      },
    ]);
  });

  it('serializes structured failed tool-result detail into error', () => {
    const h = harness();
    const detail = [
      { type: 'text', text: 'failed output' },
      { type: 'image', source: 'opaque' },
    ];
    h.submit('cmd-a', 'only');
    h.emit(initLine([]));
    h.emit(assistantToolUseLine('msg_1', 'toolu_1', 'Read', { path: 'mixed' }));
    h.emit(toolResultLine('msg_2', 'toolu_1', detail, true));

    expect(toolCallOf(h.activities[1])).toMatchObject({
      status: 'failed',
      result: detail,
      error: JSON.stringify(detail),
    });
  });

  it('projects assistant text and tool calls live before the terminal result, once per folded stream', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    const b = await h.steer('cmd-b', 'second');
    h.emit(lifecycleLine('cmd-b', 'started'));
    const trackedA = track(a.submission);

    h.emit(assistantTextLine('msg_1', 'looking into it'));
    h.emit(assistantToolUseLine('msg_2', 'toolu_1', 'Bash', { command: 'ls' }));
    h.emit(toolResultLine('msg_3', 'toolu_1', 'file.txt'));
    h.emit(assistantToolUseLine('msg_4', 'toolu_2', 'Read', { path: '/missing' }));
    h.emit(toolResultLine('msg_5', 'toolu_2', 'ENOENT: no such file', true));

    // Live: every activity fact is already delivered while the turn is still
    // running, before any result arrives.
    expect(h.activities).toHaveLength(5);
    await flush();
    expect(trackedA.settled).toBe(false);

    expect(h.activities.map((event) => event.activity.kind)).toEqual([
      'assistant.message',
      'tool.call',
      'tool.call',
      'tool.call',
      'tool.call',
    ]);
    expect(assistantMessageOf(h.activities[0]).text).toBe('looking into it');
    expect(assistantMessageOf(h.activities[0]).truncated).toBe(false);

    const started = toolCallOf(h.activities[1]);
    const completed = toolCallOf(h.activities[2]);
    expect(started.status).toBe('started');
    expect(started.callId).toBe('toolu_1');
    expect(started.toolName).toBe('Bash');
    expect(started.arguments).toEqual({ command: 'ls' });
    expect(completed.status).toBe('completed');
    // Started and terminal facts share one stable non-empty callId.
    expect(completed.callId).toBe(started.callId);
    expect(completed.callId).not.toBe('');
    expect(completed.toolName).toBe('Bash');
    expect(completed.arguments).toEqual({ command: 'ls' });
    expect(completed.result).toBe('file.txt');
    expect(completed.error).toBeNull();
    expect(completed.id).not.toBe(started.id);

    const failedStart = toolCallOf(h.activities[3]);
    const failed = toolCallOf(h.activities[4]);
    expect(failedStart.callId).toBe('toolu_2');
    expect(failed.callId).toBe('toolu_2');
    expect(failed.status).toBe('failed');
    expect(failed.toolName).toBe('Read');
    expect(failed.action).toBe('read');
    expect(failed.result).toBe('ENOENT: no such file');
    expect(failed.error).toBe('ENOENT: no such file');

    // The folded stream projects once, against the display representative.
    for (const event of h.activities) {
      expect(event.submission).toBe(a.submission);
      expect(event.submission).not.toBe(b.submission);
    }

    h.emit(successResultLine('done looking'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    h.emit(lifecycleLine('cmd-b', 'completed'));
    await h.drained();

    // The follower never replays the stream after the terminal result.
    expect(h.activities).toHaveLength(5);
    const completion = completedOf(await a.submission.settled);
    expect(completionOf(await b.submission.settled)).toBe(completion);
    expect(completion.displaySubmission).toBe(a.submission);
  });

  it('a throwing activity sink is caught and never breaks the native turn', async () => {
    const h = harness();
    const a = h.submit('cmd-a', 'first');
    h.failActivitySink(new Error('sink exploded'));
    h.emit(initLine(['msg_lifecycle_v1']));
    h.emit(lifecycleLine('cmd-a', 'started'));
    h.emit(assistantTextLine('msg_1', 'first block', 'second block'));

    // Both blocks were attempted: one throw did not abort the projection loop.
    expect(h.activities).toHaveLength(2);
    const warnings = h.protocolLogs.filter(
      (entry) =>
        entry.level === 'warn' &&
        /activity projection failed/u.test(entry.message),
    );
    expect(warnings).toHaveLength(2);

    h.emit(successResultLine('unaffected answer'));
    h.emit(lifecycleLine('cmd-a', 'completed'));
    await h.drained();

    const completion = completedOf(await a.submission.settled);
    expect(completion.resultText).toBe('unaffected answer');
  });
});
