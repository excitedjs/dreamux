/** Synthetic v2 notifications through the production collector and manager. */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentRuntimeEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { TurnManager } from '../src/turn-manager.js';
import { CodexReasoningEffort } from '../src/reasoning-effort.js';
import type { CodexWsClient } from '../src/rpc.js';
import { FakeCodexWsClient } from './helpers/codex-runtime-fakes.js';

const managers: TurnManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});
const logger: DreamuxLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child: () => logger,
};

async function harness() {
  const client = new FakeCodexWsClient({ autoComplete: false });
  const native = client as unknown as CodexWsClient;
  const events: AgentRuntimeEvent[] = [];
  const manager = new TurnManager({
    threadId: 'thread',
    client: native,
    codec: null,
    reasoning: new CodexReasoningEffort(
      native,
      { model: 'fixture', reasoningEffort: null },
      false,
      '/fake/cwd',
    ),
    events: (event) => events.push(event),
    logger,
  });
  managers.push(manager);
  const admission = await manager.submitInput({ text: 'think' });
  if (admission.status !== 'submitted') throw new Error('admission failed');
  const delta = (
    carrier: 'summary' | 'content',
    index: number,
    text: string,
    itemId = 'reason',
    threadId = 'thread',
    turnId = 'turn-1',
  ) =>
    client.emit({
      method:
        carrier === 'summary'
          ? 'item/reasoning/summaryTextDelta'
          : 'item/reasoning/textDelta',
      params: {
        threadId,
        turnId,
        itemId,
        delta: text,
        [carrier === 'summary' ? 'summaryIndex' : 'contentIndex']: index,
      },
    });
  const complete = (summary: string[], content: string[], id = 'reason') =>
    client.emitItem('thread', 'turn-1', 'completed', {
      type: 'reasoning',
      id,
      summary,
      content,
    });
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
    client,
    manager,
    events,
    delta,
    complete,
    reasoning,
    submission: admission.submission,
  };
}

describe('Codex native reasoning', () => {
  it('streams the first nonempty carrier with all native indices and closes snapshots without replay', async () => {
    const h = await harness();
    h.delta('content', 0, '');
    h.delta('summary', 0, 'one ');
    h.delta('content', 0, 'other carrier');
    h.delta('summary', 0, 'two');
    h.delta('summary', 2, 'third');
    expect(h.reasoning().map((event) => event.text)).toEqual([
      'one ',
      'two',
      'third',
    ]);
    h.complete(['one two', 'completed only', 'third'], ['other carrier']);
    h.client.emitCompleted('thread', 'turn-1', 'answer');
    expect(h.reasoning()).toEqual([
      { id: 'reason', partIndex: 0, text: 'one ', status: 'streaming' },
      { id: 'reason', partIndex: 0, text: 'two', status: 'streaming' },
      { id: 'reason', partIndex: 2, text: 'third', status: 'streaming' },
      { id: 'reason', partIndex: 0, text: '', status: 'completed' },
      {
        id: 'reason',
        partIndex: 1,
        text: 'completed only',
        status: 'completed',
      },
      { id: 'reason', partIndex: 2, text: '', status: 'completed' },
    ]);
  });

  it('selects content on its first delta even when completed summary exists', async () => {
    const h = await harness();
    h.delta('content', 1, 'raw');
    h.delta('summary', 0, 'summary');
    h.complete(['summary'], ['', 'raw', 'unstreamed']);
    expect(h.reasoning()).toEqual([
      { id: 'reason', partIndex: 1, text: 'raw', status: 'streaming' },
      { id: 'reason', partIndex: 1, text: '', status: 'completed' },
      { id: 'reason', partIndex: 2, text: 'unstreamed', status: 'completed' },
    ]);
  });

  it('falls back to nonempty summary then content and preserves empty positions', async () => {
    const h = await harness();
    h.complete(['', 'summary'], ['content'], 'summary-item');
    h.complete([''], ['', 'content'], 'content-item');
    h.complete([], [], 'empty');
    expect(h.reasoning()).toEqual([
      {
        id: 'summary-item',
        partIndex: 1,
        text: 'summary',
        status: 'completed',
      },
      {
        id: 'content-item',
        partIndex: 1,
        text: 'content',
        status: 'completed',
      },
    ]);
  });

  it('ignores child threads and text deltas, retaining completed ordinary text and settlement', async () => {
    const h = await harness();
    h.delta('summary', 0, 'child reasoning', 'child-item', 'child-thread');
    h.client.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread',
        turnId: 'turn-1',
        itemId: 'answer',
        delta: 'text fragment',
      },
    });
    h.client.emitItem('thread', 'turn-1', 'started', {
      type: 'agentMessage',
      id: 'answer',
      text: 'text fragment',
    });
    expect(h.events).toEqual([]);
    h.delta('summary', 0, 'thinking');
    h.client.emitCompleted('thread', 'turn-1', 'complete answer');
    await expect(h.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'complete answer' },
    });
    expect(
      h.events.filter((event) => event.kind === 'assistant.message'),
    ).toMatchObject([{ text: 'complete answer' }]);
    expect(h.reasoning().map((event) => event.status)).toEqual([
      'streaming',
      'completed',
    ]);
    expect(
      h.events.findIndex((event) => event.kind === 'turn.ended'),
    ).toBeGreaterThan(
      h.events.findIndex(
        (event) =>
          event.kind === 'assistant.reasoning' && event.status === 'completed',
      ),
    );
  });

  it.each(['interrupted', 'failed', 'protocol', 'stop'] as const)(
    'closes open parts on %s without replaying or changing settlements',
    async (terminal) => {
      const h = await harness();
      h.delta('summary', 0, 'a');
      h.delta('summary', 3, 'b');
      if (terminal === 'interrupted')
        h.client.emitTurnInterrupted('thread', 'turn-1');
      else if (terminal === 'failed')
        h.client.emitScopedError('thread', 'turn-1', 'failed');
      else if (terminal === 'protocol')
        h.client.emitUnscopedError('thread', 'lost');
      else await h.manager.stop();
      expect(h.reasoning()).toEqual([
        { id: 'reason', partIndex: 0, text: 'a', status: 'streaming' },
        { id: 'reason', partIndex: 3, text: 'b', status: 'streaming' },
        { id: 'reason', partIndex: 0, text: '', status: 'completed' },
        { id: 'reason', partIndex: 3, text: '', status: 'completed' },
      ]);
      const result = await h.submission.settled;
      expect(result.kind).toBe(
        terminal === 'stop'
          ? 'stopped'
          : terminal === 'protocol'
            ? 'failed'
            : 'completion',
      );
      expect(
        h.events.filter((event) => event.kind === 'turn.result'),
      ).toHaveLength(terminal === 'failed' ? 1 : 0);
    },
  );
});
