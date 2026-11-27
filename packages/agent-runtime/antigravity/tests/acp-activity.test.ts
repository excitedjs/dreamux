import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentRuntimeEvent } from '@excitedjs/dreamux-types';
import { describe, expect, it } from 'vitest';

import { AcpActivity } from '../src/acp/activity.js';

function notify(update: SessionNotification['update']): SessionNotification {
  return { sessionId: 'native-session', update };
}

describe('AcpActivity', () => {
  it('maps read_file, write_file, and edit_file to basename summaries while preserving raw paths in items', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        title: 'File ../../../../../../../home/example/skills/doc/SKILL.md',
        locations: [{ path: '/home/example/skills/doc/SKILL.md' }],
        rawInput: { Path: '/home/example/skills/doc/SKILL.md' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'write-1',
        name: 'write_file',
        kind: 'edit',
        status: 'in_progress',
        title: 'File a.txt',
        locations: [{ path: 'C:\\Users\\example\\repo\\a.txt' }],
        rawInput: { Path: 'C:\\Users\\example\\repo\\a.txt', Content: 'hi' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        name: 'edit_file',
        kind: 'edit',
        status: 'in_progress',
        title: 'File ../../../src/notes ',
        locations: [{ path: '/repo/src/notes ' }],
        rawInput: { Replacement: 'b', Target: 'a' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-dir',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        title: 'File ../../../outside/repo/folder/',
        locations: [{ path: '/outside/repo/folder/' }],
        rawInput: { Path: '/outside/repo/folder/' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-root',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        title: 'File ../../../',
        locations: [{ path: '/' }],
        rawInput: { Path: '/' },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool.call',
        id: 'read-1',
        toolName: 'read_file',
        action: 'read',
        summary: 'SKILL.md',
        invocation: null,
        items: ['/home/example/skills/doc/SKILL.md'],
        status: 'started',
        result: null,
        error: null,
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'write-1',
        toolName: 'write_file',
        action: 'edit',
        summary: 'a.txt',
        invocation: null,
        items: ['C:\\Users\\example\\repo\\a.txt'],
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'edit-1',
        toolName: 'edit_file',
        action: 'edit',
        summary: 'notes ',
        invocation: null,
        items: ['/repo/src/notes '],
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'read-dir',
        toolName: 'read_file',
        action: 'read',
        summary: 'folder',
        invocation: null,
        items: ['/outside/repo/folder/'],
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'read-root',
        toolName: 'read_file',
        action: 'read',
        summary: null,
        invocation: null,
        items: ['/'],
        status: 'started',
      }),
    ]);
  });

  it('prefers toolSummary on run_command, preserves raw invocation, extracts plain text output, and marks non-zero exit as failed without flagging failedTools', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-ok',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        title: 'echo hello && pwd',
        rawInput: {
          CommandLine: 'echo hello\\ ',
          WaitMsBeforeAsync: 5000,
          toolSummary: 'Echo hello',
        },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-ok',
        status: 'completed',
        rawOutput: { output: 'hello\n/repo\n', exit_code: 0 },
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'hello\n/repo\n' },
          },
        ],
      }),
    );

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-fail',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        title: 'exit 1',
        rawInput: { CommandLine: 'exit 1\nsecond line' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'cmd-fail',
        status: 'completed',
        rawOutput: { output: 'Command exited with code 1.', exit_code: 1 },
      }),
    );

    expect(activity.hasFailedTools()).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool.call',
        id: 'cmd-ok',
        action: 'run',
        summary: 'Echo hello',
        invocation: 'echo hello\\ ',
        items: [],
        status: 'started',
        result: null,
        error: null,
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'cmd-ok',
        action: 'run',
        summary: 'Echo hello',
        invocation: 'echo hello\\ ',
        status: 'completed',
        result: 'hello\n/repo\n',
        error: null,
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'cmd-fail',
        action: 'run',
        summary: 'exit 1',
        invocation: 'exit 1\nsecond line',
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'cmd-fail',
        action: 'run',
        summary: 'exit 1',
        invocation: 'exit 1\nsecond line',
        status: 'failed',
        result: 'Command exited with code 1.',
        error: 'Command exited with code 1.',
      }),
    ]);
  });

  it('keeps structured tool failures on result without serializing them into error', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-fail',
        name: 'mcp_demo_auth',
        kind: 'execute',
        status: 'in_progress',
        title: 'Run mcp_demo_auth',
        rawInput: { toolSummary: 'Check auth' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-fail',
        status: 'failed',
        rawOutput: { code: 'UNAUTHORIZED', client_secret: 'placeholder-value' },
      }),
    );

    expect(activity.hasFailedTools()).toBe(true);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'tool.call',
        id: 'mcp-fail',
        status: 'failed',
        result: { code: 'UNAUTHORIZED', client_secret: 'placeholder-value' },
        error: null,
      }),
    );
  });

  it('preserves cached tool name and input when tool_call_update passes explicit null fields', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'null-fields',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        title: 'echo ok',
        rawInput: { CommandLine: 'echo ok', toolSummary: 'Echo ok' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'null-fields',
        name: null,
        title: null,
        rawInput: null,
        status: 'completed',
        rawOutput: { output: 'ok', exit_code: 0 },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool.call',
        id: 'null-fields',
        toolName: 'run_command',
        action: 'run',
        summary: 'Echo ok',
        invocation: 'echo ok',
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'null-fields',
        toolName: 'run_command',
        action: 'run',
        summary: 'Echo ok',
        invocation: 'echo ok',
        status: 'completed',
        result: 'ok',
        error: null,
      }),
    ]);
  });

  it('classifies MCP tools with action null, toolName + toolSummary, and plain-text content', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-1',
        name: 'mcp_channel-feishu_reply',
        kind: 'execute',
        status: 'in_progress',
        title: 'Run mcp_channel-feishu_reply',
        rawInput: {
          chat_id: 'chat-1',
          text: 'hello',
          toolSummary: 'Send status reply',
        },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-1',
        status: 'completed',
        rawOutput: { wrapped: true },
        content: [
          { type: 'content', content: { type: 'text', text: 'line 1' } },
          { type: 'content', content: { type: 'text', text: 'line 2' } },
        ],
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-2',
        name: 'mcp_demo_ping',
        kind: 'execute',
        status: 'in_progress',
        title: 'Run mcp_demo_ping',
        rawInput: { msg: 'hi' },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool.call',
        id: 'mcp-1',
        toolName: 'mcp_channel-feishu_reply',
        action: null,
        summary: 'mcp_channel-feishu_reply · Send status reply',
        invocation: null,
        items: [],
        status: 'started',
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'mcp-1',
        toolName: 'mcp_channel-feishu_reply',
        action: null,
        summary: 'mcp_channel-feishu_reply · Send status reply',
        status: 'completed',
        result: 'line 1\nline 2',
        error: null,
      }),
      expect.objectContaining({
        kind: 'tool.call',
        id: 'mcp-2',
        toolName: 'mcp_demo_ping',
        action: null,
        summary: null,
        invocation: null,
        items: [],
        status: 'started',
      }),
    ]);
  });

  it('maps search_web, invoke_subagent, and run_workflow and deduplicates repeated started updates', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'search-1',
        name: 'search_web',
        kind: 'search',
        status: 'in_progress',
        title: '"dreamux" on Web',
        rawInput: { query: 'dreamux' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'search-1',
        status: 'in_progress',
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'sub-1',
        name: 'invoke_subagent',
        title: 'Run invoke_subagent',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { Role: 'Code Reviewer', Prompt: 'Inspect the diff' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'wf-1',
        name: 'run_workflow',
        title: 'Run run_workflow',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { Description: 'Audit packages', Script: 'print(1)' },
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        id: 'search-1',
        action: 'search',
        summary: 'dreamux',
        invocation: null,
        status: 'started',
      }),
      expect.objectContaining({
        id: 'sub-1',
        action: null,
        summary: 'Code Reviewer',
        invocation: 'Inspect the diff',
        status: 'started',
      }),
      expect.objectContaining({
        id: 'wf-1',
        action: null,
        summary: 'Audit packages',
        invocation: 'print(1)',
        status: 'started',
      }),
    ]);
  });

  it('streams reasoning and flushes assistant messages without native messageId using distinct IDs across tool and turn boundaries', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'First ' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thought' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        name: 'read_file',
        title: 'File a.ts',
        status: 'in_progress',
        rawInput: { Path: '/repo/a.ts' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Second thought' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Final ' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer' },
      }),
    );
    activity.finishTurn('end_turn', 'Final answer');

    // Second turn after reset must allocate a fresh non-colliding display ID.
    activity.reset();
    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Next turn thought' },
      }),
    );
    activity.reset();

    const reasoning = events.filter(
      (
        event,
      ): event is Extract<AgentRuntimeEvent, { kind: 'assistant.reasoning' }> =>
        event.kind === 'assistant.reasoning',
    );
    const messages = events.filter(
      (
        event,
      ): event is Extract<AgentRuntimeEvent, { kind: 'assistant.message' }> =>
        event.kind === 'assistant.message',
    );
    const [r1a, r1b, r1End, r2Start, r2End, r3Start, r3End] = reasoning;
    expect(reasoning).toHaveLength(7);
    expect(r1a!.id).toBe(r1b!.id);
    expect(r1a!.id).toBe(r1End!.id);
    expect(r2Start!.id).toBe(r2End!.id);
    expect(r3Start!.id).toBe(r3End!.id);
    expect(new Set([r1a!.id, r2Start!.id, r3Start!.id]).size).toBe(3);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('Final answer');

    expect(
      events.map((event) => {
        if (event.kind === 'assistant.reasoning') {
          return `reasoning:${event.status}:${event.text}`;
        }
        if (event.kind === 'assistant.message') {
          return `message:${event.text}`;
        }
        if (event.kind === 'tool.call') {
          return `tool:${event.id}:${event.status}`;
        }
        return event.kind;
      }),
    ).toEqual([
      'reasoning:streaming:First ',
      'reasoning:streaming:thought',
      'reasoning:completed:',
      'tool:call-1:started',
      'tool:call-1:completed',
      'reasoning:streaming:Second thought',
      'reasoning:completed:',
      'message:Final answer',
      'turn.result',
      'turn.ended',
      'reasoning:streaming:Next turn thought',
      'reasoning:completed:',
    ]);
  });

  it('preserves native messageId on reasoning switches and assistant message chunks', () => {
    const events: AgentRuntimeEvent[] = [];
    const activity = new AcpActivity((event) => events.push(event));

    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'native-thought-1',
        content: { type: 'text', text: 'Plan 1' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'native-thought-2',
        content: { type: 'text', text: 'Plan 2' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'native-msg-1',
        content: { type: 'text', text: 'Hello' },
      }),
    );
    activity.update(
      notify({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'native-msg-2',
        content: { type: 'text', text: 'World' },
      }),
    );
    activity.finishMessages();

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'assistant.reasoning',
        id: 'native-thought-1',
        partIndex: 0,
        text: 'Plan 1',
        status: 'streaming',
      }),
      expect.objectContaining({
        kind: 'assistant.reasoning',
        id: 'native-thought-1',
        partIndex: 0,
        text: '',
        status: 'completed',
      }),
      expect.objectContaining({
        kind: 'assistant.reasoning',
        id: 'native-thought-2',
        partIndex: 0,
        text: 'Plan 2',
        status: 'streaming',
      }),
      expect.objectContaining({
        kind: 'assistant.reasoning',
        id: 'native-thought-2',
        partIndex: 0,
        text: '',
        status: 'completed',
      }),
      expect.objectContaining({
        kind: 'assistant.message',
        id: 'native-msg-1',
        text: 'Hello',
      }),
      expect.objectContaining({
        kind: 'assistant.message',
        id: 'native-msg-2',
        text: 'World',
      }),
    ]);
  });
});
