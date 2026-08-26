import { describe, expect, it } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelOrigin,
  DreamuxLogger,
  RuntimeActivityEvent,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import {
  ASSISTANT_TEXT_MAX,
  CONVERSATION_ACTIVITY_FACTS_MAX,
  createConversationProjection,
} from '../src/channel/conversation-projection.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';

function identity(
  role: 'dispatcher' | 'team_leader' | 'team_member' = 'dispatcher',
): AgentEntityIdentity {
  return {
    version: 1,
    dispatcher_id: 'flow',
    name: role === 'dispatcher'
      ? 'dispatcher'
      : role === 'team_leader' ? 'leader' : 'member',
    role,
    team_id: role === 'dispatcher' ? null : 'team-a',
    agent_runtime: 'agent-a',
    session_id: null,
    transcript_locator: null,
    source_cwd: '/home/tester/work/project',
    source_repo: null,
    cwd: '/home/tester/work/project',
    runtime_cwd: '/home/tester/work/project',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/home/tester/work/project',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    identity_prompt: null,
    skill_sources: [],
    created_at: 0,
    updated_at: 0,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
  };
}

function channelOrigin(channelId = 'primary'): ChannelOrigin {
  return {
    provider: 'builtin:feishu',
    channel_id: channelId,
    message_id: 'message-1',
    target: {
      target_type: 'group',
      target_key: 'chat-1',
      bindable: true,
      meta: { chat_id: 'chat-1' },
    },
    binding: null,
  };
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    submittedAt: 100,
    prompt: 'hello',
    origin: { kind: 'channel' as const, channel_origin: channelOrigin() },
    ...overrides,
  };
}

function harness() {
  const events: ChannelCoreEvent[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const noop = () => undefined;
  const log = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (fields: Record<string, unknown> | string) => {
      if (typeof fields !== 'string') warnings.push(fields);
    },
    error: noop,
  } as DreamuxLogger;
  const projection = createConversationProjection({
    coreEvents: {
      hasSources: () => true,
      publish: (_dispatcherId, event) => events.push(event),
    },
    log,
  });
  return { events, warnings, projection };
}

function activityEvent(
  submission: RuntimeSubmission,
  id: string,
): RuntimeActivityEvent {
  return {
    submission,
    activity: {
      kind: 'assistant.message',
      id,
      text: id,
      truncated: false,
    },
    occurredAt: 200,
  };
}

function toolActivityEvent(
  submission: RuntimeSubmission,
  id: string,
): RuntimeActivityEvent {
  return {
    submission,
    activity: {
      kind: 'tool.call',
      id,
      callId: 'call-1',
      toolName: 'shell',
      action: 'run',
      status: 'started',
      arguments: { command: 'status' },
      result: null,
      error: null,
    },
    occurredAt: 201,
  };
}

describe('conversation projection', () => {
  it('publishes the complete neutral event surface for Team members', () => {
    const { events, projection } = harness();
    const member = identity('team_member');
    const projectedTurn = turn();
    const submission = { settled: new Promise(() => undefined) } as RuntimeSubmission;

    projection.projectSubmitted(member, projectedTurn);
    projection.projectActivity(
      member,
      projectedTurn,
      activityEvent(submission, 'message-activity'),
    );
    projection.projectActivity(
      member,
      projectedTurn,
      toolActivityEvent(submission, 'tool-activity'),
    );
    projection.projectSettled({
      identity: member,
      turn: projectedTurn,
      settlement: {
        status: 'completed',
        resultText: 'member complete',
        truncated: false,
      },
    });

    expect(new Set(events.map(({ kind }) => kind))).toEqual(new Set([
      'turn.submitted',
      'turn.message',
      'turn.tool_call',
      'turn.settled',
    ]));
    expect(events.filter(({ kind }) => kind === 'turn.submitted')).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === 'turn.tool_call')).toHaveLength(1);
    expect(events.filter(({ kind }) => kind === 'turn.settled')).toHaveLength(1);
    expect(events).toEqual(events.map((event) => expect.objectContaining({
      kind: event.kind,
      role: 'team_member',
      team_name: 'team-a',
      agent_name: 'member',
      turn_id: 'turn-1',
    })));
  });

  it('sanitizes and truncates the completed assistant settlement', () => {
    const { events, projection } = harness();
    const assistant = [
      'token=secret-value',
      '/home/tester/private-note',
      'x'.repeat(ASSISTANT_TEXT_MAX),
    ].join(' ');

    projection.projectSettled({
      identity: identity(),
      turn: turn(),
      settlement: {
        status: 'completed',
        resultText: assistant,
        truncated: false,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'turn.settled',
      role: 'dispatcher',
      team_name: null,
      status: 'completed',
      assistant_truncated: true,
      redacted: true,
    });
    const projected = events[0];
    if (projected?.kind !== 'turn.settled') throw new Error('expected settled event');
    expect(projected.assistant).toHaveLength(ASSISTANT_TEXT_MAX);
    expect(projected.assistant).toContain('token=<redacted>');
    expect(projected.assistant).toContain('$HOME_PATH');
    expect(projected.assistant).not.toContain('secret-value');
    expect(projected.assistant).not.toContain('/home/tester');
  });

  it.each(['failed', 'stopped'] as const)(
    'projects %s as an assistant-free terminal fact',
    (status) => {
      const { events, projection } = harness();
      projection.projectSettled({
        identity: identity('team_leader'),
        turn: turn(),
        settlement: { status },
      });

      expect(events).toEqual([
        expect.objectContaining({
          kind: 'turn.settled',
          role: 'team_leader',
          team_name: 'team-a',
          status,
          assistant: null,
          assistant_truncated: false,
          redacted: false,
        }),
      ]);
    },
  );

  it('drops newest activity facts at 512 and warns once per submission', () => {
    const { events, warnings, projection } = harness();
    const submission = { settled: new Promise(() => undefined) } as RuntimeSubmission;
    for (let index = 0; index < CONVERSATION_ACTIVITY_FACTS_MAX + 20; index += 1) {
      projection.projectActivity(
        identity('team_leader'),
        turn(),
        activityEvent(submission, `activity-${index}`),
      );
    }

    expect(events).toHaveLength(CONVERSATION_ACTIVITY_FACTS_MAX);
    expect(events.at(-1)).toMatchObject({ event_id: 'activity-511' });
    expect(warnings).toEqual([
      expect.objectContaining({ maximum: CONVERSATION_ACTIVITY_FACTS_MAX }),
    ]);
  });

  it.each([
    { kind: 'scheduled' as const, job_id: 'job-1' },
    { kind: 'completion' as const },
    { kind: 'control' as const },
  ])('publishes no dispatcher stream for origin-less $kind turns', (origin) => {
    const { events, projection } = harness();
    const projectedTurn = turn({ origin });
    const submission = { settled: new Promise(() => undefined) } as RuntimeSubmission;

    projection.projectSubmitted(identity(), projectedTurn);
    projection.projectActivity(
      identity(),
      projectedTurn,
      activityEvent(submission, 'activity-1'),
    );
    projection.projectSettled({
      identity: identity(),
      turn: projectedTurn,
      settlement: { status: 'stopped' },
    });

    expect(events).toEqual([]);
  });
});
