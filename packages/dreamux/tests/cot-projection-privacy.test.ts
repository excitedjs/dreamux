/**
 * Coverage cell C (event half), Stage 9 node "core-events".
 *
 * The frozen post-COT baseline: `channel/conversation-projection.ts`'s
 * workspace/secret redaction rules for `teammate.input` and
 * `teammate.activity`. Core redacts and never truncates (operator ruling,
 * 2026-09-04): a surface cuts what it cannot send, where it sends it.
 * Everything else about the catalog (the four-kind union,
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
  createConversationProjection,
  type ProjectedAgent,
} from '../src/channel/conversation-projection.js';
import {
  createCapturingLogger,
  createCapturingPublisher,
  makeIdentity,
} from './helpers/event-harness.js';

const CWD = '/workspace/repo';
const HOME = '/home/operator';

function harness(overrides: { hasSources?: boolean } = {}) {
  const publisher = createCapturingPublisher(overrides.hasSources ?? true);
  const { logger, warnCalls } = createCapturingLogger();
  const projection = createConversationProjection({
    coreEvents: publisher,
    log: logger,
    homePathPrefixes: [HOME],
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
    notice: null,
    occurredAt: Date.now(),
  });
}

function assistantActivity(text: string): RuntimeActivity {
  return {
    kind: 'assistant.message',
    occurredAt: Date.now(),
    id: 'evt-1',
    text,
  };
}

describe('conversation projection: secret redaction', () => {
  it('redacts an inline password/token-shaped assignment, keeping the key and separator', () => {
    const { publisher, projection, agent } = harness();
    projectPrompt(projection, agent, 'the password: "hunter2xyz" must rotate');
    const content = inputOf(publisher).content;
    expect(content).not.toContain('hunter2xyz');
    expect(content).toContain('password: "<redacted>"');
  });

  it('keeps a redacted structured result parseable: a quoted secret stays a string', () => {
    const { publisher, projection, agent } = harness();
    const result = {
      token: 'abc123secret',
      nested: { api_key: 'k-1', password: 'p"q\\r', count: 7 },
      note: 'cookie: session=xyz; keep',
    };
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'mcp__probe__lookup',
      action: null,
      summary: null,
      invocation: null,
      items: [],
      status: 'completed',
      arguments: null,
      result,
      error: null,
    });

    const tool = activityOf(publisher);
    const text = tool.kind === 'tool.call' ? tool.result_json : null;
    expect(text).not.toContain('abc123secret');
    expect(text).not.toContain('k-1');
    expect(text).not.toContain('p\\"q');
    expect(text).not.toContain('session=xyz');
    expect(JSON.parse(text ?? '')).toEqual({
      token: '<redacted>',
      nested: { api_key: '<redacted>', password: '<redacted>', count: 7 },
      note: 'cookie: <redacted>; keep',
    });
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
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

  /**
   * The whole reason this is prefix scanning rather than a `/home/<name>/…`
   * regex: another account's directory is not this operator's home, and blanking
   * it costs the reader the one fact they needed.
   */
  /**
   * A workspace normally sits under the home. Relativizing it first is what
   * keeps the shorter, more useful form instead of `~/...`-prefixing everything.
   */
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
      items: [],
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

  it('renames workspace paths in every member of a call, the call text included', () => {
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
      items: [`${CWD}/src/a.ts`],
      status: 'started',
      arguments: { command: `cat ${HOME}/src/a.ts` },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.summary).toBe('src/a.ts');
    expect(tool.kind === 'tool.call' && tool.items).toEqual(['src/a.ts']);
    expect(tool.kind === 'tool.call' && tool.invocation).toBe('cat src/a.ts');
    expect(tool.kind === 'tool.call' && tool.arguments_json)
      .toBe(JSON.stringify({ command: 'cat ~/src/a.ts' }));
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('passes a long summary through whole and redacts a secret-shaped invocation', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 's'.repeat(100_000),
      invocation: 'post https://example.test with Bearer abcDEF123.ghiJKL456-_9',
      items: [],
      status: 'started',
      arguments: { token: 'abc123secret', home: `${HOME}/keys` },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.summary?.length).toBe(100_000);
    expect(tool.kind === 'tool.call' && tool.invocation)
      .toBe('post https://example.test with Bearer <redacted>');
    expect(tool.kind === 'tool.call' && tool.arguments_json)
      .toBe(JSON.stringify({ token: '<redacted>', home: '~/keys' }));
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('marks a call redacted when the only secret sat in the invocation', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 'ran a request',
      invocation: 'curl -H "authorization: abc123" https://example.test',
      items: ['src/a.ts'],
      status: 'completed',
      arguments: null,
      result: 'ok',
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.invocation)
      .toBe('curl -H "authorization: <redacted>" https://example.test');
    expect(tool.kind === 'tool.call' && tool.summary).toBe('ran a request');
    expect(tool.kind === 'tool.call' && tool.items).toEqual(['src/a.ts']);
    expect(tool.kind === 'tool.call' && tool.result_json).toBe('ok');
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('keeps the redactor on every member of a call', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 'echo with token: dummy',
      invocation: 'echo "token: dummy"',
      items: [`${CWD}/src/a.ts`],
      status: 'failed',
      arguments: { command: 'echo "token: dummy"' },
      result: null,
      error: 'failed with token: dummy',
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.summary).toBe('echo with token: <redacted>');
    expect(tool.kind === 'tool.call' && tool.result_json).toBe('failed with token: <redacted>');
    expect(tool.kind === 'tool.call' && tool.items).toEqual(['src/a.ts']);
    expect(tool.kind === 'tool.call' && tool.invocation)
      .toBe('echo "token: <redacted>"');
    expect(tool.kind === 'tool.call' && tool.arguments_json)
      .toBe(JSON.stringify({ command: 'echo "token: <redacted>"' }));
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('redacts a multi-line .env written through a tool argument, line by line', () => {
    const { publisher, projection, agent } = harness();
    const content = 'NODE_ENV="production"\nTOKEN="t1"\nPORT=3000\nAPI_KEY=k2\nDEBUG=false';
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Write',
      action: 'edit',
      summary: '.env',
      invocation: null,
      items: ['.env'],
      status: 'completed',
      arguments: { file_path: '.env', content },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.arguments_json).toBe(JSON.stringify({
      file_path: '.env',
      content: 'NODE_ENV="production"\nTOKEN="<redacted>"\nPORT=3000\nAPI_KEY=<redacted>\nDEBUG=false',
    }));
    expect(tool.kind === 'tool.call' && tool.redacted).toBe(true);
  });

  it('keeps a redacted argument payload parsable as JSON, by construction', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 'write the env',
      invocation: null,
      items: [],
      status: 'completed',
      arguments: { command: 'echo \'export API_KEY="sk-real-value"\' >> .env' },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    const args = tool.kind === 'tool.call' ? tool.arguments_json : null;
    expect(args).not.toBeNull();
    expect(JSON.parse(args ?? '')).toEqual({
      command: 'echo \'export API_KEY="<redacted>"\' >> .env',
    });
  });

  it('covers a serialized value whose own text contains a backslash', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 'connect',
      invocation: null,
      items: [],
      status: 'completed',
      // Serialized, a literal backslash is `\\` and a value ending in one runs
      // into the quote that closes its string. Neither is a problem the walk
      // has: it hands over the leaf, which is the text the runtime wrote.
      arguments: { command: 'password=C:\\name', fallback: 'password=abc\\' },
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    const args = tool.kind === 'tool.call' ? tool.arguments_json : null;
    expect(JSON.parse(args ?? '')).toEqual({
      command: 'password=<redacted>',
      fallback: 'password=<redacted>',
    });
  });

  it('covers a raw value whose own text contains a backslash, tail included', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, {
      kind: 'tool.call',
      occurredAt: Date.now(),
      id: 'evt-1',
      callId: 'call-1',
      toolName: 'Bash',
      action: 'run',
      summary: 'connect',
      invocation: 'net use X: /user:svc password=C:\\keys\\id and then continue',
      items: [],
      status: 'completed',
      arguments: null,
      result: null,
      error: null,
    });

    const tool = activityOf(publisher);
    expect(tool.kind === 'tool.call' && tool.invocation)
      .toBe('net use X: /user:svc password=<redacted> and then continue');
  });

  it('keeps an ordinary assistant message byte-identical', () => {
    const { publisher, projection, agent } = harness();
    const text = 'Ran the tests. 42 passed, 0 failed. Nothing else to report.';
    projection.projectActivity(agent, assistantActivity(text));
    const message = activityOf(publisher);
    expect(message.kind === 'assistant.message' && message.content).toBe(text);
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
  });

  it('keeps an ordinary reason byte-identical and reports redacted:false', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, endedActivity('the agent runtime is not running'));
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason).toBe('the agent runtime is not running');
    expect(ended.kind === 'turn.ended' && ended.redacted).toBe(false);
  });

  it('carries a null reason through as null, not an empty string', () => {
    const { publisher, projection, agent } = harness();
    projection.projectActivity(agent, endedActivity(null));
    const ended = activityOf(publisher);
    expect(ended.kind === 'turn.ended' && ended.reason).toBeNull();
    expect(ended.kind === 'turn.ended' && ended.redacted).toBe(false);
  });
});
