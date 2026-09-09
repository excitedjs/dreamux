/** Native activity projection is independent of submitted requests. */
import { describe, expect, it } from 'vitest';
import { endNativeTurn, handleProtocolEvent } from '../src/runtime-activity.js';
import type { ClaudeProtocolEvent, TurnOutcome } from '../src/types.js';
import type { RuntimeActivity } from '@excitedjs/dreamux-types';

type NativeTurnEnd = Extract<RuntimeActivity, { kind: 'turn.ended' }>;
function outcome(overrides: Partial<TurnOutcome> = {}): TurnOutcome {
  return { isError: false, terminalReason: null, text: 'answer', sessionId: 'session', subtype: 'success', errors: [], hasStructuredOutput: false, ...overrides };
}
function makeHarness() {
  const activityEvents: RuntimeActivity[] = [];
  const nativeEnds: NativeTurnEnd[] = [];
  const activity = { activitySequence: 0, tools: new Map() };
  return {
    activityEvents, nativeEnds,
    fire(event: ClaudeProtocolEvent) {
      handleProtocolEvent(event, { activity, activitySink: (item) => {
        if (item.kind === 'turn.ended') nativeEnds.push(item);
        else activityEvents.push(item);
      } });
    },
  };
}

function resultEvent(o: TurnOutcome, commandUuids: string[] = ['cmd-1']): ClaudeProtocolEvent {
  return { kind: 'result', outcome: o, commandUuids };
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

describe('handleProtocolEvent live activity', () => {
  it('shows a compaction as the one line Compacted session, never the summary the CLI wrote', () => {
    const h = makeHarness();
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
      expect.objectContaining({ kind: 'assistant.message', text: 'Compacted session' }),
    ]);
  });

  it('emits an assistant.message activity for streamed text, addressed to no submission at all', () => {
    const h = makeHarness();
    h.fire(streamAssistantText('hello there'));
    expect(h.activityEvents).toHaveLength(1);
    expect(h.activityEvents[0]!).toMatchObject({
      kind: 'assistant.message',
      text: 'hello there',
    });
    // The seam carries no submission: Claude folds any number of commands
    // into one native turn, so the agent is the only honest subject.
    expect(h.activityEvents[0]!).not.toHaveProperty('submission');
  });

  it('emits a started tool.call, then correlates its result by tool_use_id into a completed tool.call', () => {
    const h = makeHarness();
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

  it('carries the display facts derived from the tool input on both the started and the result activity', () => {
    const h = makeHarness();
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

  it('marks a tool_result carrying is_error as a failed tool.call and surfaces a display error', () => {
    const h = makeHarness();
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

  it('emits live activity that no started command could have owned', () => {
    const h = makeHarness();
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

  it('shows nothing for text in a user envelope: a loaded skill body is neither the agent nor the operator', () => {
    const h = makeHarness();
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

  it('still correlates a tool_result that shares its user envelope with injected text', () => {
    const h = makeHarness();
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
 * folded into it. A command submitted during native work can get a `result` of its
 * own, and each such boundary is its own native turn with its own end. The fact
 * carries a status and a timestamp and nothing else — no command uuid, no
 * submission, no turn id — because a folded turn has no single logical owner to
 * name.
 */
describe('handleProtocolEvent usage summary', () => {
  it('emits usage immediately before native end and never adds it to teardown', () => {
    const events: RuntimeActivity[] = [];
    const activitySink = (fact: RuntimeActivity): void => { events.push(fact); };
    const value = outcome({ tokenUsage: { inputTokens: 28_531, outputTokens: 69 }, contextTokens: 14_500 });
    handleProtocolEvent(resultEvent(value), {
      activity: { activitySequence: 0, tools: new Map() }, activitySink,
    });
    expect(events.map((fact) => fact.kind)).toEqual(['assistant.message', 'turn.ended']);
    expect(events[0]).toMatchObject({
      text: 'Context usage 14.5k | Token usage: total=28.6k input=28.5k output=69',
    });
    expect(value.text).toBe('answer');
    endNativeTurn('interrupted', null, activitySink);
    expect(events.map((fact) => fact.kind)).toEqual(['assistant.message', 'turn.ended', 'turn.ended']);
  });

  it('shows background result usage without any submitted command', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, contextTokens: null }), []));
    expect(h.activityEvents[0]).toMatchObject({
      text: 'Context usage n/a | Token usage: total=15 input=10 output=5',
    });
    expect(h.nativeEnds[0]).toMatchObject({ status: 'completed', reason: null });
  });

  it('emits fresh usage on each result while preserving native failure reasons', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ tokenUsage: { inputTokens: 100, outputTokens: 5 }, contextTokens: 50 })));
    h.fire(resultEvent(outcome({
      tokenUsage: { inputTokens: 200, outputTokens: 10 }, isError: true, errors: ['native failure'],
    })));
    expect(h.activityEvents.map((fact) => fact.kind === 'assistant.message' ? fact.text : '')).toEqual([
      'Context usage 50 | Token usage: total=105 input=100 output=5',
      'Context usage n/a | Token usage: total=210 input=200 output=10',
    ]);
    expect(h.nativeEnds.map((fact) => fact.status)).toEqual(['completed', 'failed']);
    expect(h.nativeEnds[1]?.reason).toBe('native failure');
    const ids = h.activityEvents.flatMap((fact) => fact.kind === 'assistant.message' ? [fact.id] : []);
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps native interruption markers before usage and the interrupted end', () => {
    const events: RuntimeActivity[] = [];
    handleProtocolEvent({
      kind: 'interrupted', outcome: outcome({ isError: true, tokenUsage: { inputTokens: 100, outputTokens: 5 } }),
    }, { activity: { activitySequence: 0, tools: new Map() }, activitySink: (fact) => { events.push(fact); } });
    expect(events).toMatchObject([
      { kind: 'assistant.message', text: '[Request interrupted by user]' },
      { kind: 'assistant.message', text: 'Context usage n/a | Token usage: total=105 input=100 output=5' },
      { kind: 'turn.ended', status: 'interrupted', reason: null },
    ]);
  });

  it('adds no usage row when the native result has no metrics', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome()));
    expect(h.activityEvents).toEqual([]);
    expect(h.nativeEnds).toHaveLength(1);
  });

  it.each([
    [0, '0'], [69, '69'], [999, '999'], [1_000, '1k'], [28_637, '28.6k'],
    [999_949, '999.9k'], [999_950, '1m'], [1_450_000, '1.5m'],
    [999_950_000, '1b'], [1_250_000_000, '1.3b'],
  ])('formats %i as %s', (count, formatted) => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ tokenUsage: { inputTokens: count, outputTokens: 0 }, contextTokens: count })));
    expect(h.activityEvents[0]).toMatchObject({
      text: `Context usage ${formatted} | Token usage: total=${formatted} input=${formatted} output=0`,
    });
  });
});

describe('handleProtocolEvent native turn end', () => {
  it('marks an interrupted turn on the card before ending it interrupted', () => {
    const h = makeHarness();
    h.fire({ kind: 'interrupted' });

    // The CLI writes this sentence itself, on a `user` envelope whose text
    // blocks are never displayed, so the provider is what puts it on the card.
    expect(h.activityEvents).toEqual([
      expect.objectContaining({
        kind: 'assistant.message',
        text: '[Request interrupted by user]',
      }),
    ]);
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['interrupted']);
  });

  it('emits exactly one ended fact for a turn that folded three commands into one result', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ text: 'one answer for all three' }), ['cmd-1', 'cmd-2', 'cmd-3']));

    expect(h.nativeEnds).toHaveLength(1);
    expect(h.nativeEnds[0]!.status).toBe('completed');
    // No logical membership: the fact names no command, submission, or turn.
    expect(Object.keys(h.nativeEnds[0]!).sort()).toEqual([
      'kind', 'occurredAt', 'reason', 'status',
    ]);
  });

  it('emits nothing before the result, so an in-flight turn never looks finished', () => {
    const h = makeHarness();
    h.fire(streamAssistantText('still working'));
    h.fire(streamToolUse('call-1', 'Read', { file_path: '/tmp/x' }));

    expect(h.activityEvents.length).toBeGreaterThan(0);
    expect(h.nativeEnds).toHaveLength(0);
  });

  it('reports failed when the native result carries isError', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ isError: true, errors: ['boom'], text: '' })));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['failed']);
  });

  it('emits one end per result boundary when a steered command runs after the first one was answered', () => {
    const h = makeHarness();
    // The already legal protocol sequence for a steer that did not fold: the
    // initial command is answered, then the queued command starts
    // and is answered by a result of its own — two native turns in the one
    // resident session.
    h.fire(resultEvent(outcome({ text: 'first answer' })));
    h.fire(resultEvent(outcome({ text: 'second answer' }), ['cmd-2']));

    expect(h.nativeEnds.map((end) => end.status)).toEqual([
      'completed',
      'completed',
    ]);

  });

  it('reports the second boundary honestly when the steered turn fails after a completed one', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ text: 'first answer' })));
    h.fire(resultEvent(outcome({ isError: true, errors: ['boom'], text: '' }), ['cmd-2']));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'failed']);
  });

  it('reports every terminal result, including a background result', () => {
    const h = makeHarness();
    h.fire(resultEvent(outcome({ text: 'first' })));
    // A background turn has no submitted group but still reports its end.
    h.fire(resultEvent(outcome({ text: 'second' }), []));

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'completed']);
  });

});
