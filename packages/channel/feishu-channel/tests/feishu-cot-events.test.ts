/**
 * COT display projection (COVERAGE CELL F).
 *
 * This is the layer that turns one Core-sanitized runtime activity into AG-UI
 * card events. Core owns generic safety processing; this layer selects what is
 * *shown* and enforces the Feishu per-event and per-batch budgets. Two
 * contracts here are load-bearing and are asserted as behavior:
 *
 * - **no event may exceed the 4 KiB content budget**, whatever a provider or a
 *   hostile payload does — the projector throws rather than emit one, so every
 *   path that can produce a large value must shrink it first;
 * - **display ids are opaque**, so a raw provider `call_id`/`event_id` never
 *   reaches a card that other people in the chat can read.
 */
import { describe, expect, it } from 'vitest';

import { createFeishuCotClient } from '@excitedjs/feishu-transport';

import {
  assembleToolResultContent,
  cotAppendBatchBytes,
  cotEventBytes,
  cotEventContentBytes,
  FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
  runFinishedEvent,
  runStartedEvent,
  textMessageEvents,
  toolCallResultEvents,
  toolCallStartEvents,
} from '../src/feishu-cot-events.js';
import { toolCall } from './helpers/cot-fixtures.js';

function deltas(events: readonly { eventType: string; content: Record<string, unknown> }[]): string {
  return events
    .filter((event) => event.eventType === 'TEXT_MESSAGE_CONTENT')
    .map((event) => String(event.content['delta']))
    .join('');
}

function typesOf(
  events: readonly { eventType: string }[],
): string[] {
  return events.map((event) => event.eventType);
}

describe('the run envelope names the presentation, not the turn', () => {
  it('opens and closes on the presentation id with the status the adapter decided', () => {
    expect(runStartedEvent('p-1')).toEqual({
      eventType: 'RUN_STARTED',
      content: { threadId: 'p-1', runId: 'p-1' },
    });
    expect(runFinishedEvent('p-1', 'done').content).toMatchObject({
      status: 'done',
    });
    expect(runFinishedEvent('p-1', 'interrupted').content).toMatchObject({
      status: 'interrupted',
    });
  });
});

describe('text message projection', () => {
  it('passes Core-processed content through and splits it within the per-event budget', () => {
    const prefix = 'Core 已处理：$WORKSPACE $HOME_PATH <redacted> oc_visible ';
    const source = `${prefix}${'中文🙂'.repeat(2_000)}`;

    const events = textMessageEvents({
      sourceId: 'evt-message-1',
      role: 'assistant',
      content: source,
    });

    expect(typesOf(events).at(0)).toBe('TEXT_MESSAGE_START');
    expect(typesOf(events).at(-1)).toBe('TEXT_MESSAGE_END');
    // Split, but lossless — the projector is a budget, not a filter.
    expect(events.filter((e) => e.eventType === 'TEXT_MESSAGE_CONTENT').length)
      .toBeGreaterThan(1);
    expect(deltas(events)).toBe(source);
    expect(deltas(events)).not.toContain('�');
    for (const event of events) {
      expect(cotEventContentBytes(event)).toBeLessThanOrEqual(
        FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
      );
    }
  });

  it('carries the role and shares one bounded projector between assistant and user text', () => {
    const assistantEvents = textMessageEvents({
      sourceId: 'assistant-source',
      role: 'assistant',
      content: 'assistant text',
    });
    const userEvents = textMessageEvents({
      sourceId: 'user-source',
      role: 'user',
      content: 'scheduled text',
    });

    expect(assistantEvents[0]?.content['role']).toBe('assistant');
    expect(userEvents[0]?.content['role']).toBe('user');
    expect(deltas(userEvents)).toBe('scheduled text');
    expect(typesOf(assistantEvents)).toEqual(typesOf(userEvents));
  });

  it('projects nothing for content that is empty or only whitespace', () => {
    expect(textMessageEvents({ sourceId: 's', role: 'assistant', content: '' }))
      .toEqual([]);
    expect(
      textMessageEvents({ sourceId: 's', role: 'assistant', content: '   \n\t ' }),
    ).toEqual([]);
  });

  it('bounds one message group and marks it truncated rather than dropping the message', () => {
    const events = textMessageEvents({
      sourceId: 'evt-huge',
      role: 'assistant',
      content: '中文🙂'.repeat(80_000),
    });

    const grouped = events.reduce((total, event) => total + cotEventBytes(event), 0);
    expect(grouped).toBeLessThanOrEqual(224 * 1_024);
    // The start/end pair still frames it, and the reader is told it was cut.
    expect(typesOf(events).at(0)).toBe('TEXT_MESSAGE_START');
    expect(typesOf(events).at(-1)).toBe('TEXT_MESSAGE_END');
    expect(deltas(events).endsWith('…（已截断）')).toBe(true);
  });

  it('keeps the message id opaque — the source event id never reaches the card', () => {
    const sourceId = 'evt-secret-correlation-1';
    const events = textMessageEvents({
      sourceId,
      role: 'assistant',
      content: 'hello',
    });
    const messageId = String(events[0]?.content['messageId']);

    expect(messageId).not.toContain(sourceId);
    expect(messageId.startsWith('message-')).toBe(true);
    // Stable, so the start/content/end trio all name the same message.
    expect(new Set(events.map((event) => event.content['messageId'])).size).toBe(1);
    expect(
      textMessageEvents({ sourceId, role: 'assistant', content: 'other' })[0]
        ?.content['messageId'],
    ).toBe(messageId);
  });
});

describe('tool call projection selects what a reader may see', () => {
  it('shows a generic tool with its bounded arguments and a leaf display name', () => {
    const events = toolCallStartEvents(
      toolCall({
        tool_name: 'provider.namespace.run_command',
        tool_action: null,
        arguments_json: JSON.stringify({ command: 'pnpm test' }),
      }),
    );

    expect(typesOf(events)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);
    expect(events[0]?.content['toolCallName']).toBe('run_command');
    expect(String(events[1]?.content['delta'])).toContain('pnpm test');
    expect(String(events[0]?.content['toolCallId'])).not.toContain('call-1');
  });

  it('renames a recognized runtime action to its stable display verb', () => {
    const events = toolCallStartEvents(
      toolCall({ tool_name: 'exec_command', tool_action: 'run' }),
    );
    expect(events[0]?.content['toolCallName']).toBe('Bash');
    expect(
      toolCallStartEvents(toolCall({ tool_name: 'anything', tool_action: 'read' }))[0]
        ?.content['toolCallName'],
    ).toBe('Read');
  });

  it.each([
    ['mcp__feishu__reply', undefined, '回复飞书消息'],
    ['feishu.react', undefined, '点击飞书表情'],
    ['mcp__primary__list_chat_bots', 'primary', '查看群机器人'],
    ['channel-primary.reply', 'primary', '回复飞书消息'],
  ])(
    'presents this Channel\'s own tool %s as a titled action with no argument echo',
    (toolName, channelId, title) => {
      const events = toolCallStartEvents(
        toolCall({
          tool_name: toolName,
          tool_action: null,
          arguments_json: JSON.stringify({ text: 'secret outbound draft' }),
        }),
        channelId,
      );

      expect(events[0]?.content['title']).toBe(title);
      // A Channel tool's own arguments are the message being sent; echoing them
      // back onto the card would duplicate outbound content into the thread.
      expect(typesOf(events)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END']);
      expect(JSON.stringify(events)).not.toContain('secret outbound draft');
    },
  );

  it.each([
    // Another MCP server that merely happens to expose a `reply` leaf.
    ['mcp__other__reply', 'primary'],
    // This Channel's server, but a verb it does not own.
    ['mcp__feishu__unknown', undefined],
    // This Channel's verb under a channel id this session is not configured as.
    ['channel-secondary.reply', 'primary'],
  ] as const)(
    'does not treat %s as this Channel\'s own tool',
    (toolName, channelId) => {
      const events = toolCallStartEvents(
        toolCall({
          tool_name: toolName,
          tool_action: null,
          arguments_json: 'visible-argument',
        }),
        channelId,
      );
      expect(typesOf(events)).toContain('TOOL_CALL_ARGS');
      expect(events[0]?.content['title']).toBeUndefined();
    },
  );

  it('summarizes a built-in TeamMate spawn by intent instead of echoing raw arguments', () => {
    const start = toolCallStartEvents(
      toolCall({
        tool_name: 'mcp__teammate__spawn',
        tool_action: null,
        arguments_json: JSON.stringify({
          name_prefix: 'scout',
          prompt: 'go look at the failing suite',
          intent: '排查测试失败',
          agent_runtime: 'codex',
          identity: 'reviewer',
        }),
      }),
    );
    const result = toolCallResultEvents(
      toolCall({
        tool_name: 'mcp__teammate__spawn',
        tool_action: null,
        status: 'completed',
        arguments_json: JSON.stringify({
          name_prefix: 'scout',
          prompt: 'go look at the failing suite',
          intent: '排查测试失败',
          agent_runtime: 'codex',
          identity: 'reviewer',
        }),
      }),
    );

    expect(start[0]?.content['title']).toBe('分派成员 排查测试失败');
    expect(typesOf(start)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END']);
    const rendered = JSON.stringify(result[0]?.content['content']);
    expect(rendered).toContain('Agent Runtime：codex');
    expect(rendered).toContain('go look at the failing suite');
  });

  it('renders a workflow script as code and names it from its own meta', () => {
    const script = "export const meta = { name: 'review-changes', description: 'x' }\nreturn 1\n";
    const start = toolCallStartEvents(
      toolCall({
        tool_name: 'mcp__teammate__workflow_run',
        tool_action: null,
        arguments_json: JSON.stringify({ script }),
      }),
    );
    const result = toolCallResultEvents(
      toolCall({
        tool_name: 'mcp__teammate__workflow_run',
        tool_action: null,
        status: 'completed',
        arguments_json: JSON.stringify({ script }),
      }),
    );

    expect(start[0]?.content['title']).toBe('Workflow review-changes');
    expect(result[0]?.content['content']).toMatchObject({
      type: 'code',
      language: 'javascript',
    });
  });

  it('falls back to the bare Workflow title when the script declares no meta name', () => {
    const start = toolCallStartEvents(
      toolCall({
        tool_name: 'teammate.workflow_run',
        tool_action: null,
        arguments_json: JSON.stringify({ scriptPath: '/tmp/wf.js' }),
      }),
    );
    expect(start[0]?.content['title']).toBe('Workflow');
  });
});

describe('tool result projection stays inside the per-event budget', () => {
  it('shows a fixed status line for this Channel\'s own tool, never its payload', () => {
    for (const status of ['completed', 'failed'] as const) {
      const events = toolCallResultEvents(
        toolCall({
          tool_name: 'mcp__feishu__reply',
          tool_action: null,
          status,
          result_json: JSON.stringify({ message_id: 'om-private-1' }),
        }),
      );
      expect(events[0]?.content['content']).toEqual({
        type: 'text',
        text: status === 'failed' ? '执行失败' : '执行完成',
      });
      expect(JSON.stringify(events)).not.toContain('om-private-1');
    }
  });

  it('measures the JSON-escaped serialization and never emits an oversized result event', () => {
    const hostile = `${'"\\\n\t🙂'.repeat(2_000)}${'四字节🙂'.repeat(2_000)}`;
    for (const status of ['completed', 'failed'] as const) {
      const events = toolCallResultEvents(
        toolCall({
          status,
          arguments_json: hostile,
          result_json: hostile,
          arguments_truncated: true,
          result_truncated: true,
        }),
      );
      expect(events).toHaveLength(1);
      expect(cotEventContentBytes(events[0]!)).toBeLessThanOrEqual(
        FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
      );
      expect(JSON.stringify(events)).toContain('…（已截断）');
    }
  });

  it('shrinks the result before the arguments when assembled content overflows', () => {
    const argumentsText = 'argument-kept';
    const content = assembleToolResultContent({
      failed: true,
      argumentsText,
      resultText: 'result'.repeat(4_000),
    });

    expect(Buffer.byteLength(JSON.stringify(content), 'utf8')).toBeLessThan(4_096);
    expect(content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: '执行失败' },
        { type: 'code', language: 'text', content: argumentsText },
      ]),
    );
    expect(JSON.stringify(content)).toContain('…（已截断）');
  });

  it('marks Core-truncated arguments and results even when the local value is short', () => {
    const start = toolCallStartEvents(
      toolCall({ arguments_json: 'args', arguments_truncated: true, tool_action: null }),
    );
    const terminal = toolCallResultEvents(
      toolCall({
        status: 'completed',
        arguments_json: null,
        result_json: 'result',
        result_truncated: true,
        tool_action: null,
      }),
    );
    expect(JSON.stringify([...start, ...terminal])).toContain('…（已截断）');
  });

  it('keeps a short single-line detail as plain text and states the outcome when there is none', () => {
    expect(
      assembleToolResultContent({
        failed: false,
        argumentsText: null,
        resultText: 'ok',
      }),
    ).toEqual({ type: 'text', text: 'ok' });
    expect(
      assembleToolResultContent({
        failed: false,
        argumentsText: null,
        resultText: null,
      }),
    ).toEqual({ type: 'text', text: '执行完成' });
    expect(
      assembleToolResultContent({
        failed: true,
        argumentsText: null,
        resultText: null,
      }),
    ).toEqual({ type: 'text', text: '执行失败' });
  });
});

describe('the local size estimate is conservative against the real wire request', () => {
  it('never under-estimates what the transport actually sends', async () => {
    const requests: unknown[] = [];
    const cot = createFeishuCotClient(
      {
        request: async (request: unknown): Promise<{ code: number }> => {
          requests.push(request);
          return { code: 0 };
        },
      } as never,
      { now: () => 1_725_000_000_000 },
    );
    const events = [
      {
        eventType: 'TEXT_"\\ 中文',
        content: {
          text: '引号"、反斜杠\\、控制 与中文🙂',
          nested: ['line\nfeed', { value: '\tquoted"value' }],
        },
      },
    ];
    const input = {
      cotId: 'cot-"\\中文',
      messageId: 'message-"\\中文',
      events,
    };

    await cot.appendCot(input);

    const request = requests[0] as { readonly data?: unknown };
    const actual = Buffer.byteLength(JSON.stringify(request.data), 'utf8');
    expect(cotAppendBatchBytes(input)).toBeGreaterThanOrEqual(actual);
  });
});
