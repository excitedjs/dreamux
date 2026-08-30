/**
 * Coverage cell C (event half), Stage 9 node "core-events".
 *
 * The frozen post-COT baseline: `channel/conversation-projection.ts`'s
 * workspace/secret redaction and truncation rules for `teammate.turn.message`
 * and `teammate.turn.tool_call`. Everything else about the catalog (six-kind
 * union, live delivery, team.state/teammate.state, turn_id correlation) lives
 * in `tests/core-event-catalog.test.ts`.
 *
 * "Visible after redaction remain unchanged" is tested directly: content with
 * no secret/path shape must survive byte-for-byte, not be narrowed to any
 * smaller presentation.
 */
import { describe, expect, it } from 'vitest';

import type {
  RuntimeActivityEvent,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import {
  ASSISTANT_TEXT_MAX,
  CONVERSATION_ACTIVITY_FACTS_MAX,
  CONVERSATION_MESSAGE_MAX,
  CONVERSATION_TOOL_ARGUMENTS_MAX,
  CONVERSATION_TOOL_RESULT_MAX,
  createConversationProjection,
  type ProjectedAgent,
} from '../src/channel/conversation-projection.js';
import {
  createCapturingLogger,
  createCapturingPublisher,
  makeIdentity,
} from './helpers/event-harness.js';

const CWD = '/workspace/repo';

function harness(overrides: { hasSources?: boolean } = {}) {
  const publisher = createCapturingPublisher(overrides.hasSources ?? true);
  const { logger, warnCalls } = createCapturingLogger();
  const projection = createConversationProjection({ coreEvents: publisher, log: logger });
  const identity = makeIdentity({ team_id: 'alpha', name: 'scout', cwd: CWD });
  const agent: ProjectedAgent = { identity, role: 'teammate' };
  return { publisher, warnCalls, projection, agent };
}

function fakeSubmission(): RuntimeSubmission {
  return { settled: Promise.resolve({ kind: 'stopped' }) };
}

function submittedMessageContent(
  publisher: ReturnType<typeof createCapturingPublisher>,
): string {
  const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
  if (message?.kind !== 'teammate.turn.message') throw new Error('expected a projected message event');
  return message.content;
}

describe('conversation projection: secret redaction', () => {
  it('redacts an inline password/token-shaped assignment, keeping the key and separator', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'the password: "hunter2xyz" must rotate',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('hunter2xyz');
    expect(content).toContain('password: <redacted>');
  });

  it('redacts an inline api_key= assignment', () => {
    const { publisher, projection, agent } = harness();
    const fakeSecret = ['sk', 'live', 'abcdef1234567890'].join('_');
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: `set api_key=${fakeSecret} in env`,
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain(fakeSecret);
    expect(content).toContain('api_key=<redacted>');
  });

  it('redacts an authorization: value pair', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'authorization: mySecretToken123abc grants access',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('mySecretToken123abc');
    expect(content).toContain('authorization: <redacted>');
  });

  it('redacts a bare Bearer token', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'call it with Bearer abcDEF123.ghiJKL456-_9',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('abcDEF123.ghiJKL456-_9');
    expect(content).toContain('Bearer <redacted>');
  });

  it('redacts a JWT-shaped token', () => {
    const { publisher, projection, agent } = harness();
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: `session ${jwt} end`,
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain(jwt);
    expect(content).toContain('<redacted-jwt>');
  });

  it('redacts an AWS-style access key', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'key AKIAABCDEFGHIJKLMN in use',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('AKIAABCDEFGHIJKLMN');
    expect(content).toContain('<redacted-access-key>');
  });

  it('redacts a PEM private key block', () => {
    const { publisher, projection, agent } = harness();
    const pem = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDExampleKeyData',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: `here is the key:\n${pem}\nend`,
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDExampleKeyData');
    expect(content).toContain('<redacted-private-key>');
  });

  it('replaces the entity workspace cwd with $WORKSPACE', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: `file at ${CWD}/secrets/env.local was read`,
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain(CWD);
    expect(content).toBe('file at $WORKSPACE/secrets/env.local was read');
  });

  it('replaces a POSIX home-directory path with $HOME_PATH', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'key stored at /home/alice/.ssh/id_rsa for signing',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('/home/alice');
    expect(content).toContain('$HOME_PATH');
  });

  it('replaces a Windows home-directory path with $HOME_PATH', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'backup at C:\\Users\\alice\\secrets.txt now',
      source: 'feishu',
    });
    const content = submittedMessageContent(publisher);
    expect(content).not.toContain('C:\\Users\\alice');
    expect(content).toContain('$HOME_PATH');
  });

  it('marks redacted:true only when a rule actually fired, false for ordinary text', () => {
    const { publisher, projection, agent } = harness();
    projection.projectSubmitted(agent, {
      id: 'turn-1',
      submittedAt: Date.now(),
      prompt: 'nothing sensitive here at all',
      source: 'feishu',
    });
    const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
    expect(message?.kind === 'teammate.turn.message' && message.redacted).toBe(false);
  });
});

describe('conversation projection: content visible after redaction is unchanged, not narrowed', () => {
  it('keeps tool call arguments and results byte-identical when nothing is secret- or path-shaped', () => {
    const { publisher, projection, agent } = harness();
    const args = { file: 'report.md', count: 3, tags: ['alpha', 'beta'], nested: { ok: true } };
    const result = { status: 'ok', rows: [10, 20, 30], summary: 'no issues found' };
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: {
        kind: 'tool.call',
        id: 'evt-1',
        callId: 'call-1',
        toolName: 'read_file',
        action: 'read',
        status: 'completed',
        arguments: args,
        result,
        error: null,
      },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);

    const toolEvent = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.tool_call')?.event;
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.arguments_json).toBe(JSON.stringify(args));
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.result_json).toBe(JSON.stringify(result));
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.redacted).toBe(false);
  });

  it('keeps an ordinary assistant message byte-identical', () => {
    const { publisher, projection, agent } = harness();
    const text = 'Ran the tests. 42 passed, 0 failed. Nothing else to report.';
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: { kind: 'assistant.message', id: 'evt-1', text, truncated: false },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
    expect(message?.kind === 'teammate.turn.message' && message.content).toBe(text);
  });
});

describe('conversation projection: truncation at and above the bound', () => {
  it('does not truncate a message exactly at CONVERSATION_MESSAGE_MAX', () => {
    const { publisher, projection, agent } = harness();
    const prompt = 'a'.repeat(CONVERSATION_MESSAGE_MAX);
    projection.projectSubmitted(agent, { id: 'turn-1', submittedAt: Date.now(), prompt, source: 'feishu' });
    const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
    expect(message?.kind === 'teammate.turn.message' && message.content.length).toBe(CONVERSATION_MESSAGE_MAX);
    expect(message?.kind === 'teammate.turn.message' && message.content_truncated).toBe(false);
  });

  it('truncates a message one byte over CONVERSATION_MESSAGE_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const prompt = 'a'.repeat(CONVERSATION_MESSAGE_MAX + 1);
    projection.projectSubmitted(agent, { id: 'turn-1', submittedAt: Date.now(), prompt, source: 'feishu' });
    const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
    expect(message?.kind === 'teammate.turn.message' && message.content.length).toBe(CONVERSATION_MESSAGE_MAX);
    expect(message?.kind === 'teammate.turn.message' && message.content_truncated).toBe(true);
  });

  it('marks content_truncated when the runtime itself reports truncation, even under the bound', () => {
    const { publisher, projection, agent } = harness();
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: { kind: 'assistant.message', id: 'evt-1', text: 'short text', truncated: true },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const message = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.message')?.event;
    expect(message?.kind === 'teammate.turn.message' && message.content_truncated).toBe(true);
  });

  it('does not truncate a settled assistant result exactly at ASSISTANT_TEXT_MAX', () => {
    const { publisher, projection, agent } = harness();
    const resultText = 'b'.repeat(ASSISTANT_TEXT_MAX);
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };
    projection.projectSettled({
      agent,
      turn,
      settlement: { status: 'completed', resultText, truncated: false },
    });
    const settled = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.settled')?.event;
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant?.length).toBe(ASSISTANT_TEXT_MAX);
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant_truncated).toBe(false);
  });

  it('truncates a settled assistant result one byte over ASSISTANT_TEXT_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const resultText = 'b'.repeat(ASSISTANT_TEXT_MAX + 1);
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };
    projection.projectSettled({
      agent,
      turn,
      settlement: { status: 'completed', resultText, truncated: false },
    });
    const settled = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.settled')?.event;
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant?.length).toBe(ASSISTANT_TEXT_MAX);
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant_truncated).toBe(true);
  });

  it('marks assistant_truncated when the provider itself reported truncation, even under the text bound', () => {
    const { publisher, projection, agent } = harness();
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };
    projection.projectSettled({
      agent,
      turn,
      settlement: { status: 'completed', resultText: 'short', truncated: true },
    });
    const settled = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.settled')?.event;
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant_truncated).toBe(true);
  });

  it('does not truncate tool arguments exactly at CONVERSATION_TOOL_ARGUMENTS_MAX', () => {
    const { publisher, projection, agent } = harness();
    const args = 'c'.repeat(CONVERSATION_TOOL_ARGUMENTS_MAX);
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: {
        kind: 'tool.call',
        id: 'evt-1',
        callId: 'call-1',
        toolName: 'shell',
        action: 'run',
        status: 'completed',
        arguments: args,
        result: null,
        error: null,
      },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const toolEvent = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.tool_call')?.event;
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.arguments_json?.length).toBe(
      CONVERSATION_TOOL_ARGUMENTS_MAX,
    );
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.arguments_truncated).toBe(false);
  });

  it('truncates tool arguments one byte over CONVERSATION_TOOL_ARGUMENTS_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const args = 'c'.repeat(CONVERSATION_TOOL_ARGUMENTS_MAX + 1);
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: {
        kind: 'tool.call',
        id: 'evt-1',
        callId: 'call-1',
        toolName: 'shell',
        action: 'run',
        status: 'completed',
        arguments: args,
        result: null,
        error: null,
      },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const toolEvent = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.tool_call')?.event;
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.arguments_json?.length).toBe(
      CONVERSATION_TOOL_ARGUMENTS_MAX,
    );
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.arguments_truncated).toBe(true);
  });

  it('does not truncate a tool result exactly at CONVERSATION_TOOL_RESULT_MAX', () => {
    const { publisher, projection, agent } = harness();
    const result = 'd'.repeat(CONVERSATION_TOOL_RESULT_MAX);
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: {
        kind: 'tool.call',
        id: 'evt-1',
        callId: 'call-1',
        toolName: 'shell',
        action: 'run',
        status: 'completed',
        arguments: null,
        result,
        error: null,
      },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const toolEvent = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.tool_call')?.event;
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.result_json?.length).toBe(
      CONVERSATION_TOOL_RESULT_MAX,
    );
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.result_truncated).toBe(false);
  });

  it('truncates a tool result one byte over CONVERSATION_TOOL_RESULT_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const result = 'd'.repeat(CONVERSATION_TOOL_RESULT_MAX + 1);
    const activity: RuntimeActivityEvent = {
      submission: fakeSubmission(),
      occurredAt: Date.now(),
      activity: {
        kind: 'tool.call',
        id: 'evt-1',
        callId: 'call-1',
        toolName: 'shell',
        action: 'run',
        status: 'completed',
        arguments: null,
        result,
        error: null,
      },
    };
    projection.projectActivity(agent, { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' }, activity);
    const toolEvent = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.tool_call')?.event;
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.result_json?.length).toBe(
      CONVERSATION_TOOL_RESULT_MAX,
    );
    expect(toolEvent?.kind === 'teammate.turn.tool_call' && toolEvent.result_truncated).toBe(true);
  });

  it('a failed/stopped settlement carries no assistant text at all', () => {
    const { publisher, projection, agent } = harness();
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: 'go', source: 'feishu' };
    projection.projectSettled({ agent, turn, settlement: { status: 'failed' } });
    const settled = publisher.published.find((entry) => entry.event.kind === 'teammate.turn.settled')?.event;
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant).toBeNull();
    expect(settled?.kind === 'teammate.turn.settled' && settled.assistant_truncated).toBe(false);
  });
});

describe('conversation projection: bounded activity fact set', () => {
  it('deduplicates a repeated activity id on the same submission into exactly one publish', () => {
    const { publisher, projection, agent } = harness();
    const submission = fakeSubmission();
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' };
    const activity: RuntimeActivityEvent = {
      submission,
      occurredAt: Date.now(),
      activity: { kind: 'assistant.message', id: 'evt-dup', text: 'first', truncated: false },
    };
    projection.projectActivity(agent, turn, activity);
    projection.projectActivity(agent, turn, activity);

    const messages = publisher.published.filter((entry) => entry.event.kind === 'teammate.turn.message');
    expect(messages).toHaveLength(1);
  });

  it('drops activity beyond CONVERSATION_ACTIVITY_FACTS_MAX for one submission, warning exactly once', () => {
    const { publisher, warnCalls, projection, agent } = harness();
    const submission = fakeSubmission();
    const turn = { id: 'turn-1', submittedAt: Date.now(), prompt: null, source: 'feishu' };

    for (let i = 0; i < CONVERSATION_ACTIVITY_FACTS_MAX + 2; i += 1) {
      const activity: RuntimeActivityEvent = {
        submission,
        occurredAt: Date.now(),
        activity: { kind: 'assistant.message', id: `evt-${i}`, text: `msg ${i}`, truncated: false },
      };
      projection.projectActivity(agent, turn, activity);
    }

    const messages = publisher.published.filter((entry) => entry.event.kind === 'teammate.turn.message');
    expect(messages).toHaveLength(CONVERSATION_ACTIVITY_FACTS_MAX);
    expect(
      warnCalls.filter(
        (c) => c.message === 'Conversation projection activity fact set is full; dropping newest activity',
      ),
    ).toHaveLength(1);
  });
});
