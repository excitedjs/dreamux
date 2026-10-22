/** Native result/admission races through the production collector; no live model. */
import { describe, expect, it } from 'vitest';
import type {
  DreamuxLogger,
  RuntimeAdmission,
  RuntimeCompletion,
} from '@excitedjs/dreamux-types';
import type { CodexWsClient } from '../src/rpc.js';
import { TurnManager } from '../src/turn-manager.js';
import { CodexReasoningEffort } from '../src/reasoning-effort.js';
import { compileCodexOutputSchema } from '../src/output-schema-codec.js';
import { FakeCodexWsClient, waitFor } from './helpers/codex-runtime-fakes.js';

const logger: DreamuxLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child: () => logger,
};
function submitted(admission: RuntimeAdmission) {
  if (admission.status !== 'submitted')
    throw new Error(`admission: ${admission.status}`);
  return admission.submission;
}
function fixture(codec = false) {
  const client = new FakeCodexWsClient({ autoComplete: false });
  const native = client as unknown as CodexWsClient;
  const published: RuntimeCompletion[] = [];
  const manager = new TurnManager({
    threadId: 'thread',
    client: native,
    codec: codec
      ? compileCodexOutputSchema({
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        })
      : null,
    reasoning: new CodexReasoningEffort(
      native,
      { model: 'fixture', reasoningEffort: null },
      false,
      '/fake/cwd',
    ),
    events: (event) => {
      if (event.kind === 'turn.result') published.push(event.completion);
    },
    logger,
  });
  // C has a live late-admission consumer only while its native request is in flight.
  const retained = () =>
    (manager as unknown as { nativeTurns: ReadonlyMap<string, unknown> })
      .nativeTurns.size;
  async function pending() {
    client.block('turn/start');
    const admission = manager.submitInput({
      text: 'pending native acknowledgement',
    });
    await waitFor(() => client.hasBlocked('turn/start'));
    return { admission };
  }
  return { client, manager, published, retained, pending };
}

describe('observed Codex results outlive admission failure and stop', () => {
  it.each(['stop', 'protocol'] as const)(
    'publishes several normal/failed terminals before pending admission and preserves them across %s failure',
    async (failure) => {
      const f = fixture();
      const bound = submitted(
        await f.manager.submitInput({ text: 'bound terminal' }),
      );
      const unobserved = submitted(
        await f.manager.submitInput({ text: 'no terminal' }),
      );
      const pending = await f.pending();
      f.client.emitCompleted('thread', 'background-first', 'first');
      f.client.emitTurnFailed('thread', 'background-failed', 'native failure');
      f.client.emitTurnInterrupted('thread', 'background-interrupted');
      f.client.emitCompleted(
        'thread',
        'turn-1',
        'bound behind the former blocked head',
      );
      f.client.emitCompleted('thread', 'background-last', 'last');
      expect(f.published).toEqual([
        { status: 'completed', resultText: 'first' },
        { status: 'failed', error: expect.any(Error) },
        {
          status: 'completed',
          resultText: 'bound behind the former blocked head',
        },
        { status: 'completed', resultText: 'last' },
      ]);
      const observed = await bound.settled;
      if (observed.kind !== 'completion')
        throw new Error('observed answer not selected');
      expect(observed.completion).toBe(f.published[2]);
      const stop = failure === 'stop' ? f.manager.stop() : null;
      if (failure === 'protocol')
        f.client.emitUnscopedError('thread', 'protocol lost');
      f.client.release('turn/start', { turn: { id: 'turn-1' } });
      const late = await submitted(await pending.admission).settled;
      if (late.kind !== 'completion')
        throw new Error('late observed answer stranded');
      expect(late.completion).toBe(observed.completion);
      await stop;
      expect(await unobserved.settled).toEqual(
        failure === 'stop'
          ? { kind: 'stopped' }
          : { kind: 'failed', error: expect.any(Error) },
      );
      expect(f.published).toHaveLength(4);
      await waitFor(() => f.retained() === 0);
      await f.manager.stop();
      expect(f.published).toHaveLength(4);
    },
  );

  for (const fence of ['protocol', 'stop'] as const)
    it.each([
      'completed',
      'failed',
      'interrupted-partial',
      'interrupted-empty',
      'interrupted-codec',
    ] as const)(
      `keeps the selected %s C when a positive ack is received before ${fence} but its continuation resumes later`,
      async (outcome) => {
        const f = fixture(outcome === 'interrupted-codec');
        const pending = await f.pending();
        if (outcome === 'completed')
          f.client.emitCompleted('thread', 'early', 'selected');
        else if (outcome === 'failed')
          f.client.emitTurnFailed('thread', 'early', 'selected native failure');
        else {
          if (outcome !== 'interrupted-empty')
            f.client.emitItem('thread', 'early', 'completed', {
              type: 'agentMessage',
              id: 'partial',
              text:
                outcome === 'interrupted-codec' ? 'invalid JSON' : 'partial',
            });
          f.client.emitTurnInterrupted('thread', 'early');
        }
        expect(f.retained()).toBe(1);
        expect(f.published).toHaveLength(
          outcome.startsWith('interrupted') ? 0 : 1,
        );
        // The transport already received the positive ack; no native failure can reject it now.
        f.client.release('turn/start', { turn: { id: 'early' } });
        const stop = fence === 'stop' ? f.manager.stop() : null;
        if (fence === 'protocol')
          f.client.emitUnscopedError('thread', 'later protocol failure');
        const settlement = await submitted(await pending.admission).settled;
        expect(settlement).toEqual({
          kind: 'completion',
          completion:
            outcome === 'failed' || outcome === 'interrupted-codec'
              ? { status: 'failed', error: expect.any(Error) }
              : {
                  status: 'completed',
                  resultText:
                    outcome === 'interrupted-empty'
                      ? null
                      : outcome === 'completed'
                        ? 'selected'
                        : 'partial',
                },
        });
        if (settlement.kind !== 'completion') throw new Error('C lost');
        expect(Object.isFrozen(settlement.completion)).toBe(true);
        if (!outcome.startsWith('interrupted'))
          expect(settlement.completion).toBe(f.published[0]);
        await stop;
        await waitFor(() => f.retained() === 0);
        await f.manager.stop();
        expect(f.published).toHaveLength(
          outcome.startsWith('interrupted') ? 0 : 1,
        );
      },
    );

  it.each(['protocol', 'stop', 'negative-ack'] as const)(
    'retires C on an ambiguous %s admission without returning a submission or publishing again',
    async (failure) => {
      const f = fixture();
      const pending = await f.pending();
      f.client.emitCompleted(
        'thread',
        'unbound',
        'observed before ambiguous ack',
      );
      expect(f.published).toHaveLength(1);
      expect(f.retained()).toBe(1);
      const stop = failure === 'stop' ? f.manager.stop() : null;
      if (failure === 'protocol')
        f.client.emitUnscopedError('thread', 'lost protocol');
      const error = new Error('native acknowledgement not confirmed');
      f.client.rejectBlocked('turn/start', error);
      expect(await pending.admission).toEqual({ status: 'ambiguous', error });
      await stop;
      await waitFor(() => f.retained() === 0);
      await f.manager.stop();
      expect(f.published).toHaveLength(1);
    },
  );

  it.each(['protocol', 'stop'] as const)(
    'settles a received positive ack with no observed terminal as %s rather than stranding it',
    async (fence) => {
      const f = fixture();
      const pending = await f.pending();
      f.client.release('turn/start', { turn: { id: 'unobserved' } });
      const stop = fence === 'stop' ? f.manager.stop() : null;
      if (fence === 'protocol')
        f.client.emitUnscopedError('thread', 'connection failed before result');
      expect(await submitted(await pending.admission).settled).toEqual(
        fence === 'stop'
          ? { kind: 'stopped' }
          : { kind: 'failed', error: expect.any(Error) },
      );
      await stop;
      await f.manager.stop();
      expect(f.published).toEqual([]);
      expect(f.retained()).toBe(0);
    },
  );
});
