/**
 * Unit tests for the Codex turn collector (issue #126 PR8).
 *
 * Runtime-local history is the production consumer that observes
 * `turn/completed`; the dispatcher path is submit-then-return. These assert the
 * two PR8 additions:
 *   - onTrace observes EVERY notification (before filtering), the diagnostic
 *     stream that can explain a stalled turn.
 *   - acceptAnyThread resolves on a turn/completed even when its threadId field
 *     does not match — the single-thread worker robustness fix — while the
 *     default (strict) path still filters foreign threads.
 */

import { describe, expect, it } from 'vitest';

import {
  subscribeTurnCollection,
  type TurnTraceEvent,
} from '../src/agent-runtime/builtin/codex/events.js';
import type { CodexWsClient } from '../src/agent-runtime/builtin/codex/rpc.js';

/** Minimal CodexWsClient stub exposing only the onNotification seam + emit. */
function fakeClient(): {
  client: CodexWsClient;
  emit: (notif: { method: string; params: unknown }) => void;
} {
  let handler: ((n: { method: string; params: unknown }) => void) | null = null;
  const client = {
    onNotification(h: (n: { method: string; params: unknown }) => void): void {
      handler = h;
    },
  } as unknown as CodexWsClient;
  return { client, emit: (notif) => handler?.(notif) };
}

describe('subscribeTurnCollection (issue #126 PR8)', () => {
  it('traces every notification before filtering', () => {
    const { client, emit } = fakeClient();
    const trace: TurnTraceEvent[] = [];
    subscribeTurnCollection(client, 'thread-A', {
      onTrace: (e) => trace.push(e),
    });

    emit({ method: 'token_count', params: { threadId: 'thread-A', usage: 1 } });
    emit({
      method: 'item/completed',
      params: { threadId: 'thread-B', turnId: 't1', item: { type: 'reasoning' } },
    });

    expect(trace.map((e) => e.method)).toEqual(['token_count', 'item/completed']);
    // The foreign-thread item is traced but reported unmatched.
    expect(trace[1]).toMatchObject({
      method: 'item/completed',
      threadId: 'thread-B',
      itemType: 'reasoning',
      matched: false,
    });
  });

  it('strict mode ignores a turn/completed for a foreign thread', async () => {
    const { client, emit } = fakeClient();
    const collector = subscribeTurnCollection(client, 'thread-A');
    let resolved = false;
    void collector.awaitTurn().then(() => {
      resolved = true;
    });

    emit({
      method: 'turn/completed',
      params: { threadId: 'thread-OTHER', turn: { id: 't1', items: [] } },
    });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
  });

  it('acceptAnyThread resolves on a turn/completed with a mismatched threadId', async () => {
    const { client, emit } = fakeClient();
    const collector = subscribeTurnCollection(client, 'thread-A', {
      acceptAnyThread: true,
    });

    // The worker app-server hosts exactly one thread; a completion whose threadId
    // field does not match (a protocol field-shape drift) must still complete the
    // worker instead of stalling to the turn timeout.
    emit({
      method: 'item/completed',
      params: {
        threadId: null,
        turnId: 't1',
        item: { type: 'agentMessage', id: 'a1', text: 'done' },
      },
    });
    emit({
      method: 'turn/completed',
      params: { threadId: null, turn: { id: 't1', items: [] } },
    });

    const turn = await collector.awaitTurn();
    expect(turn.turnId).toBe('t1');
    expect(turn.items.map((i) => i.type)).toEqual(['agentMessage']);
  });
});
