/**
 * What a tool row sends to Feishu, from what the runtime said about the call.
 *
 * Wire shapes follow the COT Message Brief (`TOOL_CALL_START` with `icon` and
 * `title`; `TOOL_CALL_RESULT` segments `{type:'text', text}`,
 * `{type:'code', language, code}` and `{type:'list', items, more?}`).
 *
 * An expanded row reads in the order it happened: what was asked as one code
 * segment, a divider, then what came back. What came back is shown by
 * what it is, not by how long it is: a value that parses as JSON is
 * pretty-printed in a `json` code segment, anything else is plain text
 * (operator ruling, 2026-09-04). Plain text keeps ten content lines; every
 * result remains bounded by Feishu's per-event content limit.
 */

import { describe, expect, it } from 'vitest';

import type { TeammateActivity } from '@excitedjs/dreamux-types';

import {
  toolCallResultEvents,
  toolResultOutput,
  toolCallStartEvents,
} from '../src/feishu-cot-events.js';

type ToolCall = Extract<TeammateActivity, { kind: 'tool.call' }>;

function toolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    kind: 'tool.call',
    event_id: 'event-1',
    call_id: 'call-1',
    tool_name: 'Bash',
    tool_action: 'run',
    summary: null,
    invocation: null,
    items: [],
    status: 'started',
    arguments_json: null,
    result_json: null,
    redacted: false,
    ...overrides,
  };
}

function eventTypes(events: ReadonlyArray<{ eventType: string }>): string[] {
  return events.map((event) => event.eventType);
}

/**
 * The divider stands between the call and what came back, as its own segment.
 */
const RESULT = { type: 'text', text: '\n\n---' };

/** The segments of one `TOOL_CALL_RESULT`, whether it sent one or many. */
function segmentsOf(event: { content: unknown }): unknown {
  return (event.content as { content: unknown }).content;
}

describe('runtime-labelled tool rows', () => {
  it('titles a run row with the runtime summary, icons it, and sends no raw arguments', () => {
    const events = toolCallStartEvents(toolCall({
      summary: 'Show working tree status',
      invocation: 'git status --short',
      arguments_json: '{"command":"git status --short","description":"Show working tree status"}',
    }));
    expect(eventTypes(events)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END']);
    expect(events[0]!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: 'Bash',
      icon: 'bash',
      title: 'Show working tree status',
    });
  });

  it('uses decoded display facts rather than raw wrapped arguments for the title and invocation', () => {
    const call = toolCall({
      tool_name: 'exec_command',
      summary: 'node --check script.mjs',
      invocation: 'node --check script.mjs\necho done',
      arguments_json: JSON.stringify("/usr/bin/zsh -lc 'node --check script.mjs\necho done'"),
    });
    const [start] = toolCallStartEvents(call);
    expect(start!.content).toMatchObject({ icon: 'bash', title: 'node --check script.mjs' });
    const [result] = toolCallResultEvents({ ...call, status: 'completed', result_json: 'done' });
    expect(result!.content).toMatchObject({
      content: [
        { type: 'code', language: 'bash', code: 'node --check script.mjs\necho done' },
        RESULT,
        { type: 'text', text: 'done' },
      ],
    });
  });

  it('leads a read row with a verb and the read icon', () => {
    const [start] = toolCallStartEvents(toolCall({
      tool_name: 'Read',
      tool_action: 'read',
      summary: 'src/a.ts',
    }));
    expect(start!.content).toMatchObject({ toolCallName: 'Read', icon: 'read', title: 'Read src/a.ts' });
  });

  it('leads a listing row with List and the search icon', () => {
    const [start] = toolCallStartEvents(toolCall({
      tool_name: 'Bash',
      tool_action: 'list_files',
      summary: 'src',
    }));
    expect(start!.content).toMatchObject({ toolCallName: 'List', icon: 'search', title: 'List src' });
  });

  it('titles a row the runtime labelled but named no action for with that label alone', () => {
    const [start] = toolCallStartEvents(toolCall({
      tool_name: 'Skill',
      tool_action: null,
      summary: 'team-workflow',
    }));
    // No `Skill: ` prefix: the label is already a whole label, and the row
    // shows the tool's name beside it anyway.
    expect(start!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: 'Skill',
      title: 'team-workflow',
    });
  });

  it('names a call nothing could label by its whole name, behind the generic app icon', () => {
    const events = toolCallStartEvents(toolCall({
      tool_name: 'mcp__other__thing',
      tool_action: null,
      arguments_json: '{"x":1}',
    }));
    // The name as the runtime spelled it: the leaf alone loses which server a
    // foreign tool came from, and two servers may offer the same leaf.
    expect(eventTypes(events)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END']);
    expect(events[0]!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: 'mcp__other__thing',
      icon: 'app-default_outlined',
    });
  });

  it('spells out a long name rather than cutting it at a length of its own', () => {
    const toolName = `mcp__${'server-with-a-long-name'.repeat(3)}__do_the_thing`;
    expect(toolName.length).toBeGreaterThan(80);
    const [start] = toolCallStartEvents(toolCall({ tool_name: toolName, tool_action: null }));
    expect(start!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: toolName,
      icon: 'app-default_outlined',
    });
  });


  it("presents the Channel's own tools by the same rule as any other MCP tool", () => {
    for (const toolName of ['mcp__chan-cot__reply', 'channel-chan-cot.react', 'feishu.list_chat_bots']) {
      const [start] = toolCallStartEvents(toolCall({
        tool_name: toolName,
        tool_action: null,
        arguments_json: '{"chat_id":"oc_1","text":"hi"}',
      }));
      expect(start!.content).toEqual({
        toolCallId: expect.any(String),
        toolCallName: toolName,
        icon: 'app-default_outlined',
      });
    }
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'mcp__chan-cot__reply',
      tool_action: null,
      status: 'completed',
      arguments_json: '{"chat_id":"oc_1","text":"hi"}',
      result_json: '{"message_ids":["om_1"]}',
    }));
    // No fixed Completed line: a tool with no notation of its own shows its
    // whole structured input as JSON, and the output expands like any other
    // tool's — also a structured value, so also pretty-printed.
    expect(segmentsOf(result!)).toEqual([
      {
        type: 'code',
        language: 'json',
        code: '{\n  "chat_id": "oc_1",\n  "text": "hi"\n}',
      },
      RESULT,
      { type: 'code', language: 'json', code: '{\n  "message_ids": [\n    "om_1"\n  ]\n}' },
    ]);
  });

  it('expands a result into the invocation as a code segment and a text output as text', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      summary: 'Show working tree status',
      invocation: 'git status --short',
      result_json: ' M src/a.ts\n?? src/b.ts',
    }));
    expect(result!.content).toMatchObject({
      role: 'tool',
      content: [
        { type: 'code', language: 'bash', code: 'git status --short' },
        RESULT,
        // The leading space is a no-break space: the client drops an ordinary one.
        { type: 'text', text: '\u00a0M src/a.ts\n?? src/b.ts' },
      ],
    });
  });

  it('keeps the indentation and column alignment of a text output with no-break spaces', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      result_json: [
        'DIST_TAGS={',
        '  "latest": "0.23.0"',
        '}',
        'drwxr-xr-x  2 me  4096 src',
        'a single space between words stays a space',
      ].join('\n'),
    }));
    // Each space that begins a line or sits in a run of two or more becomes
    // U+00A0; the single spaces stay, so a long line still wraps at them.
    expect(segmentsOf(result!)).toEqual([
      RESULT,
      {
        type: 'text',
        text: [
          'DIST_TAGS={',
          '\u00a0\u00a0"latest": "0.23.0"',
          '}',
          'drwxr-xr-x\u00a0\u00a02 me\u00a0\u00a04096 src',
          'a single space between words stays a space',
        ].join('\n'),
      },
    ]);
  });

  it('measures the cut after the spaces were converted', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      result_json: '  x\n'.repeat(3_000),
    }));
    const shown = (segmentsOf(result!) as Array<{ type: string; text: string }>)[1]!;
    expect(shown.text.startsWith('\u00a0\u00a0x\n')).toBe(true);
    expect(shown.text.endsWith('… (truncated)')).toBe(true);
    // Two bytes per converted space, counted inside the event limit.
    expect(Buffer.byteLength(JSON.stringify(result!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });

  it.each(['', 'one', ...['\n', '\r\n'].flatMap((separator) => {
    const ten = Array.from({ length: 10 }, (_, i) => `line-${i}`).join(separator);
    return [ten, ten + separator];
  })])('keeps at most ten content lines unchanged: %j', (output) => {
    expect(toolResultOutput(output)).toEqual(output === '' ? null : { kind: 'text', text: output });
  });

  it.each(['\n', '\r\n'])('cuts the eleventh content line, including an empty one, with %j', (separator) => {
    const ten = Array.from({ length: 10 }, (_, i) => `line-${i}`).join(separator);
    for (const eleventh of ['line-eleven', separator]) {
      const [event] = toolCallResultEvents(toolCall({
        status: 'completed', result_json: ten + separator + eleventh,
      }));
      expect(segmentsOf(event!)).toEqual([
        RESULT,
        { type: 'text', text: ten + separator + '… (truncated)' },
      ]);
    }
  });

  it.each([Array.from({ length: 12 }, (_, i) => i), { values: Array.from({ length: 12 }, (_, i) => i) }])(
    'keeps all lines of a JSON object or array', (value) => {
      const [event] = toolCallResultEvents(toolCall({ status: 'completed', result_json: JSON.stringify(value) }));
      expect(segmentsOf(event!)).toEqual([
        RESULT,
        { type: 'code', language: 'json', code: JSON.stringify(value, null, 2) },
      ]);
    },
  );

  it('treats a JSON scalar with multiline whitespace as text and cuts its source lines', () => {
    const scalar = '42' + '\n'.repeat(11);
    expect(JSON.parse(scalar)).toBe(42);
    expect(toolResultOutput(scalar)).toEqual({ kind: 'text', text: '42' + '\n'.repeat(10) + '… (truncated)' });
  });

  it.each([
    '  ' + '界'.repeat(2_000) + '\nshort'.repeat(10),
    JSON.stringify({ values: Array.from({ length: 12 }, () => '界'.repeat(1_000)) }),
  ])('still applies the event byte limit after classification and line cutting', (output) => {
    const [event] = toolCallResultEvents(toolCall({ status: 'completed', result_json: output }));
    const shown = (segmentsOf(event!) as Array<{ text?: string; code?: string }>)[1]!;
    expect(shown.text ?? shown.code).toContain('… (truncated)');
    expect(Buffer.byteLength(JSON.stringify(event!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });

  it('pretty-prints an output that parses as JSON in a json code segment, its spaces untouched', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'mcp__teammate__spawn',
      tool_action: null,
      status: 'completed',
      result_json: '{"teammate":{"name":"tm-1","status":"running"},"status":"submitted"}',
    }));
    expect(segmentsOf(result!)).toEqual([
      RESULT,
      {
        type: 'code',
        language: 'json',
        code: [
          '{',
          '  "teammate": {',
          '    "name": "tm-1",',
          '    "status": "running"',
          '  },',
          '  "status": "submitted"',
          '}',
        ].join('\n'),
      },
    ]);
  });

  it('shows an output that is not a JSON object or array as text, a bare scalar included', () => {
    for (const output of ['42', 'true', 'ok', '{"unterminated": 1']) {
      const [result] = toolCallResultEvents(toolCall({ status: 'completed', result_json: output }));
      expect(segmentsOf(result!)).toEqual([RESULT, { type: 'text', text: output }]);
    }
  });

  it("cuts a long single-line output at Feishu's per-event content limit, with the marker", () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      result_json: 'x'.repeat(10_000),
    }));
    const shown = (segmentsOf(result!) as Array<{ type: string; text: string }>)[1]!;
    expect(shown.type).toBe('text');
    expect(shown.text.endsWith('… (truncated)')).toBe(true);
    // Past the old 1,024-byte soft cap, inside the 4,096-byte event limit.
    expect(Buffer.byteLength(shown.text, 'utf8')).toBeGreaterThan(1_024);
    expect(Buffer.byteLength(JSON.stringify(result!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });

  it("passes a long title through whole and cuts it only at the event limit", () => {
    const long = 'Run the whole suite '.repeat(40).trim();
    const [start] = toolCallStartEvents(toolCall({ summary: long }));
    expect(start!.content).toMatchObject({ title: long });
    const [huge] = toolCallStartEvents(toolCall({ summary: 't'.repeat(10_000) }));
    const title = (huge!.content as { title: string }).title;
    expect(title.endsWith('… (truncated)')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(huge!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });

  it('shows the files a read was about as pills, and nothing else', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'Read',
      tool_action: 'read',
      status: 'completed',
      summary: 'src/a.ts',
      items: ['src/a.ts'],
      result_json: 'export const a = 1;',
    }));
    expect(result!.content).toMatchObject({
      content: { type: 'list', items: [{ text: 'src/a.ts', icon: 'read' }] },
    });
  });

  it('shows the files a patch touched as pills, without the diff or the output', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'apply_patch',
      tool_action: 'edit',
      status: 'completed',
      summary: 'src/a.ts, src/b.ts',
      invocation: 'src/a.ts\n@@ -1 +1 @@\n-x\n+y',
      items: ['src/a.ts', 'src/b.ts'],
      result_json: 'applied',
    }));
    expect(result!.content).toMatchObject({
      content: { type: 'list', items: [{ text: 'src/a.ts', icon: 'write' }, { text: 'src/b.ts', icon: 'write' }] },
    });
  });

  it('shows a failed edit as its pills alone, like the one that succeeded', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'Edit',
      tool_action: 'edit',
      status: 'failed',
      summary: 'src/a.ts',
      invocation: 'src/a.ts\n@@ -1 +1 @@\n-x\n+y',
      items: ['src/a.ts'],
      result_json: 'file not found',
    }));
    // A call that named what it was about is presented by that list, whatever
    // its status: the pills already say what it touched, and the client cannot
    // fold the diff away beside them.
    expect(segmentsOf(result!)).toEqual({
      type: 'list',
      items: [{ text: 'src/a.ts', icon: 'write' }],
    });
  });

  it('truncates a first item longer than the whole pill budget into one pill instead of hiding it', () => {
    const long = `packages/example/src/${'deeply-nested-'.repeat(50)}module.ts`;
    const [result] = toolCallResultEvents(toolCall({
      tool_action: 'edit',
      status: 'completed',
      items: [long, 'src/b.ts'],
    }));
    const list = (result!.content as { content: { type: string; items: Array<{ text: string }>; more?: { text: string } } }).content;
    expect(list.type).toBe('list');
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.text.endsWith('… (truncated)')).toBe(true);
    expect(Buffer.byteLength(list.items[0]!.text, 'utf8')).toBeLessThanOrEqual(512);
    expect(list.more).toEqual({ text: '+1' });
  });

  it('folds the files past the pill budget into one +N pill', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `packages/example/src/deeply/nested/module-${String(i).padStart(2, '0')}.ts`);
    const [result] = toolCallResultEvents(toolCall({
      tool_action: 'edit',
      status: 'completed',
      items: paths,
    }));
    const list = (result!.content as { content: { type: string; items?: unknown[]; more?: { text: string } } }).content;
    expect(list.type).toBe('list');
    expect(list.items!.length).toBeGreaterThan(0);
    expect(list.items!.length).toBeLessThan(paths.length);
    expect(list.more).toEqual({ text: `+${paths.length - list.items!.length}` });
  });

  it.each([
    { output: 'command failed', segment: { type: 'text', text: 'command failed' } },
    {
      output: '{"error":"command failed"}',
      segment: { type: 'code', language: 'json', code: '{\n  "error": "command failed"\n}' },
    },
  ])('shows the actual failure output without an extra status line: $output', ({ output, segment }) => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'failed',
      summary: 'Run the tests',
      invocation: 'npm test',
      result_json: output,
    }));
    expect(segmentsOf(result!)).toEqual([
      { type: 'code', language: 'bash', code: 'npm test' },
      RESULT,
      segment,
    ]);
  });

  it('still opens a result area for a failure that returned no output', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'failed',
      summary: 'Run the tests',
      invocation: 'npm test',
    }));
    expect(segmentsOf(result!)).toEqual([
      { type: 'code', language: 'bash', code: 'npm test' },
      RESULT,
      { type: 'text', text: 'Failed' },
    ]);
  });

  it('keeps the failure area when both arguments and output are absent', () => {
    const [result] = toolCallResultEvents(toolCall({ status: 'failed' }));
    expect(segmentsOf(result!)).toEqual([
      RESULT,
      { type: 'text', text: 'Failed' },
    ]);
  });

  it('shows Complete in the result area when a call succeeded with nothing to show', () => {
    const [result] = toolCallResultEvents(toolCall({ status: 'completed' }));
    expect(segmentsOf(result!)).toEqual([RESULT, { type: 'text', text: 'Complete' }]);
  });

  it('shows Complete after the arguments when a call succeeded and returned nothing', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      invocation: 'git add -A',
    }));
    expect(segmentsOf(result!)).toEqual([
      { type: 'code', language: 'bash', code: 'git add -A' },
      RESULT,
      { type: 'text', text: 'Complete' },
    ]);
  });

  it('prefers the invocation to the full arguments for every tool, not only Bash', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'Agent',
      tool_action: null,
      status: 'completed',
      summary: 'Review the diff',
      invocation: 'Review the diff and report only real defects.',
      arguments_json: JSON.stringify({
        description: 'Review the diff',
        prompt: 'Review the diff and report only real defects.',
        subagent_type: 'general-purpose',
      }),
      result_json: 'no defects found',
    }));
    // The prompt is what the call was; the JSON around it repeats the title
    // and adds routing nobody reads. `text`, because only a `run` action
    // claims to be a shell command line.
    expect(segmentsOf(result!)).toEqual([
      { type: 'code', language: 'text', code: 'Review the diff and report only real defects.' },
      RESULT,
      { type: 'text', text: 'no defects found' },
    ]);
  });

  it('falls back to the structured input only when there is no invocation', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'mcp__probe__lookup',
      tool_action: null,
      status: 'completed',
      arguments_json: '{"id":7,"deep":{"on":true}}',
      result_json: 'ok',
    }));
    expect(segmentsOf(result!)).toEqual([
      {
        type: 'code',
        language: 'json',
        code: '{\n  "id": 7,\n  "deep": {\n    "on": true\n  }\n}',
      },
      RESULT,
      { type: 'text', text: 'ok' },
    ]);
  });

  it.each(['42', 'a bare string the runtime passed', '{"unterminated": 1'])(
    'shows structured input that is not an object or an array as text code: %j',
    (args) => {
      const [result] = toolCallResultEvents(toolCall({
        tool_name: 'mcp__probe__lookup',
        tool_action: null,
        status: 'completed',
        arguments_json: args,
      }));
      expect(segmentsOf(result!)).toEqual([
        { type: 'code', language: 'text', code: args },
        RESULT,
        { type: 'text', text: 'Complete' },
      ]);
    },
  );

  it('shows argument values exactly as the runtime wrote them', () => {
    // Core hands this layer the real command on purpose: a masked one is a
    // command nobody can judge. Nothing here rewrites paths or masks values.
    const command = 'echo "token: dummy" > /tmp/cot-output.txt';
    const [result] = toolCallResultEvents(toolCall({
      status: 'completed',
      invocation: command,
      result_json: 'ok',
    }));
    expect(segmentsOf(result!)).toEqual([
      { type: 'code', language: 'bash', code: command },
      RESULT,
      { type: 'text', text: 'ok' },
    ]);
  });

  it('fits a long argument and a long output into one event, cutting both', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'failed',
      invocation: `echo ${'界'.repeat(3_000)}`,
      result_json: '界'.repeat(3_000),
    }));
    const shown = segmentsOf(result!) as Array<{ type: string; text?: string; code?: string }>;
    expect(shown.map((segment) => segment.type)).toEqual(['code', 'text', 'text']);
    expect(shown[0]!.code!.endsWith('… (truncated)')).toBe(true);
    expect(shown[1]).toEqual(RESULT);
    expect(shown[2]!.text!.endsWith('… (truncated)')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });

  it('falls back to the status alone when even the pills do not fit', () => {
    // The known list-budget limitation: many short items pass the pill budget
    // and still overflow the event, and the row then says only how it ended.
    const [result] = toolCallResultEvents(toolCall({
      tool_action: 'edit',
      status: 'failed',
      items: Array.from({ length: 150 }, (_, i) => `f${i}`),
    }));
    expect(segmentsOf(result!)).toEqual({ type: 'text', text: 'Failed' });
    expect(Buffer.byteLength(JSON.stringify(result!.content), 'utf8')).toBeLessThanOrEqual(4_096);
  });
});
