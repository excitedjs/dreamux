import { describe, expect, it } from 'vitest';

import type {
  ChannelTurnMessageEvent,
  ChannelTurnToolCallEvent,
} from '@excitedjs/dreamux-types';
import { createFeishuCotClient } from '@excitedjs/feishu-transport';

import {
  assembleToolResultContent,
  cotAppendBatchBytes,
  cotEventContentBytes,
  FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
  textMessageEvents,
  toolCallResultEvents,
  toolCallStartEvents,
} from '../src/feishu-cot-events.js';

function assistant(
  overrides: Partial<ChannelTurnMessageEvent> = {},
): ChannelTurnMessageEvent {
  return {
    schema_version: 1,
    kind: 'turn.message',
    event_id: 'evt-message-1',
    occurred_at: 2,
    team_name: 'team-alpha',
    agent_name: 'leader',
    role: 'team_leader',
    turn_id: 'turn-1',
    message_role: 'assistant',
    content: '正在处理',
    content_truncated: false,
    redacted: false,
    ...overrides,
  };
}

function toolCall(
  overrides: Partial<ChannelTurnToolCallEvent> = {},
): ChannelTurnToolCallEvent {
  return {
    schema_version: 1,
    kind: 'turn.tool_call',
    event_id: 'evt-tool-1',
    occurred_at: 3,
    team_name: 'team-alpha',
    agent_name: 'leader',
    role: 'team_leader',
    turn_id: 'turn-1',
    call_id: 'call-1',
    tool_name: 'exec_command',
    tool_action: 'run',
    status: 'started',
    arguments_json: JSON.stringify({ command: 'pnpm test' }),
    result_json: null,
    arguments_truncated: false,
    result_truncated: false,
    redacted: false,
    ...overrides,
  };
}

describe('Feishu COT display projection', () => {
  it('passes Core-processed assistant content through and splits it safely', () => {
    const prefix = 'Core 已处理：$WORKSPACE $HOME_PATH <redacted> oc_visible ';
    const source = `${prefix}${'中文🙂'.repeat(2_000)}`;
    const events = textMessageEvents({
      sourceId: 'evt-message-1',
      role: 'assistant',
      content: source,
    });
    const deltas = events
      .filter((event) => event.eventType === 'TEXT_MESSAGE_CONTENT')
      .map((event) => String(event.content['delta']));

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(source);
    expect(deltas.join('')).toContain('oc_visible');
    expect(deltas.join('')).not.toContain('\uFFFD');
    for (const event of events) {
      expect(cotEventContentBytes(event)).toBeLessThanOrEqual(
        FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
      );
    }
  });

  it('uses one bounded projector for assistant and user text roles', () => {
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
    expect(userEvents.find((event) =>
      event.eventType === 'TEXT_MESSAGE_CONTENT')?.content['delta'])
      .toBe('scheduled text');
  });

  it('projects bounded arguments without a title or explicit icon', () => {
    const command = 'pnpm test';
    const events = toolCallStartEvents(toolCall({
      tool_name: `provider.namespace.${'超长工具名'.repeat(30)}`,
      tool_action: 'run',
      arguments_json: command,
    }));

    expect(events.map((event) => event.eventType)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);
    expect(events[0]?.content).toMatchObject({ toolCallName: 'Bash' });
    expect(events[0]?.content).not.toHaveProperty('icon');
    expect(events[0]?.content).not.toHaveProperty('title');
    expect(events[0]?.content).not.toHaveProperty('delta');
    expect(events[1]?.content['delta']).toBe(command);
  });

  it.each([
    ['read', 'Read'],
    ['list_files', 'List'],
    ['search', 'Search'],
    ['edit', 'Edit'],
    ['run', 'Bash'],
  ] as const)('maps action %s to toolCallName %s', (action, toolCallName) => {
    const [start] = toolCallStartEvents(toolCall({
      tool_action: action,
      arguments_json: null,
    }));
    expect(start?.content).toMatchObject({ toolCallName });
    expect(start?.content).not.toHaveProperty('icon');
    expect(start?.content).not.toHaveProperty('title');
  });

  it.each([
    ['mcp__foo__bar', 'bar'],
    ['foo.bar', 'bar'],
    ['LS', 'LS'],
  ] as const)('keeps B-tier tool %s visible as native leaf %s', (toolName, expected) => {
    const [start] = toolCallStartEvents(toolCall({
      tool_name: toolName,
      tool_action: null,
      arguments_json: 'visible args',
    }));
    expect(start?.content).toMatchObject({ toolCallName: expected });
    expect(start?.content).not.toHaveProperty('icon');
    expect(start?.content).not.toHaveProperty('title');
  });

  it('truncates oversized generic tool arguments while preserving their head', () => {
    const events = toolCallStartEvents(toolCall({
      arguments_json: `command=${'x'.repeat(4_000)}`,
    }));
    const args = String(events[1]?.content['delta']);
    expect(args).toMatch(/^command=x+/u);
    expect(args).toContain('…（已截断）');
    expect(cotEventContentBytes(events[1]!)).toBeLessThanOrEqual(
      FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
    );
  });

  it('preserves scalar-looking text and uses text-language structured details', () => {
    for (const text of ['true', '123', 'null', '{"already":"formatted"}']) {
      const start = toolCallStartEvents(toolCall({ arguments_json: text }));
      const [terminal] = toolCallResultEvents(toolCall({
        status: 'completed',
        arguments_json: null,
        result_json: `${text}\nsecond line`,
      }));
      expect(start[1]?.content['delta']).toBe(text);
      expect(terminal?.content['content']).toEqual({
        type: 'code',
        language: 'text',
        content: `${text}\nsecond line`,
      });
    }
  });

  // Detail normalization deliberately preserves provider output; keep the
  // stricter control-character behavior documented but inactive.
  it.skip('strips ANSI CSI before C0 controls so visible fragments do not remain', () => {
    const source = '\u001B[31mred\u001B[0m\u0000\u0001\rprogress\tkeep\nline';
    const start = toolCallStartEvents(toolCall({ arguments_json: source }));
    const [terminal] = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: source,
    }));
    const rendered = JSON.stringify([...start, terminal]);
    expect(rendered).not.toMatch(/\[31m|\[0m|\\u0000|\\u0001|\\r/);
    expect(rendered).toContain('red');
    expect(rendered).toContain('progress');
    expect(rendered).toContain('keep');
  });

  it('preserves provider detail bytes while enforcing the escaped-byte budget', () => {
    const detail = '\u001B[31mred\u001B[0m\u0000\rline';
    const [preserved] = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: detail,
    }));
    expect(preserved?.content['content']).toEqual({ type: 'text', text: detail });

    const [bounded] = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: `${detail}${'\u0000'.repeat(4_000)}`,
    }));
    expect(JSON.stringify(bounded)).toContain('[31mred');
    expect(JSON.stringify(bounded)).toContain('…（已截断）');
    expect(cotEventContentBytes(bounded!)).toBeLessThanOrEqual(
      FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
    );
  });

  it('renders a mixed content-block fallback as compact JSON in a text code block', () => {
    const mixed = [
      { type: 'text', text: 'one' },
      {
        type: 'image',
        source: { type: 'base64', data: 'safe-placeholder'.repeat(8) },
      },
    ];
    const compact = JSON.stringify(mixed);
    const [terminal] = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: compact,
    }));

    expect(terminal?.content['content']).toEqual({
      type: 'code',
      language: 'text',
      content: compact,
    });
  });

  it('keeps ordinary tool arguments out of successful result content', () => {
    const [terminal] = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: 'command\nline',
      result_json: 'success\noutput',
    }));
    expect(terminal?.content['content']).toEqual({
      type: 'code',
      language: 'text',
      content: 'success\noutput',
    });
    expect(JSON.stringify(terminal?.content['content'])).not.toContain('command');
  });

  it('keeps the failure marker and result without repeating ordinary tool arguments', () => {
    const [terminal] = toolCallResultEvents(toolCall({
      status: 'failed',
      arguments_json: 'command\nline',
      result_json: 'failure\noutput',
    }));
    expect(terminal?.content['content']).toEqual([
      { type: 'text', text: '执行失败' },
      { type: 'code', language: 'text', content: 'failure\noutput' },
    ]);
  });

  it('uses short text for one short single-line detail and fixed status for no detail', () => {
    expect(toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: 'ok',
    }))[0]?.content['content']).toEqual({ type: 'text', text: 'ok' });
    expect(toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: null,
    }))[0]?.content['content']).toEqual({ type: 'text', text: '执行完成' });
  });

  it.each([
    [
      'mcp__teammate__spawn',
      {
        name_prefix: 'reviewer',
        prompt: 'Review the implementation.',
        intent: '检查实现',
        agent_runtime: 'codex',
        identity: 'Read-only reviewer',
      },
      '分派成员 检查实现',
      {
        type: 'code',
        language: 'text',
        content: 'Agent Runtime：codex\nIdentity：Read-only reviewer\nPrompt：Review the implementation.',
      },
    ],
    [
      'teammate.send',
      { name: 'reviewer-2', prompt: 'Please re-check.' },
      '发送消息 → reviewer-2',
      {
        type: 'code',
        language: 'text',
        content: '目标：reviewer-2\nPrompt：Please re-check.',
      },
    ],
    [
      'mcp__teammate__close',
      { name: 'reviewer-2', note: 'review complete' },
      '关闭成员 reviewer-2',
      { type: 'text', text: 'review complete' },
    ],
    [
      'teammate.workflow_run',
      {
        script: "export const meta = { name: 'parallel-review', description: 'x' };\nreturn null;",
      },
      'Workflow parallel-review',
      {
        type: 'code',
        language: 'javascript',
        content: "export const meta = { name: 'parallel-review', description: 'x' };\nreturn null;",
      },
    ],
  ] as const)(
    'uses title plus result presentation for built-in tool %s',
    (toolName, args, title, expectedResult) => {
      const event = toolCall({
        tool_name: toolName,
        tool_action: null,
        arguments_json: JSON.stringify(args),
      });
      const start = toolCallStartEvents(event);
      const result = toolCallResultEvents({
        ...event,
        status: 'completed',
        result_json: JSON.stringify({ ignored: true }),
      });

      expect(start.map((item) => item.eventType)).toEqual([
        'TOOL_CALL_START',
        'TOOL_CALL_END',
      ]);
      expect(start[0]?.content).toMatchObject({ title });
      expect(start[0]?.content).not.toHaveProperty('icon');
      expect(result[0]?.content['content']).toEqual(expectedResult);
      expect(JSON.stringify([...start, ...result])).not.toContain('ignored');
    },
  );

  it('uses the bare spawn title for an empty intent and optional defaults', () => {
    const event = toolCall({
      tool_name: 'teammate.spawn',
      tool_action: null,
      arguments_json: JSON.stringify({
        name_prefix: 'worker',
        prompt: 'Implement the task.',
        intent: '',
      }),
    });
    const [start] = toolCallStartEvents(event);
    const [result] = toolCallResultEvents({ ...event, status: 'completed' });

    expect(start?.content['title']).toBe('分派成员');
    expect(result?.content['content']).toEqual({
      type: 'code',
      language: 'text',
      content: 'Agent Runtime：未指定\nIdentity：未指定\nPrompt：Implement the task.',
    });
  });

  it.each([
    ['missing field', JSON.stringify({ name: 'worker' }), false],
    ['invalid JSON', '{"name":', false],
    ['truncated arguments', JSON.stringify({ name: 'worker', prompt: 'hello' }), true],
  ] as const)('falls back to B-tier args for %s', (_label, argumentsJson, truncated) => {
    const start = toolCallStartEvents(toolCall({
      tool_name: 'mcp__teammate__send',
      tool_action: null,
      arguments_json: argumentsJson,
      arguments_truncated: truncated,
    }));

    expect(start[0]?.content).toMatchObject({ toolCallName: 'send' });
    expect(start[0]?.content).not.toHaveProperty('title');
    expect(start.map((event) => event.eventType)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ]);
  });

  it('keeps workflow script display when meta.name cannot be extracted', () => {
    const script = 'const meta = dynamicMeta();\nreturn meta;';
    const event = toolCall({
      tool_name: 'mcp__teammate__workflow_run',
      tool_action: null,
      arguments_json: JSON.stringify({ script }),
    });
    const [start] = toolCallStartEvents(event);
    const [result] = toolCallResultEvents({ ...event, status: 'completed' });

    expect(start?.content['title']).toBe('Workflow');
    expect(result?.content['content']).toEqual({
      type: 'code',
      language: 'javascript',
      content: script,
    });
  });

  it('uses Workflow plus a text result for a scriptPath invocation', () => {
    const event = toolCall({
      tool_name: 'teammate.workflow_run',
      tool_action: null,
      arguments_json: JSON.stringify({ scriptPath: '/workspace/review.ts' }),
    });
    const [start] = toolCallStartEvents(event);
    const [result] = toolCallResultEvents({ ...event, status: 'completed' });

    expect(start?.content['title']).toBe('Workflow');
    expect(result?.content['content']).toEqual({
      type: 'text',
      text: '/workspace/review.ts',
    });
  });

  it('keeps the head of an oversized workflow script within the 4KB event budget', () => {
    const script = `export const meta = { name: 'large' };\n${'run();\n'.repeat(2_000)}`;
    const event = toolCall({
      tool_name: 'teammate.workflow_run',
      tool_action: null,
      arguments_json: JSON.stringify({ script }),
    });
    const [result] = toolCallResultEvents({ ...event, status: 'completed' });
    const rendered = JSON.stringify(result?.content['content']);

    expect(rendered).toContain("export const meta = { name: 'large' }");
    expect(rendered).toContain('…（已截断）');
    expect(cotEventContentBytes(result!)).toBeLessThanOrEqual(
      FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
    );
  });

  it.each([
    ['mcp__feishu__reply', undefined, 'write', '回复飞书消息'],
    ['feishu.react', undefined, 'default', '点击飞书表情'],
    ['primary.list_chat_bots', 'primary', 'search', '查看群机器人'],
  ] as const)('uses one-line projection for owned tool %s', (toolName, channelId, icon, title) => {
      const start = toolCallStartEvents(toolCall({
        tool_name: toolName,
        tool_action: null,
        arguments_json: JSON.stringify({ chat_id: 'private-chat', message_id: 'private-message' }),
      }), channelId);
      const terminal = toolCallResultEvents(toolCall({
        tool_name: toolName,
        tool_action: null,
        status: 'completed',
        result_json: JSON.stringify({ open_id: 'private-user' }),
      }), channelId);
      const rendered = JSON.stringify([...start, ...terminal]);

      expect(start.map((event) => event.eventType)).toEqual([
        'TOOL_CALL_START',
        'TOOL_CALL_END',
      ]);
      expect(start[0]?.content).toMatchObject({ icon, title });
      expect(terminal[0]?.content['content']).toEqual({ type: 'text', text: '执行完成' });
      expect(rendered).not.toMatch(/private-chat|private-message|private-user/);
  });

  it.each([
    ['mcp__other__reply', undefined],
    ['reply', undefined],
  ] as const)('does not treat non-owned tool %s as Feishu-owned', (toolName, channelId) => {
    const events = toolCallStartEvents(toolCall({
      tool_name: toolName,
      tool_action: null,
      arguments_json: 'visible-argument',
    }), channelId);
    expect(events.map((event) => event.eventType)).toContain('TOOL_CALL_ARGS');
  });

  it('measures the JSON-escaped serialization and never emits an oversized result event', () => {
    const hostile = `${'"\\\n\t🙂'.repeat(2_000)}${'四字节🙂'.repeat(2_000)}`;
    for (const status of ['completed', 'failed'] as const) {
      const events = toolCallResultEvents(toolCall({
        status,
        arguments_json: hostile,
        result_json: hostile,
        arguments_truncated: true,
        result_truncated: true,
      }));
      expect(events).toHaveLength(1);
      expect(cotEventContentBytes(events[0]!)).toBeLessThanOrEqual(
        FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
      );
      expect(JSON.stringify(events)).toContain('…（已截断）');
    }
  });

  it('shrinks result before arguments when the assembled content exceeds the hard budget', () => {
    const argumentsText = 'argument-kept';
    const content = assembleToolResultContent({
      failed: true,
      argumentsText,
      resultText: 'result'.repeat(4_000),
    });
    expect(Buffer.byteLength(JSON.stringify(content), 'utf8')).toBeLessThan(4_096);
    expect(content).toEqual(expect.arrayContaining([
      { type: 'text', text: '执行失败' },
      { type: 'code', language: 'text', content: argumentsText },
    ]));
    expect(JSON.stringify(content)).toContain('…（已截断）');
  });

  it('marks Core-truncated arguments and results even when locally short', () => {
    const start = toolCallStartEvents(toolCall({
      arguments_json: 'args',
      arguments_truncated: true,
    }));
    const terminal = toolCallResultEvents(toolCall({
      status: 'completed',
      arguments_json: null,
      result_json: 'result',
      result_truncated: true,
    }));
    expect(JSON.stringify([...start, ...terminal])).toContain('…（已截断）');
  });

  it('keeps local batch estimates above the transport recording', async () => {
    const requests: unknown[] = [];
    const cot = createFeishuCotClient({
      request: async (request: unknown): Promise<{ code: number }> => {
        requests.push(request);
        return { code: 0 };
      },
    } as never, { now: () => 1_725_000_000_000 });
    const events = [{
      eventType: 'TEXT_"\\\u0000中文',
      content: {
        text: '引号"、反斜杠\\、控制\u0000\u0001与中文🙂',
        nested: ['line\nfeed', { value: '\tquoted"value' }],
      },
    }];
    const input = {
      cotId: 'cot-"\\\u0003中文',
      messageId: 'message-"\\\u0004中文',
      events,
    };

    await cot.appendCot(input);
    const request = requests[0] as { readonly data?: unknown };
    const actual = Buffer.byteLength(JSON.stringify(request.data), 'utf8');
    expect(cotAppendBatchBytes(input)).toBeGreaterThanOrEqual(actual);
  });
});
