/**
 * What a tool row sends to Feishu, from what the runtime said about the call.
 *
 * Wire shapes follow the COT Message Brief (`TOOL_CALL_START` with `icon` and
 * `title`; `TOOL_CALL_RESULT` segments `{type:'code', language, code}` and
 * `{type:'list', items, more?}`).
 */

import { describe, expect, it } from 'vitest';

import type { TeammateActivity } from '@excitedjs/dreamux-types';

import {
  toolCallResultEvents,
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
    summary_truncated: false,
    invocation_truncated: false,
    arguments_truncated: false,
    result_truncated: false,
    redacted: false,
    ...overrides,
  };
}

function eventTypes(events: ReadonlyArray<{ eventType: string }>): string[] {
  return events.map((event) => event.eventType);
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

  it('names the tool before the summary when the runtime has no action for it', () => {
    const [start] = toolCallStartEvents(toolCall({
      tool_name: 'Skill',
      tool_action: null,
      summary: 'team-workflow',
    }));
    expect(start!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: 'Skill',
      title: 'Skill: team-workflow',
    });
  });

  it('hides the arguments of a call nothing could label and gives it the generic app icon', () => {
    const events = toolCallStartEvents(toolCall({
      tool_name: 'mcp__other__thing',
      tool_action: null,
      arguments_json: '{"x":1}',
    }));
    expect(eventTypes(events)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END']);
    expect(events[0]!.content).toEqual({
      toolCallId: expect.any(String),
      toolCallName: 'thing',
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
        toolCallName: toolName.split(/__|\./).at(-1),
        icon: 'app-default_outlined',
      });
    }
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'mcp__chan-cot__reply',
      tool_action: null,
      status: 'completed',
      result_json: '{"message_ids":["om_1"]}',
    }));
    // No fixed Completed line: the output expands like any other tool's, and
    // a one-line output is a code segment too (「全都给他们包到代码块里面」).
    expect(result!.content).toMatchObject({
      content: { type: 'code', language: 'text', code: '{"message_ids":["om_1"]}' },
    });
  });

  it('expands a result into the invocation and the output as documented code segments', () => {
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
        { type: 'code', language: 'text', code: ' M src/a.ts\n?? src/b.ts' },
      ],
    });
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

  it('keeps the diff and the output on a failed edit, after the failure line and the pills', () => {
    const [result] = toolCallResultEvents(toolCall({
      tool_name: 'Edit',
      tool_action: 'edit',
      status: 'failed',
      summary: 'src/a.ts',
      invocation: 'src/a.ts\n@@ -1 +1 @@\n-x\n+y',
      items: ['src/a.ts'],
      result_json: 'file not found',
    }));
    expect(result!.content).toMatchObject({
      content: [
        { type: 'text', text: 'Failed' },
        { type: 'list', items: [{ text: 'src/a.ts', icon: 'write' }] },
        { type: 'code', language: 'text', code: 'src/a.ts\n@@ -1 +1 @@\n-x\n+y' },
        { type: 'code', language: 'text', code: 'file not found' },
      ],
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

  it('shows a failed result with its failure line first', () => {
    const [result] = toolCallResultEvents(toolCall({
      status: 'failed',
      summary: 'Run the tests',
      invocation: 'npm test',
      result_json: 'command failed',
    }));
    expect(result!.content).toMatchObject({
      content: [
        { type: 'text', text: 'Failed' },
        { type: 'code', language: 'bash', code: 'npm test' },
        { type: 'code', language: 'text', code: 'command failed' },
      ],
    });
  });
});
