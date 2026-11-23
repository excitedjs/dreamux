import { describe, expect, it } from 'vitest';

import {
  decodeNativeRecord,
  parseNativeRecord,
  userInputText,
} from '../src/transcript/records.js';

/**
 * Pure decoder tests against deterministic synthetic agy 1.5.15 record shapes.
 * No real transcripts, ids, credentials, or user content are used.
 */
describe('parseNativeRecord', () => {
  it('decodes a full PLANNER_RESPONSE with text, thinking and tool calls', () => {
    const record = parseNativeRecord(
      JSON.stringify({
        step_index: 7,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-23T15:53:33Z',
        thinking: 'synthetic reasoning',
        content: 'synthetic answer',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: 'echo synthetic' } },
          { name: 'read_file', args: '{"Path":"/synthetic"}' },
        ],
      }),
    );

    expect(record).toEqual({
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      stepIndex: 7,
      occurredAt: Date.parse('2026-11-23T15:53:33Z'),
      content: 'synthetic answer',
      thinking: 'synthetic reasoning',
      id: null,
      toolCalls: [
        {
          id: null,
          name: 'run_command',
          args: { CommandLine: 'echo synthetic' },
        },
        { id: null, name: 'read_file', args: '{"Path":"/synthetic"}' },
      ],
    });
  });

  it('returns null for blank, malformed, and non-object lines without throwing', () => {
    expect(parseNativeRecord('')).toBeNull();
    expect(parseNativeRecord('   \n')).toBeNull();
    expect(parseNativeRecord('{not json')).toBeNull();
    expect(parseNativeRecord('["synthetic", "array"]')).toBeNull();
    expect(parseNativeRecord('"synthetic string"')).toBeNull();
    expect(parseNativeRecord('42')).toBeNull();
  });

  it('normalizes absent or invalid optional fields without inventing facts', () => {
    const record = parseNativeRecord(JSON.stringify({ type: 'CHECKPOINT' }));
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      type: 'CHECKPOINT',
      source: null,
      status: null,
      occurredAt: null,
      content: null,
      thinking: null,
      id: null,
      toolCalls: [],
    });
    expect(record?.stepIndex).toBeUndefined();
  });

  it('keeps stepIndex absent unless the native value is a safe integer', () => {
    expect(
      decodeNativeRecord({ type: 'GENERIC', step_index: '3' }).stepIndex,
    ).toBeUndefined();
    expect(
      decodeNativeRecord({ type: 'GENERIC', step_index: 1.5 }).stepIndex,
    ).toBeUndefined();
    expect(
      decodeNativeRecord({ type: 'GENERIC', step_index: 9 }).stepIndex,
    ).toBe(9);
  });

  it('treats an unparseable created_at as null and preserves a native top-level id', () => {
    const record = decodeNativeRecord({
      type: 'TURN_INTERRUPTED',
      created_at: 'not a timestamp',
      id: 'synthetic-interrupt-id',
    });
    expect(record.occurredAt).toBeNull();
    expect(record.id).toBe('synthetic-interrupt-id');
  });

  it('skips non-object tool call entries and preserves their native ids', () => {
    const record = decodeNativeRecord({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { id: 'call-synthetic-1', name: 'search_files', args: {} },
        'synthetic-string-entry',
        null,
        { name: '' },
      ],
    });
    expect(record.toolCalls).toEqual([
      { id: 'call-synthetic-1', name: 'search_files', args: {} },
      { id: null, name: '', args: undefined },
    ]);
  });

  it('preserves unknown future native type names verbatim', () => {
    const record = decodeNativeRecord({ type: 'FUTURE_NATIVE_TYPE' });
    expect(record.type).toBe('FUTURE_NATIVE_TYPE');
  });
});

describe('userInputText', () => {
  function inputRecord(content: string) {
    return decodeNativeRecord({ type: 'USER_INPUT', content });
  }

  it('unwraps the native USER_REQUEST envelope and drops metadata', () => {
    const text = userInputText(
      inputRecord(
        '<USER_REQUEST>\nsynthetic prompt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
      ),
    );
    expect(text).toBe('synthetic prompt');
  });

  it('uses the last close marker when the payload contains the literal tag', () => {
    const text = userInputText(
      inputRecord(
        '<USER_REQUEST>explain the literal </USER_REQUEST> string\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>',
      ),
    );
    expect(text).toBe('explain the literal </USER_REQUEST> string');
  });

  it('returns the raw content when the envelope is absent', () => {
    const text = userInputText(inputRecord('raw synthetic input'));
    expect(text).toBe('raw synthetic input');
  });

  it('returns null outside USER_INPUT records or without string content', () => {
    expect(
      userInputText(decodeNativeRecord({ type: 'PLANNER_RESPONSE' })),
    ).toBeNull();
    expect(
      userInputText(decodeNativeRecord({ type: 'USER_INPUT' })),
    ).toBeNull();
  });
});
