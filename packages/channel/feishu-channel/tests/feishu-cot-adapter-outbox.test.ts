import { describe, expect, it } from 'vitest';

import { FeishuCotAdapter } from '../src/feishu-cot-adapter.js';
import {
  cotEventBytes,
  FEISHU_COT_APPEND_MAX_BYTES,
} from '../src/feishu-cot-events.js';
import { assistant, harness, submitted, toolCall } from './helpers/cot-fixtures.js';
import { settleCot } from './helpers/fake-cot-client.js';

function queuedTaskCount(adapter: FeishuCotAdapter): number {
  return (adapter as unknown as { pending: Set<Promise<void>> }).pending.size;
}

function openCallCount(adapter: FeishuCotAdapter): number {
  const leaders = (adapter as unknown as {
    leaders: Map<string, { openCalls: Map<string, unknown> }>;
  }).leaders;
  return [...leaders.values()][0]?.openCalls.size ?? 0;
}

describe('adapter outbox and resource bounds', () => {
  it('safely truncates an oversized assistant while preserving its event pair', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({
      content: '中文🙂'.repeat(100_000),
    }));
    await settleCot(32);

    const events = cot.eventsFor('cot-1');
    expect(events.filter((event) =>
      event.eventType === 'TEXT_MESSAGE_START')).toHaveLength(2);
    expect(events.filter((event) =>
      event.eventType === 'TEXT_MESSAGE_END')).toHaveLength(2);
    const deltas = events
      .filter((event) => event.eventType === 'TEXT_MESSAGE_CONTENT')
      .map((event) => String(event.content['delta']));
    expect(deltas.at(-1)).toBe('…（已截断）');
    expect(deltas.join('')).not.toContain('\uFFFD');
    expect(events.reduce((total, event) =>
      total + cotEventBytes({
        eventType: event.eventType,
        content: event.content,
      }), 0)).toBeLessThan(256 * 1_024);
  });

  it('admits or drops each projected activity as one semantic group', async () => {
    const { adapter, cot } = harness();
    const releaseCreate = cot.blockNextCreate();
    adapter.onTurnSubmitted(submitted());
    for (let index = 0; index < 131; index += 1) {
      adapter.onTurnMessage(assistant({
        event_id: `fill-${index}`,
        content: 'x',
      }));
    }
    adapter.onTurnToolCall(toolCall({
      call_id: 'accepted-call',
      arguments_json: null,
    }));
    adapter.onTurnToolCall(toolCall({ call_id: 'rejected-call' }));
    adapter.onTurnToolCall(toolCall({
      call_id: 'rejected-call',
      status: 'completed',
      result_json: JSON.stringify({ ok: true }),
    }));
    releaseCreate();
    await settleCot(32);

    const types = cot.eventTypesFor('cot-1');
    expect(types.filter((type) => type === 'TOOL_CALL_START')).toHaveLength(1);
    expect(types.filter((type) => type === 'TOOL_CALL_END')).toHaveLength(1);
    expect(types).not.toContain('TOOL_CALL_RESULT');
  });

  it('admits a minimal terminal into the remaining outbox slot', async () => {
    const { adapter, cot } = harness();
    const releaseCreate = cot.blockNextCreate();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnToolCall(toolCall({
      call_id: 'accepted-before-fill',
      arguments_json: null,
    }));
    for (let index = 0; index < 132; index += 1) {
      adapter.onTurnMessage(assistant({
        event_id: `fill-after-start-${index}`,
        content: 'x',
      }));
    }
    expect(openCallCount(adapter)).toBe(1);
    adapter.onTurnToolCall(toolCall({
      event_id: 'rejected-terminal',
      call_id: 'accepted-before-fill',
      status: 'completed',
      result_json: JSON.stringify({ ok: true }),
    }));
    expect(openCallCount(adapter)).toBe(0);

    releaseCreate();
    await settleCot(32);
    expect(cot.eventTypesFor('cot-1')).toContain('TOOL_CALL_RESULT');
  });

  it('keeps every append at 50 events and 64 KiB or less', async () => {
    const { adapter, cot } = harness();
    const releaseCreate = cot.blockNextCreate();
    adapter.onTurnSubmitted(submitted());
    for (let index = 0; index < 20; index += 1) {
      adapter.onTurnMessage(assistant({
        event_id: `large-${index}`,
        content: `chunk-${index}-${'中🙂'.repeat(500)}`,
      }));
    }
    releaseCreate();
    await settleCot(24);

    expect(cot.appendRequests().length).toBeGreaterThan(1);
    for (const request of cot.appendRequests()) {
      const events = request.data?.['events'] as unknown[];
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(request.data), 'utf8'))
        .toBeLessThanOrEqual(
        FEISHU_COT_APPEND_MAX_BYTES,
        );
    }
  });

  it('coalesces a slow append to one running and one queued flush', async () => {
    const { adapter, cot } = harness();
    adapter.onTurnSubmitted(submitted());
    adapter.onTurnMessage(assistant({ event_id: 'initial' }));
    await settleCot();
    const releaseAppend = cot.blockNextAppend();

    for (let index = 0; index < 120; index += 1) {
      adapter.onTurnMessage(assistant({ event_id: `burst-${index}` }));
    }
    await settleCot();
    expect(queuedTaskCount(adapter)).toBeLessThanOrEqual(2);

    releaseAppend();
    await settleCot(32);
    expect(queuedTaskCount(adapter)).toBe(0);
    expect(cot.eventsFor('cot-1')).toHaveLength(7 + 120 * 3);
  });
});
