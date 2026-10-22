/** Synthetic stream-json frames; upstream/live evidence is recorded separately. */
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeEvent } from '@excitedjs/dreamux-types';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import {
  createNativeActivityState,
  endNativeTurn,
  handleProtocolEvent,
} from '../src/runtime-activity.js';

const sessions: ClaudeCodeStreamRpc[] = [];
afterEach(() => {
  for (const rpc of sessions.splice(0)) rpc.stop();
});

function harness() {
  const events: AgentRuntimeEvent[] = [];
  const sink = (event: AgentRuntimeEvent) => {
    events.push(event);
  };
  const context = { activity: createNativeActivityState(sink), events: sink };
  const rpc = new ClaudeCodeStreamRpc(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    {
      sessionId: 'session',
      turnTimeoutMs: 10_000,
      events: sink,
      reapOnTimeout: () => {},
      onProtocolEvent: (event) => handleProtocolEvent(event, context),
    },
  );
  sessions.push(rpc);
  const emit = (raw: Record<string, unknown>) =>
    rpc.onStdoutChunk(JSON.stringify(raw) + '\n');
  let ordinal = 0;
  const partial = (
    event: Record<string, unknown>,
    fields: Record<string, unknown> = {},
  ) =>
    emit({
      type: 'stream_event',
      uuid: `envelope-${ordinal++}`,
      event,
      ...fields,
    });
  const start = (id = 'api-message') =>
    partial({ type: 'message_start', message: { id } });
  const block = (index: number, type = 'thinking') =>
    partial({ type: 'content_block_start', index, content_block: { type } });
  const delta = (
    index: number,
    thinking: string,
    fields: Record<string, unknown> = {},
  ) =>
    partial(
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking },
      },
      fields,
    );
  const stop = (index: number) =>
    partial({ type: 'content_block_stop', index });
  const snapshot = (
    content: unknown[],
    id = 'api-message',
    uuid = 'snapshot',
    fields: Record<string, unknown> = {},
  ) => emit({ type: 'assistant', uuid, message: { id, content }, ...fields });
  const reasoning = () =>
    events
      .filter((event) => event.kind === 'assistant.reasoning')
      .map(({ id, partIndex, text, status }) => ({
        id,
        partIndex,
        text,
        status,
      }));
  return {
    rpc,
    events,
    emit,
    partial,
    start,
    block,
    delta,
    stop,
    snapshot,
    reasoning,
    end: () => endNativeTurn('interrupted', null, context),
  };
}

describe('Claude native reasoning', () => {
  it('preserves text/tool ordering in completed envelopes with multiple block kinds', () => {
    const h = harness();
    h.snapshot([
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'reasoning' },
      {
        type: 'tool_use',
        id: 'tool',
        name: 'Read',
        input: { file_path: 'file' },
      },
    ]);
    expect(h.events.map((event) => event.kind)).toEqual([
      'assistant.message',
      'assistant.reasoning',
      'tool.call',
    ]);
  });

  it('correlates singleton snapshots to native block indices and keeps text completed-only', () => {
    const h = harness();
    h.start();
    h.block(0);
    h.delta(0, 'think ');
    h.delta(0, 'first');
    expect(h.reasoning().map((event) => event.text)).toEqual([
      'think ',
      'first',
    ]);
    h.snapshot([
      {
        type: 'thinking',
        thinking: 'think first',
        signature: 'private-signature',
      },
    ]);
    h.stop(0);
    h.block(1, 'text');
    h.partial({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    });
    expect(
      h.events.filter((event) => event.kind === 'assistant.message'),
    ).toEqual([]);
    h.snapshot(
      [{ type: 'text', text: 'answer' }],
      'api-message',
      'text-envelope',
    );
    h.stop(1);
    h.block(2);
    h.delta(2, 'second');
    h.snapshot(
      [{ type: 'thinking', thinking: 'second' }],
      'api-message',
      'second-thinking',
    );
    h.stop(2);
    h.block(3);
    h.snapshot([{ type: 'thinking', thinking: 'no deltas' }]);
    h.stop(3);
    h.partial({ type: 'message_stop' });
    expect(h.reasoning()).toEqual([
      { id: 'api-message', partIndex: 0, text: 'think ', status: 'streaming' },
      { id: 'api-message', partIndex: 0, text: 'first', status: 'streaming' },
      { id: 'api-message', partIndex: 0, text: '', status: 'completed' },
      { id: 'api-message', partIndex: 2, text: 'second', status: 'streaming' },
      { id: 'api-message', partIndex: 2, text: '', status: 'completed' },
      {
        id: 'api-message',
        partIndex: 3,
        text: 'no deltas',
        status: 'completed',
      },
    ]);
    expect(
      h.events.filter((event) => event.kind === 'assistant.message'),
    ).toMatchObject([{ id: 'text-envelope', text: 'answer' }]);
  });

  it('uses native envelope positions without partial context, excluding signatures and encrypted blocks', () => {
    const h = harness();
    h.snapshot(
      [
        { type: 'redacted_thinking', data: 'encrypted' },
        { type: 'thinking', thinking: 'plain', signature: 'signature' },
        { type: 'thinking', thinking: '' },
      ],
      'api-message',
      'native-envelope',
    );
    expect(h.reasoning()).toEqual([
      {
        id: 'native-envelope',
        partIndex: 1,
        text: 'plain',
        status: 'completed',
      },
    ]);
    h.start();
    h.block(4, 'redacted_thinking');
    h.partial({
      type: 'content_block_delta',
      index: 4,
      delta: { type: 'signature_delta', signature: 'signature' },
    });
    h.stop(4);
    expect(h.reasoning()).toHaveLength(1);
  });

  it('retains lower-block deduplication after abandoned_blocks and closes all open parts', () => {
    const h = harness();
    h.start();
    h.block(0);
    h.delta(0, 'lower');
    h.stop(0);
    h.block(2);
    h.delta(2, 'abandoned');
    h.partial(
      { type: 'message_stop' },
      {
        abandoned_blocks: {
          api_message_id: 'api-message',
          from_block_index: 2,
        },
      },
    );
    h.snapshot([{ type: 'thinking', thinking: 'lower' }]);
    expect(h.reasoning().map((event) => event.text)).toEqual([
      'lower',
      '',
      'abandoned',
      '',
    ]);
    // The upstream contract permits a retry without partial messages under a new id.
    h.snapshot(
      [{ type: 'thinking', thinking: 'retry snapshot' }],
      'retry-api',
      'retry-envelope',
    );
    expect(h.reasoning().at(-1)).toEqual({
      id: 'retry-envelope',
      partIndex: 0,
      text: 'retry snapshot',
      status: 'completed',
    });
  });

  it('retains native indices across stops and late singleton snapshots without replay', () => {
    const h = harness();
    h.start();
    h.block(1);
    h.delta(1, 'streamed');
    h.stop(1);
    h.block(4);
    h.stop(4);
    h.snapshot([{ type: 'thinking', thinking: 'streamed' }]);
    h.snapshot([{ type: 'thinking', thinking: 'completed only' }]);
    expect(h.reasoning()).toEqual([
      {
        id: 'api-message',
        partIndex: 1,
        text: 'streamed',
        status: 'streaming',
      },
      { id: 'api-message', partIndex: 1, text: '', status: 'completed' },
      {
        id: 'api-message',
        partIndex: 4,
        text: 'completed only',
        status: 'completed',
      },
    ]);
  });

  it('filters subagent partials and snapshots before they affect main-stream identity', () => {
    const h = harness();
    h.start();
    h.block(0);
    h.delta(0, 'main ');
    const child = { parent_tool_use_id: 'agent-tool' };
    h.partial({ type: 'message_start', message: { id: 'child-api' } }, child);
    h.partial(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      },
      child,
    );
    h.delta(0, 'child', child);
    h.snapshot(
      [{ type: 'thinking', thinking: 'child' }],
      'child-api',
      'child-envelope',
      child,
    );
    h.partial({ type: 'message_stop' }, child);
    h.delta(0, 'continues');
    h.stop(0);
    expect(h.reasoning().map((event) => event.text)).toEqual([
      'main ',
      'continues',
      '',
    ]);
    expect(h.reasoning().every((event) => event.id === 'api-message')).toBe(
      true,
    );
  });

  it('requires native identity, accepting explicit api_message_id when message_start was missed', () => {
    const h = harness();
    h.delta(0, 'orphan');
    h.partial({ type: 'message_start', message: {} });
    h.block(0);
    h.delta(0, 'still no id');
    expect(h.events).toEqual([]);
    h.delta(7, 'native id', { api_message_id: 'known-api' });
    h.partial({ type: 'message_stop' }, { api_message_id: 'known-api' });
    expect(h.reasoning()).toEqual([
      { id: 'known-api', partIndex: 7, text: 'native id', status: 'streaming' },
      { id: 'known-api', partIndex: 7, text: '', status: 'completed' },
    ]);
  });

  it.each(['result', 'interrupted', 'teardown'] as const)(
    'closes open parts at %s and releases turn-local correlation',
    (terminal) => {
      const h = harness();
      h.start();
      h.block(2);
      h.delta(2, 'unfinished');
      if (terminal === 'teardown') h.end();
      else
        h.emit({
          type: 'result',
          subtype: 'success',
          uuid: 'result-envelope',
          result: '',
          ...(terminal === 'interrupted'
            ? { terminal_reason: 'aborted_streaming' }
            : {}),
        });
      expect(h.reasoning()).toEqual([
        {
          id: 'api-message',
          partIndex: 2,
          text: 'unfinished',
          status: 'streaming',
        },
        { id: 'api-message', partIndex: 2, text: '', status: 'completed' },
      ]);
      expect(
        h.events.findIndex((event) => event.kind === 'turn.ended'),
      ).toBeGreaterThan(1);
      expect(
        h.events.find((event) => event.kind === 'turn.ended'),
      ).toMatchObject({
        status: terminal === 'result' ? 'completed' : 'interrupted',
      });
      h.start();
      h.block(2);
      h.delta(2, 'new turn');
      expect(h.reasoning().at(-1)?.text).toBe('new turn');
    },
  );

  it('keeps partial text out of native completion settlement', async () => {
    const h = harness();
    const admission = await h.rpc.submit('request', 'command');
    if (admission.status !== 'submitted') throw new Error('admission failed');
    h.emit({
      type: 'command_lifecycle',
      command_uuid: 'command',
      state: 'started',
    });
    h.start();
    h.block(0);
    h.delta(0, 'reasoning');
    h.snapshot([{ type: 'thinking', thinking: 'reasoning' }]);
    h.stop(0);
    h.block(1, 'text');
    h.partial({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'fragment' },
    });
    h.snapshot([{ type: 'text', text: 'full answer' }]);
    h.stop(1);
    h.emit({
      type: 'result',
      subtype: 'success',
      uuid: 'result',
      result: 'full answer',
    });
    await expect(admission.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'full answer' },
    });
    expect(
      h.events.filter((event) => event.kind === 'turn.result'),
    ).toHaveLength(1);
  });
});
