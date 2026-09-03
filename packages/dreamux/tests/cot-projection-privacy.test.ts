/**
 * Coverage cell C (event half), Stage 9 node "core-events".
 *
 * The frozen post-COT baseline: `channel/conversation-projection.ts`'s
 * workspace/secret redaction and truncation rules for `teammate.input` and
 * `teammate.activity`. Everything else about the catalog (the four-kind union,
 * live delivery, team.state/teammate.state) lives in
 * `tests/core-event-catalog.test.ts`.
 *
 * "Visible after redaction remain unchanged" is tested directly: content with
 * no secret/path shape must survive byte-for-byte, not be narrowed to any
 * smaller presentation. Path handling is held to the stricter reading of that
 * rule — a path is *renamed* to the form the operator's own shell prints, and a
 * path that only resembles this host's home is left entirely alone.
 */
import { describe, expect, it } from 'vitest';

import type {
  RuntimeActivity,
  TeammateActivity,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';

import {
  CONVERSATION_MESSAGE_MAX,
  CONVERSATION_TOOL_ARGUMENTS_MAX,
  CONVERSATION_TOOL_RESULT_MAX,
  CONVERSATION_TOOL_SUMMARY_MAX,
  createConversationProjection,
  redactText,
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
  const projection = createConversationProjection({
    coreEvents: publisher,
    log: logger,
    homePathPrefixes: [],
  });
  const identity = makeIdentity({ team_id: 'alpha', name: 'scout', cwd: CWD });
  const agent: ProjectedAgent = { identity, role: 'teammate' };
  return { publisher, warnCalls, projection, agent };
}

/** The one `teammate.input` this projection published. */
function inputOf(
  publisher: ReturnType<typeof createCapturingPublisher>,
): TeammateInputEvent {
  const event = publisher.published.find((entry) => entry.event.kind === 'teammate.input')?.event;
  if (event?.kind !== 'teammate.input') throw new Error('expected a projected input event');
  return event;
}

/** The one `teammate.activity` payload this projection published. */
function activityOf(
  publisher: ReturnType<typeof createCapturingPublisher>,
): TeammateActivity {
  const event = publisher.published.find((entry) => entry.event.kind === 'teammate.activity')?.event;
  if (event?.kind !== 'teammate.activity') throw new Error('expected a projected activity event');
  return event.activity;
}

function projectPrompt(
  projection: ReturnType<typeof createConversationProjection>,
  agent: ProjectedAgent,
  text: string,
): void {
  projection.projectInput(agent, {
    source: 'feishu',
    sourceId: null,
    text,
    occurredAt: Date.now(),
  });
}

function assistantActivity(
  text: string,
  truncated = false,
): RuntimeActivity {
  return {
    kind: 'assistant.message',
    occurredAt: Date.now(),
    id: 'evt-1',
    text,
    truncated,
  };
}

describe('conversation projection: secret redaction', () => {
  it('redacts an inline password/token-shaped assignment, keeping the key and separator', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'the password: "hunter2xyz" must rotate');
    const content = inputOf(publisher).content;
    expect(content).not.toContain('hunter2xyz');
    expect(content).toContain('password: <redacted>');
  });

  it('redacts an inline api_key= assignment', () => {
    const { publisher, projection, agent } = harness();
    const fakeSecret = ['sk', 'live', 'abcdef1234567890'].join('_');
    projectPrompt(projection, agent, `set api_key=${fakeSecret} in env`);
    const content = inputOf(publisher).content;
    expect(content).not.toContain(fakeSecret);
    expect(content).toContain('api_key=<redacted>');
  });

  it('redacts an authorization: value pair', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'authorization: mySecretToken123abc grants access');
    const content = inputOf(publisher).content;
    expect(content).not.toContain('mySecretToken123abc');
    expect(content).toContain('authorization: <redacted>');
  });

  it('redacts a bare Bearer token', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'call it with Bearer abcDEF123.ghiJKL456-_9');
    const content = inputOf(publisher).content;
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
    projectPrompt(projection, agent, `session ${jwt} end`);
    const content = inputOf(publisher).content;
    expect(content).not.toContain(jwt);
    expect(content).toContain('<redacted-jwt>');
  });

  it('redacts an AWS-style access key', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'key AKIAABCDEFGHIJKLMN in use');
    const content = inputOf(publisher).content;
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
    projectPrompt(projection, agent, `here is the key:\n${pem}\nend`);
    const content = inputOf(publisher).content;
    expect(content).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDExampleKeyData');
    expect(content).toContain('<redacted-private-key>');
  });

  it('relativizes an entity workspace path to a repo-relative one', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, `file at ${CWD}/secrets/env.local was read`);
    const content = inputOf(publisher).content;
    expect(content).not.toContain(CWD);
    expect(content).toBe('file at secrets/env.local was read');
  });

  it('renders the bare workspace itself as a dot', () => {
    expect(redactText(`ran in ${CWD} today`, CWD, []).value).toBe('ran in . today');
  });

  it('renames this host home to ~, keeping the rest of the path legible', () => {
    expect(redactText('key at /home/me/.ssh/id_rsa now', '', ['/home/me']).value)
      .toBe('key at ~/.ssh/id_rsa now');
  });

  it('renames a Windows home the same way', () => {
    const home = 'C:\\Users\\me';
    expect(redactText(`backup at ${home}\\notes.txt now`, '', [home]).value)
      .toBe('backup at ~\\notes.txt now');
  });

  it('renames the bare home with no path after it', () => {
    expect(redactText('cd /home/me and stop', '', ['/home/me']).value)
      .toBe('cd ~ and stop');
  });

  it('renames a home prefix at the head of a file URL', () => {
    expect(redactText('open file:///home/me/x', '', ['/home/me']).value)
      .toBe('open file://~/x');
  });

  it('renames a bare home before ordinary closing punctuation', () => {
    const value =
      'paths /home/me. /home/me, /home/me; /home/me: (/home/me) [/home/me] "/home/me"';
    expect(redactText(value, '', ['/home/me']).value).toBe(
      'paths ~. ~, ~; ~: (~) [~] "~"',
    );
  });

  it('treats a trailing period as prose punctuation for home and workspace paths', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`see ${home}. edit ${cwd}/a.ts.`, cwd, [home]).value,
    ).toBe('see ~. edit a.ts.');
  });

  it('distinguishes dot-suffixed home siblings from workspace-adjacent siblings', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    const value = [
      `${home}.bak/notes.md`,
      `${home}.git/config`,
      `${cwd}.bak/notes.md`,
      `${cwd}.git/config`,
    ].join(' ');
    expect(redactText(value, cwd, [home]).value).toBe([
      `${home}.bak/notes.md`,
      `${home}.git/config`,
      '~/work/repo.bak/notes.md',
      '~/work/repo.git/config',
    ].join(' '));
  });

  it('renames workspace-adjacent siblings through the containing home prefix', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`${cwd}.git/config ${cwd}-old/x`, cwd, [home]).value,
    ).toBe('~/work/repo.git/config ~/work/repo-old/x');
  });

  it('does not treat a doubled filesystem separator as a URL scheme boundary', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    const value = `/mnt/backup/${home}/x /mnt/backup/${cwd}/x`;
    expect(redactText(value, cwd, [home]).value).toBe(value);
  });

  /**
   * The whole reason this is prefix scanning rather than a `/home/<name>/…`
   * regex: another account's directory is not this operator's home, and blanking
   * it costs the reader the one fact they needed.
   */
  it('leaves a path that merely starts with the same characters alone', () => {
    const value =
      'compare /home/mexyz and /home/me-old/notes.txt with /home/meredith/notes.txt';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('leaves a home-shaped fragment that is not rooted alone', () => {
    const value = 'the string not/home/me/x is not a path here';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('does not treat a foreign home-shaped path as this host home', () => {
    const value = 'their build ran in /home/someoneelse/repo';
    expect(redactText(value, '', ['/home/me']).value).toBe(value);
  });

  it('prefers the longest matching home prefix', () => {
    expect(
      redactText('at /home/me/nested/file.ts', '', ['/home/me/nested', '/home/me']).value,
    ).toBe('at ~/file.ts');
  });

  /**
   * A workspace normally sits under the home. Relativizing it first is what
   * keeps the shorter, more useful form instead of `~/...`-prefixing everything.
   */
  it('relativizes the workspace before renaming the home it sits under', () => {
    const home = '/home/me';
    const cwd = `${home}/work/repo`;
    expect(
      redactText(`edited ${cwd}/src/a.ts and ${home}/.config/x`, cwd, [home]).value,
    ).toBe('edited src/a.ts and ~/.config/x');
  });

  it('keeps workspace renaming when no host home prefix was resolved', () => {
    const cwd = '/workspace/repo';
    expect(
      redactText(`work in ${cwd}; leave /home/me/x alone`, cwd, []).value,
    ).toBe('work in .; leave /home/me/x alone');
  });

  it('reports redacted:false when a path rule found nothing to rename', () => {
    expect(redactText('nothing to rename here', '/workspace/repo', ['/home/me']).redacted)
      .toBe(false);
  });

  it('marks redacted:true only when a rule actually fired, false for ordinary text', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'nothing sensitive here at all');
    expect(inputOf(publisher).redacted).toBe(false);
  });
});

describe('conversation projection: content visible after redaction is unchanged, not narrowed', () => {
  it('keeps tool call arguments and results byte-identical when nothing is secret- or path-shaped', () => {
    const { publisher, projection, agent } = harness();
    const args = { file: 'report.md', count: 3, tags: ['alpha', 'beta'], nested: { ok: true } };
    const result = { status: 'ok', rows: [10, 20, 30], summary: 'no issues found' };
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'read_file',
      action: 'read',
      summary: null,
      invocation: null,
      status: 'completed',
      arguments: args,
      result,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.arguments_json).toBe(JSON.stringify(args));
    expect(tool.kind === 'tool.call' && tool.result_json).toBe(JSON.stringify(result));
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(false);
  });

  it('renames workspace paths inside the tool summary and invocation, like every other payload', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: `${CWD}/src/a.ts`,
      invocation: `cat ${CWD}/src/a.ts`,
      status: 'started',
      arguments: { command: `cat ${CWD}/src/a.ts` },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.summary).toBe('src/a.ts');
    expect(tool.kind === 'tool.call' && tool.invocation).toBe('cat src/a.ts');
    expect(tool.kind === 'tool.call' && tool.summary_truncated).toBe(false);
    expect(tool.kind === 'tool.call' && tool.invocation_truncated).toBe(false);
  });

  it('bounds the tool summary at CONVERSATION_TOOL_SUMMARY_MAX and folds a redacted invocation into redacted', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 's'.repeat(CONVERSATION_TOOL_SUMMARY_MAX + 1),
      invocation: 'post https://example.test with Bearer abcDEF123.ghiJKL456-_9',
      status: 'started',
      arguments: null,
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.summary?.length).toBe(CONVERSATION_TOOL_SUMMARY_MAX);
    expect(tool.kind === 'tool.call' && tool.summary_truncated).toBe(true);
    expect(tool.kind === 'tool.call' && tool.invocation).toBe('post https://example.test with Bearer <redacted>');
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('keeps an ordinary assistant message byte-identical', () => {
    const { publisher, projection, agent } = harness();
    const text = 'Ran the tests. 42 passed, 0 failed. Nothing else to report.';
    projection.projectActivity(agent, assistantActivity(text));
    const message = activityOf(publisher);
    expect(message.kind === 'assistant.message' && message.content).toBe(text);
  });
});

describe('conversation projection: truncation at and above the bound', () => {
  it('does not truncate a message exactly at CONVERSATION_MESSAGE_MAX', () => {
    const { publisher, projection, agent } = harness();
    const prompt = 'a'.repeat(CONVERSATION_MESSAGE_MAX);
    projectPrompt(projection, agent, prompt);
    const event = inputOf(publisher);
    expect(event.content.length).toBe(CONVERSATION_MESSAGE_MAX);
    expect(event.content_truncated).toBe(false);
  });

  it('truncates a message one byte over CONVERSATION_MESSAGE_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const prompt = 'a'.repeat(CONVERSATION_MESSAGE_MAX + 1);
    projectPrompt(projection, agent, prompt);
    const event = inputOf(publisher);
    expect(event.content.length).toBe(CONVERSATION_MESSAGE_MAX);
    expect(event.content_truncated).toBe(true);
  });

  it('marks content_truncated when the runtime itself reports truncation, even under the bound', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, assistantActivity('short text', true));
    const message = activityOf(publisher);
    expect(message.kind === 'assistant.message' && message.content_truncated).toBe(true);
  });

  it('does not truncate tool arguments exactly at CONVERSATION_TOOL_ARGUMENTS_MAX', () => {
    const { publisher, projection, agent } = harness();
    const args = 'c'.repeat(CONVERSATION_TOOL_ARGUMENTS_MAX);
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'shell',
      action: 'run',
      summary: null,
      invocation: null,
      status: 'completed',
      arguments: args,
      result: null,
      error: null,
    });
    const toolEvent = activityOf(publisher);
    expect(toolEvent.kind === 'tool.call' && toolEvent.arguments_json?.length).toBe(
      CONVERSATION_TOOL_ARGUMENTS_MAX,
    );
    expect(toolEvent.kind === 'tool.call' && toolEvent.arguments_truncated).toBe(false);
  });

  it('truncates tool arguments one byte over CONVERSATION_TOOL_ARGUMENTS_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const args = 'c'.repeat(CONVERSATION_TOOL_ARGUMENTS_MAX + 1);
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'shell',
      action: 'run',
      summary: null,
      invocation: null,
      status: 'completed',
      arguments: args,
      result: null,
      error: null,
    });
    const toolEvent = activityOf(publisher);
    expect(toolEvent.kind === 'tool.call' && toolEvent.arguments_json?.length).toBe(
      CONVERSATION_TOOL_ARGUMENTS_MAX,
    );
    expect(toolEvent.kind === 'tool.call' && toolEvent.arguments_truncated).toBe(true);
  });

  it('does not truncate a tool result exactly at CONVERSATION_TOOL_RESULT_MAX', () => {
    const { publisher, projection, agent } = harness();
    const result = 'd'.repeat(CONVERSATION_TOOL_RESULT_MAX);
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'shell',
      action: 'run',
      summary: null,
      invocation: null,
      status: 'completed',
      arguments: null,
      result,
      error: null,
    });
    const toolEvent = activityOf(publisher);
    expect(toolEvent.kind === 'tool.call' && toolEvent.result_json?.length).toBe(
      CONVERSATION_TOOL_RESULT_MAX,
    );
    expect(toolEvent.kind === 'tool.call' && toolEvent.result_truncated).toBe(false);
  });

  it('truncates a tool result one byte over CONVERSATION_TOOL_RESULT_MAX to exactly the bound', () => {
    const { publisher, projection, agent } = harness();
    const result = 'd'.repeat(CONVERSATION_TOOL_RESULT_MAX + 1);
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'shell',
      action: 'run',
      summary: null,
      invocation: null,
      status: 'completed',
      arguments: null,
      result,
      error: null,
    });
    const toolEvent = activityOf(publisher);
    expect(toolEvent.kind === 'tool.call' && toolEvent.result_json?.length).toBe(
      CONVERSATION_TOOL_RESULT_MAX,
    );
    expect(toolEvent.kind === 'tool.call' && toolEvent.result_truncated).toBe(true);
  });
});

describe('conversation projection: the turn.ended reason', () => {
  function endedActivity(reason: string | null): RuntimeActivity {
    return { kind: 'turn.ended', occurredAt: Date.now(), status: 'failed', reason };
  }

  it('redacts and relativizes the reason, which carries a raw provider error message', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(
      agent,
      endedActivity(`spawn ${CWD}/bin/agent failed: authorization: tok3nAbcDef123`),
    );
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason).toBe(
      'spawn bin/agent failed: authorization: <redacted>',
    );
    expect(ended.kind === 'turn.ended' && ended.redacted).toBe(true);
    expect(ended.kind === 'turn.ended' && ended.reason_truncated).toBe(false);
  });

  it('keeps an ordinary reason byte-identical and reports redacted:false', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, endedActivity('the agent runtime is not running'));
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason).toBe('the agent runtime is not running');
    expect(ended.kind === 'turn.ended' && ended.redacted).toBe(false);
  });

  it('bounds the reason by CONVERSATION_MESSAGE_MAX, as a provider message has no length the runtime owes us', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, endedActivity('e'.repeat(CONVERSATION_MESSAGE_MAX + 1)));
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason?.length).toBe(CONVERSATION_MESSAGE_MAX);
    expect(ended.kind === 'turn.ended' && ended.reason_truncated).toBe(true);
  });

  it('carries a null reason through as null, not an empty string', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, endedActivity(null));
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason).toBeNull();
    expect(ended.kind === 'turn.ended' && ended.reason_truncated).toBe(false);
    expect(ended.kind === 'turn.ended' && ended.redacted).toBe(false);
  });
});
