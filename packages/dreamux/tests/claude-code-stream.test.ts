/**
 * Unit tests for the pure Claude Code stream-json protocol model (issue #120).
 *
 * Synthetic envelope sequences only — hand-authored to the real wire shapes,
 * never captured from a live session — so no `claude` binary is needed.
 */

import { describe, expect, it } from 'vitest';

import {
  assistantText,
  buildCanUseToolAllow,
  buildControlAck,
  buildRemoteControlEnable,
  buildUserMessage,
  LineBuffer,
  parseLine,
  TurnAggregator,
} from '../src/agent-runtime/builtin/claude-code/stream.js';

describe('LineBuffer', () => {
  it('frames NDJSON across arbitrary chunk boundaries', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(buf.push('":2}\n')).toEqual(['{"b":2}']);
  });

  it('drops blank lines and strips trailing CR', () => {
    const buf = new LineBuffer();
    expect(buf.push('one\r\n\n\ntwo\n')).toEqual(['one', 'two']);
  });

  it('flush returns a trailing partial line once, then nothing', () => {
    const buf = new LineBuffer();
    buf.push('partial');
    expect(buf.flush()).toBe('partial');
    expect(buf.flush()).toBeNull();
  });
});

describe('parseLine', () => {
  it('parses a system/init envelope', () => {
    const line = parseLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x' }),
    );
    expect(line).toMatchObject({ kind: 'init', sessionId: 's1', model: 'claude-x' });
  });

  it('parses an assistant envelope, joining text blocks', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'Hello ' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'world' },
          ],
        },
      }),
    );
    expect(line.kind).toBe('assistant');
    if (line.kind === 'assistant') {
      expect(line.text).toBe('Hello world');
      expect(line.sessionId).toBe('s1');
    }
  });

  it('parses a success result envelope', () => {
    const line = parseLine(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'final', session_id: 's1' }),
    );
    expect(line.kind).toBe('result');
    if (line.kind === 'result') {
      expect(line.outcome).toMatchObject({
        subtype: 'success',
        isError: false,
        text: 'final',
        sessionId: 's1',
      });
    }
  });

  it('treats any non-success result subtype as an error', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 's1',
        errors: ['boom'],
      }),
    );
    if (line.kind === 'result') {
      expect(line.outcome.isError).toBe(true);
      expect(line.outcome.errors).toEqual(['boom']);
      expect(line.outcome.text).toBeNull();
    } else {
      throw new Error('expected result');
    }
  });

  it('trusts a success subtype even if is_error is true', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: 's1',
        result: 'hello',
      }),
    );
    if (line.kind === 'result') {
      expect(line.outcome.isError).toBe(false);
      expect(line.outcome.text).toBe('hello');
    } else {
      throw new Error('expected result');
    }
  });

  it('falls back to is_error when subtype is null', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'result',
        is_error: true,
        session_id: 's1',
      }),
    );
    if (line.kind === 'result') {
      expect(line.outcome.isError).toBe(true);
    } else {
      throw new Error('expected result');
    }
  });

  it('falls back to errors.length > 0 when subtype is null', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'result',
        session_id: 's1',
        errors: ['something went wrong'],
      }),
    );
    if (line.kind === 'result') {
      expect(line.outcome.isError).toBe(true);
    } else {
      throw new Error('expected result');
    }
  });

  it('parses a can_use_tool control_request', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'r1',
        request: { subtype: 'can_use_tool', input: { command: 'ls' } },
      }),
    );
    expect(line).toMatchObject({
      kind: 'control_request',
      requestId: 'r1',
      subtype: 'can_use_tool',
    });
  });

  it('parses a control_response success', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: { session_url: 'https://example.invalid/session/fake' },
        },
      }),
    );
    expect(line).toMatchObject({ kind: 'control_response', requestId: 'r1', ok: true });
    if (line.kind === 'control_response') {
      expect(line.response).toEqual({
        session_url: 'https://example.invalid/session/fake',
      });
    }
  });

  it('classifies unmodelled JSON as other and non-JSON as parse_error', () => {
    expect(parseLine(JSON.stringify({ type: 'stream_event', event: {} })).kind).toBe('other');
    expect(parseLine('not json').kind).toBe('parse_error');
    expect(parseLine('[1,2,3]').kind).toBe('parse_error');
  });
});

describe('TurnAggregator', () => {
  it('aggregates init + assistant + result into an outcome', () => {
    const agg = new TurnAggregator();
    agg.accept(parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })));
    agg.accept(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'snapshot' }] },
        }),
      ),
    );
    expect(agg.done).toBe(false);
    agg.accept(
      parseLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'final', session_id: 's1' })),
    );
    expect(agg.done).toBe(true);
    expect(agg.outcome()).toEqual({
      isError: false,
      text: 'final',
      sessionId: 's1',
      subtype: 'success',
      errors: [],
    });
  });

  it('falls back to the last assistant snapshot when result text is empty', () => {
    const agg = new TurnAggregator();
    agg.accept(
      parseLine(
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
        }),
      ),
    );
    agg.accept(parseLine(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' })));
    expect(agg.outcome()?.text).toBe('the answer');
  });

  it('uses the init session id when the result omits one', () => {
    const agg = new TurnAggregator();
    agg.accept(parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-init' })));
    agg.accept(parseLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })));
    expect(agg.outcome()?.sessionId).toBe('s-init');
  });

  it('returns null outcome before the result lands', () => {
    const agg = new TurnAggregator();
    agg.accept(parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })));
    expect(agg.outcome()).toBeNull();
  });
});

describe('outbound builders', () => {
  it('buildUserMessage produces a stream-json user line', () => {
    expect(JSON.parse(buildUserMessage('hi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
  });

  it('buildUserMessage omits isSynthetic / priority by default', () => {
    const parsed = JSON.parse(buildUserMessage('hi'));
    expect('isSynthetic' in parsed).toBe(false);
    expect('priority' in parsed).toBe(false);
  });

  it('buildUserMessage sets isSynthetic / priority as siblings of message', () => {
    const parsed = JSON.parse(
      buildUserMessage('done', { isSynthetic: true, priority: 'now' }),
    );
    expect(parsed).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'done' }] },
      isSynthetic: true,
      priority: 'now',
    });
  });

  it('buildCanUseToolAllow echoes the tool input back as updatedInput', () => {
    const parsed = JSON.parse(buildCanUseToolAllow('r1', { command: 'ls' }));
    expect(parsed).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { command: 'ls' } },
      },
    });
  });

  it('buildControlAck acknowledges with a bare success', () => {
    expect(JSON.parse(buildControlAck('r2'))).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r2', response: {} },
    });
  });

  it('buildRemoteControlEnable requests Claude Code Remote Control', () => {
    expect(JSON.parse(buildRemoteControlEnable('rc-1'))).toEqual({
      type: 'control_request',
      request_id: 'rc-1',
      request: { subtype: 'remote_control', enabled: true },
    });
  });

  it('assistantText handles string content and ignores non-text blocks', () => {
    expect(assistantText({ content: 'plain' })).toBe('plain');
    expect(assistantText({ content: [{ type: 'tool_use' }] })).toBe('');
    expect(assistantText(null)).toBe('');
  });
});
