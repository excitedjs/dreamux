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
import { describe, expect, it } from 'vitest';

import {
  createRuntimeSubmission,
  handleProtocolEvent,
  type ActiveTurn,
  type SubmissionDeferred,
} from '../src/runtime-submissions.js';
import type { ClaudeProtocolEvent, TurnOutcome } from '../src/types.js';
import type {
  RuntimeActivity,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

type NativeTurnEnd = Extract<RuntimeActivity, { kind: 'turn.ended' }>;

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
  activityEvents: RuntimeActivity[];
  nativeEnds: NativeTurnEnd[];
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
  const activityEvents: RuntimeActivity[] = [];
  const nativeEnds: NativeTurnEnd[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const sink = (activity: RuntimeActivity): void => {
    if (activity.kind === 'turn.ended') nativeEnds.push(activity);
    else activityEvents.push(activity);
  };
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    logs.push({ level, message });
  };
  return {
    active,
    deferredByUuid,
    activityEvents,
    nativeEnds,
    logs,
    fire(event) {
      handleProtocolEvent(active, event, {
        threadId: options.threadId ?? 'thread-1',
        outputSchemaEnabled: options.outputSchemaEnabled ?? false,
        activitySink: sink,
        log,
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

function completed(commandUuid: string): ClaudeProtocolEvent {
  return { kind: 'command_lifecycle', commandUuid, state: 'completed' };
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
  return streamUserEnvelope(
    [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }],
    messageId,
  );
}

/**
 * A `user` envelope exactly as the CLI emits it on stdout: `role: user`, a
 * content array, and no flag saying who wrote it. The CLI puts its own tool
 * results here, and beside them the context it injects into its conversation —
 * a loaded skill body, hook output — as plain text blocks.
 */
function streamUserEnvelope(
  content: unknown[],
  messageId = 'msg-2',
): ClaudeProtocolEvent {
  return {
    kind: 'stream',
    line: {
      kind: 'user',
      raw: {
        type: 'user',
        message: { id: messageId, role: 'user', content },
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
  it('shows a compaction as the one line Compacted session, never the summary the CLI wrote', () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire({
      kind: 'stream',
      line: {
        kind: 'compact_boundary',
        raw: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 14950, post_tokens: 1789 } },
      },
    });
    // The summary rides right behind the boundary as a synthetic `user`
    // envelope whose content is one string, not a block array.
    h.fire({
      kind: 'stream',
      line: {
        kind: 'user',
        raw: {
          type: 'user',
          isSynthetic: true,
          isReplay: true,
          message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' },
        },
      },
    });
    expect(h.activityEvents).toEqual([
      expect.objectContaining({ kind: 'assistant.message', text: 'Compacted session', truncated: false }),
    ]);
  });

  it('emits an assistant.message activity for streamed text, addressed to no submission at all', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamAssistantText('hello there'));
    expect(h.activityEvents).toHaveLength(1);
    expect(h.activityEvents[0]!).toMatchObject({
      kind: 'assistant.message',
      text: 'hello there',
    });
    // The seam carries no submission: a window folds any number of commands
    // into one native turn, so the agent is the only honest subject.
    expect(h.activityEvents[0]!).not.toHaveProperty('submission');
  });

  it('emits a started tool.call, then correlates its result by tool_use_id into a completed tool.call', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Read', { file_path: '/tmp/x' }));
    h.fire(streamToolResult('call-1', 'file contents', false));
    expect(h.activityEvents).toHaveLength(2);
    expect(h.activityEvents[0]!).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      toolName: 'Read',
      status: 'started',
      action: 'read',
    });
    expect(h.activityEvents[1]!).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      toolName: 'Read',
      status: 'completed',
      result: 'file contents',
    });
  });

  it('carries the display facts derived from the tool input on both the started and the result activity', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Bash', { command: 'git status --short', description: 'Show working tree status' }));
    h.fire(streamToolResult('call-1', 'M src/a.ts', false));
    expect(h.activityEvents).toHaveLength(2);
    for (const activity of h.activityEvents) {
      expect(activity).toMatchObject({
        kind: 'tool.call',
        toolName: 'Bash',
        action: 'run',
        summary: 'Show working tree status',
        invocation: 'git status --short',
      });
    }
  });

  it('marks a tool_result carrying is_error as a failed tool.call and surfaces a display error', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Bash', { command: 'false' }));
    h.fire(streamToolResult('call-1', 'command failed', true));
    const finalActivity = h.activityEvents.at(-1)!;
    expect(finalActivity).toMatchObject({
      kind: 'tool.call',
      status: 'failed',
      action: 'run',
      error: 'command failed',
    });
  });

  it('emits live activity that no started command could have owned', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    // Neither command has been reported started, so the old seam had no
    // submission to attribute this to and dropped it. The agent produced it,
    // and the agent is who the display is keyed on.
    h.fire(streamAssistantText('unattributable text'));
    expect(h.activityEvents).toHaveLength(1);
    expect(h.activityEvents[0]!).toMatchObject({
      kind: 'assistant.message',
      text: 'unattributable text',
    });
  });

  it('shows nothing for text in a user envelope: a loaded skill body is neither the agent nor the operator', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Skill', { skill: 'team-workflow' }));
    h.fire(streamToolResult('call-1', 'Launching skill: team-workflow', false));
    // Observed on the wire (Claude Code 2.1.259): right after the Skill tool's
    // result the CLI emits a `user` envelope whose only content is a text
    // block carrying the entire SKILL.md. The old mapping read the block
    // type alone and put that on the card as the agent's own words.
    h.fire(streamUserEnvelope(
      [{ type: 'text', text: 'Base directory for this skill: ~/.claude/skills/team-workflow\n\n# Team Workflow\n...' }],
      'msg-3',
    ));
    expect(h.activityEvents.map((activity) => activity.kind)).toEqual([
      'tool.call',
      'tool.call',
    ]);
    expect(h.activityEvents[1]!).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      status: 'completed',
      result: 'Launching skill: team-workflow',
    });
  });

  it('still correlates a tool_result that shares its user envelope with injected text', async () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamToolUse('call-1', 'Read', { file_path: 'x' }));
    h.fire(streamUserEnvelope([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents', is_error: false },
      { type: 'text', text: '<system-reminder>injected context</system-reminder>' },
    ]));
    expect(h.activityEvents).toHaveLength(2);
    expect(h.activityEvents[1]!).toMatchObject({
      kind: 'tool.call',
      callId: 'call-1',
      status: 'completed',
      result: 'file contents',
    });
    expect(h.activityEvents.some((activity) => activity.kind === 'assistant.message')).toBe(false);
  });
});

/**
 * One native turn, one ended fact.
 *
 * A native turn is one terminal `result`, however many Dreamux commands were
 * folded into it. The resident execution window it belongs to is not the unit:
 * a command steered into a running window can be answered by a `result` of its
 * own, and each such boundary is its own native turn with its own end. The fact
 * carries a status and a timestamp and nothing else — no command uuid, no
 * submission, no turn id — because a folded turn has no single logical owner to
 * name.
 */
describe('handleProtocolEvent native turn end', () => {
  it('emits exactly one ended fact for a turn that folded three commands into one result', () => {
    const h = makeHarness(['cmd-1', 'cmd-2', 'cmd-3']);
    h.fire(started('cmd-1'));
    h.fire(started('cmd-2'));
    h.fire(started('cmd-3'));
    h.fire(resultEvent(outcome({ text: 'one answer for all three' })));

    expect(h.nativeEnds).toHaveLength(1);
    expect(h.nativeEnds[0]!.status).toBe('completed');
    // No logical membership: the fact names no command, submission, or turn.
    expect(Object.keys(h.nativeEnds[0]!).sort()).toEqual([
      'kind', 'occurredAt', 'reason', 'status',
    ]);
  });

  it('emits nothing before the result, so an in-flight turn never looks finished', () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(streamAssistantText('still working'));
    h.fire(streamToolUse('call-1', 'Read', { file_path: '/tmp/x' }));

    expect(h.activityEvents.length).toBeGreaterThan(0);
    expect(h.nativeEnds).toHaveLength(0);
  });

  it('reports failed when the native result carries isError', () => {
    const h = makeHarness(['cmd-1']);
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ isError: true, errors: ['boom'], text: '' })));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['failed']);
  });

  it('shows claude\'s own result even when push-back cannot attribute it', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    h.fire(resultEvent(outcome()));

    // claude finished the turn; that no started command can own the result is
    // push-back's problem, and it fails those submissions loudly. The card
    // shows what the provider did, not what push-back could make of it.
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);
    await expect(h.settled('cmd-1')).resolves.toMatchObject({ kind: 'failed' });
    await expect(h.settled('cmd-2')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('emits one end per result boundary when a steered command runs after the first one was answered', async () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    // The already legal protocol sequence for a steer that did not fold: the
    // initial command is answered and drains, then the held-back command starts
    // and is answered by a result of its own — two native turns in the one
    // resident execution window.
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ text: 'first answer' })));
    h.fire(completed('cmd-1'));
    h.fire(started('cmd-2'));
    h.fire(resultEvent(outcome({ text: 'second answer' })));
    h.fire(completed('cmd-2'));

    expect(h.nativeEnds.map((end) => end.status)).toEqual([
      'completed',
      'completed',
    ]);
    // Each boundary answered its own command, so neither submission waited on
    // the other's result.
    const [s1, s2] = await Promise.all([h.settled('cmd-1'), h.settled('cmd-2')]);
    expect(s1).toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'first answer' },
    });
    expect(s2).toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'second answer' },
    });
  });

  it('reports the second boundary honestly when the steered turn fails after a completed one', () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ text: 'first answer' })));
    h.fire(started('cmd-2'));
    h.fire(resultEvent(outcome({ isError: true, errors: ['boom'], text: '' })));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'failed']);
  });

  it('reports every terminal result, including a conflicting unattributed result', () => {
    const h = makeHarness(['cmd-1', 'cmd-2']);
    h.fire(started('cmd-1'));
    h.fire(resultEvent(outcome({ text: 'first' })));
    // A conflicting second result fails loudly on the push-back line, because
    // no command started after the first boundary. It is still a terminal
    // result claude reported, so the display line reports the end it says.
    h.fire(resultEvent(outcome({ text: 'second' })));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'completed']);
  });

  it('reports the native result before settling its submissions', () => {
    const order: string[] = [];
    const deferred = createRuntimeSubmission();
    const settle = deferred.settle;
    deferred.settle = (settlement) => {
      order.push('settle');
      return settle(settlement);
    };
    const active = makeHarness(['cmd-1']).active;
    active.submissions.set('cmd-1', deferred);
    const sink = (activity: RuntimeActivity): void => {
      if (activity.kind === 'turn.ended') order.push('end');
    };
    handleProtocolEvent(active, started('cmd-1'), {
      threadId: 'thread-1',
      outputSchemaEnabled: false,
      activitySink: sink,
      log: () => undefined,
    });
    handleProtocolEvent(active, resultEvent(outcome()), {
      threadId: 'thread-1',
      outputSchemaEnabled: false,
      activitySink: sink,
      log: () => undefined,
    });

    expect(order).toEqual(['end', 'settle']);
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
