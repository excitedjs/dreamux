import { describe, expect, it } from 'vitest';

import { TurnManager } from '../src/turn-manager.js';
import type { NotificationHandler } from '../src/rpc.js';
import type { ServerNotification, TurnStartResponse } from '../src/types.js';
import type { CollectedTurn } from '../src/events.js';
import type { RuntimeAdmission, RuntimeTurn } from '@excitedjs/dreamux-types';

describe('TurnManager inbound submission', () => {
  it('submits every accepted message through turn/start without coalescing', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves
      .toMatchObject({ status: 'submitted' });
    await expect(manager.enqueue(input('msg-2', 'second'))).resolves
      .toMatchObject({ status: 'submitted' });

    expect(client.methods).toEqual(['turn/start', 'turn/start']);
    expect(client.inputs).toEqual(['first', 'second']);
  });

  it('bounds the process-local message_id dedupe window', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      messageIdDedupeWindow: 2,
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-2', 'second'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-3', 'third'))).resolves
      .toMatchObject({ status: 'submitted' });

    await expect(manager.enqueue(input('msg-2', 'second still in window')))
      .resolves.toEqual({ status: 'duplicate' });
    await expect(
      manager.enqueue(input('msg-1', 'first redelivered after eviction')),
    ).resolves.toMatchObject({ status: 'submitted' });

    expect(client.inputs).toEqual([
      'first',
      'second',
      'third',
      'first redelivered after eviction',
    ]);
  });
});

describe('TurnManager text input submission', () => {
  it('submits plain text input as a turn when the thread is bound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toEqual({
      status: 'submitted',
      turn: expect.objectContaining({ settled: expect.any(Promise) }),
    });
    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('does not treat prior channel input as a reason to skip plain text input', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await manager.enqueue(input('msg-1', 'real work'));
    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(client.inputs).toEqual(['real work', 'Restart completed.']);
  });

  it('fails (does not throw) when no thread is bound', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => null,
      client: client as never,
    });

    const result = await manager.submitTextInput({ text: 'Restart completed.' });
    expect(result.status).toBe('failed');
    expect(client.inputs).toEqual([]);
  });

  it('dedupes stable sourceIds', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      manager.submitTextInput({ text: 'Restart completed.', sourceId: 'restart' }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('releases a source reservation after proven pre-admission failure', async () => {
    const client = new FakeCodexClient();
    let threadId: string | null = null;
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => threadId,
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'first attempt',
      sourceId: 'retryable-source',
    })).resolves.toMatchObject({ status: 'failed' });
    threadId = 'thread-1';
    await expect(manager.submitTextInput({
      text: 'safe retry',
      sourceId: 'retryable-source',
    })).resolves.toMatchObject({ status: 'submitted' });
    expect(client.inputs).toEqual(['safe retry']);
  });

  it('shares a concurrent source reservation and commits one accepted native write', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const first = manager.submitTextInput({
      text: 'first payload',
      sourceId: 'concurrent-source',
    });
    const second = manager.submitTextInput({
      text: 'ignored duplicate payload',
      sourceId: 'concurrent-source',
    });
    await waitFor(() => client.inputs.length === 1);
    client.resolveNext('turn-1');
    const [firstAdmission, secondAdmission] = await Promise.all([first, second]);
    expect(firstAdmission.status).toBe('submitted');
    expect(secondAdmission).toBe(firstAdmission);
    if (firstAdmission.status !== 'submitted') throw new Error('expected submitted');
    if (secondAdmission.status !== 'submitted') throw new Error('expected submitted');
    expect(secondAdmission.turn).toBe(firstAdmission.turn);
    expect(client.inputs).toEqual(['first payload']);
    await expect(manager.submitTextInput({
      text: 'accepted retry',
      sourceId: 'concurrent-source',
    })).resolves.toEqual({ status: 'duplicate' });
  });

  it('commits an ambiguous source and never repeats its native write', async () => {
    const client = new FailOnceFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'possibly accepted',
      sourceId: 'ambiguous-source',
    })).resolves.toMatchObject({ status: 'ambiguous' });
    await expect(manager.submitTextInput({
      text: 'must not be written again',
      sourceId: 'ambiguous-source',
    })).resolves.toEqual({ status: 'duplicate' });
    expect(client.requestCount).toBe(1);
  });

  it('passes outputSchema to turn/start and settles the validated JSON text', async () => {
    const client = new FakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    };

    await expect(manager.submitTextInput({
      text: '{"answer":4}',
      sourceId: 'structured',
      outputSchema,
    })).resolves.toEqual({
      status: 'submitted',
      turn: expect.objectContaining({ settled: expect.any(Promise) }),
    });
    await waitFor(() => completed.length === 1);

    expect(client.outputSchemas).toEqual([outputSchema]);
    expect(completed).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        items: [
          expect.objectContaining({
            type: 'agentMessage',
            text: '{"answer":4}',
          }),
        ],
      },
    ]);
  });

  it('compiles and restores optional output fields before completion', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });
    const outputSchema = optionalValueSchema();

    await expect(manager.submitTextInput({
      text: 'return optional JSON',
      outputSchema,
    })).resolves.toMatchObject({ status: 'submitted' });

    expect(client.outputSchemas).toEqual([{
      type: 'object',
      properties: {
        value: { type: ['string', 'null'] },
      },
      required: ['value'],
      additionalProperties: false,
    }]);
    expect(client.outputSchemas[0]).not.toBe(outputSchema);

    client.emitCompleted('thread-1', 'turn-1', '{"value":null}');
    await waitFor(() => completed.length === 1);
    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'agentMessage', text: '{}' }),
    );
  });

  it('rejects incompatible schemas before turn/start and slot admission', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'invalid schema',
      outputSchema: {
        type: 'object',
        properties: { value: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
    })).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message: expect.stringContaining('$.properties.value.type'),
      },
    });
    expect(client.inputs).toEqual([]);
    expect(manager.isBusy()).toBe(false);
  });

  it('discards an ambiguous submission codec before the next turn', async () => {
    const client = new FailOnceFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await expect(manager.submitTextInput({
      text: 'structured failure',
      outputSchema: optionalValueSchema(),
    })).resolves.toMatchObject({ status: 'ambiguous' });
    expect(manager.isBusy()).toBe(false);

    await expect(manager.submitTextInput({
      text: 'plain successor',
    })).resolves.toMatchObject({ status: 'submitted' });
    expect(client.outputSchemas).toEqual([
      expect.any(Object),
      undefined,
    ]);
  });

  it.each([
    ['plain failure before structured recovery', false],
    ['structured failure before plain recovery', true],
  ])('disposes the abandoned collector after %s', async (_label, failedStructured) => {
    const client = new RecoveringFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    await expect(manager.submitTextInput(
      failedStructured
        ? { text: 'failed structured', outputSchema: optionalValueSchema() }
        : { text: 'failed plain' },
    )).resolves.toMatchObject({ status: 'ambiguous' });
    expect(client.handlerCount).toBe(0);

    await expect(manager.submitTextInput(
      failedStructured
        ? { text: 'plain recovery' }
        : { text: 'structured recovery', outputSchema: optionalValueSchema() },
    )).resolves.toMatchObject({ status: 'submitted' });
    expect(client.handlerCount).toBe(1);

    client.emitCompleted(
      'thread-1',
      'turn-2',
      failedStructured ? 'plain result' : '{"value":null}',
    );
    await waitFor(() => completed.length === 1);

    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({
        type: 'agentMessage',
        text: failedStructured ? 'plain result' : '{}',
      }),
    );
    expect(client.handlerCount).toBe(0);
  });
});

describe('TurnManager turn settlement', () => {
  it('retains completion that arrives before turn/start returns the admission', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const submitted = manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitCompleted('thread-1', 'turn-1', 'early result');
    client.resolveNext('turn-1');

    const turn = await submittedTurn(submitted);
    await expect(turn.settled).resolves.toEqual({
      status: 'completed',
      resultText: 'early result',
      truncated: false,
    });
  });

  it('returns the same stopped object when stop wins before turn/start responds', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const submitted = manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    const stopping = manager.stop();
    let stopSettled = false;
    void stopping.finally(() => {
      stopSettled = true;
    });
    await flush();
    expect(stopSettled).toBe(false);
    client.resolveNext('turn-1');
    await stopping;

    const turn = await submittedTurn(submitted);
    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
    expect(manager.isBusy()).toBe(false);
  });

  it('retains the active slot until folded submissions resolve after native completion', async () => {
    const client = new DelayedFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const firstAdmission = manager.enqueue(input('msg-1', 'first'));
    const secondAdmission = manager.enqueue(input('msg-2', 'second'));
    await waitFor(() => client.inputs.length === 2);
    client.resolveNext('turn-1');
    const firstTurn = await submittedTurn(firstAdmission);

    client.emitCompleted('thread-1', 'turn-1', 'early completion');
    let settled = false;
    void firstTurn.settled.finally(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    const thirdAdmission = manager.enqueue(input('msg-3', 'third'));
    await waitFor(() => client.inputs.length === 3);
    client.resolveNext('turn-2');
    client.resolveNext('turn-3');
    client.emitCompleted('thread-1', 'turn-2', 'second completion');
    client.emitCompleted('thread-1', 'turn-3', 'final completion');

    const secondTurn = await submittedTurn(secondAdmission);
    const thirdTurn = await submittedTurn(thirdAdmission);
    expect(secondTurn).toBe(firstTurn);
    expect(thirdTurn).toBe(firstTurn);
    await expect(firstTurn.settled).resolves.toEqual({
      status: 'completed',
      resultText: 'final completion',
      truncated: false,
    });
    expect(completed).toHaveLength(1);
  });

  it('retains a completed slot when a folded submission fails ambiguously and a third send joins', async () => {
    const client = new DelayedFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const firstAdmission = manager.enqueue(input('msg-1', 'first'));
    const secondAdmission = manager.enqueue(input('msg-2', 'second'));
    await waitFor(() => client.inputs.length === 2);
    client.resolveNext('turn-1');
    const firstTurn = await submittedTurn(firstAdmission);
    client.emitCompleted('thread-1', 'turn-1', 'early completion');

    const thirdAdmission = manager.enqueue(input('msg-3', 'third'));
    await waitFor(() => client.inputs.length === 3);
    client.rejectNext(new Error('turn/start response lost'));
    client.resolveNext('turn-3');
    client.emitCompleted('thread-1', 'turn-3', 'final completion');

    await expect(secondAdmission).resolves.toMatchObject({
      status: 'ambiguous',
      error: { message: 'turn/start response lost' },
    });
    expect(await submittedTurn(thirdAdmission)).toBe(firstTurn);
    await expect(firstTurn.settled).resolves.toMatchObject({
      status: 'completed',
      resultText: 'final completion',
    });
    expect(completed).toHaveLength(1);
  });

  it('waitIdle treats the slot-claimed submission window as busy', async () => {
    const client = new DelayedFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const submitted = manager.enqueue(input('msg-1', 'first'));
    await waitFor(() => client.inputs.length === 1);
    expect(manager.isBusy()).toBe(true);

    let idle = false;
    void manager.waitIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    client.resolveNext('turn-1');
    await expect(submitted).resolves.toEqual({
      status: 'submitted',
      turn: expect.objectContaining({ settled: expect.any(Promise) }),
    });
    expect(idle).toBe(false);

    client.emitCompleted('thread-1', 'turn-1', 'done');
    await waitFor(() => idle);
    expect(manager.isBusy()).toBe(false);
  });

  it('forwards the completed turn (with its turn id) on turn/completed', async () => {
    const client = new FakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    expect(res).toMatchObject({ status: 'submitted' });

    await waitFor(() => completed.length === 1);
    expect(completed[0]?.turnId).toBe('turn-1');
  });

  it('steers active submissions into the current turn and settles it once', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2', 'turn-3']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const first = await submittedTurn(manager.enqueue(input('msg-1', 'first')));
    const second = await submittedTurn(
      manager.enqueue(input('msg-2', 'second steered')),
    );
    const third = await submittedTurn(
      manager.enqueue(input('msg-3', 'third steered')),
    );
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(client.inputs).toEqual(['first', 'second steered', 'third steered']);

    client.emitCompleted('thread-1', 'turn-1', 'first result');
    client.emitCompleted('thread-1', 'turn-2', 'second result');
    client.emitCompleted('thread-1', 'turn-3', 'folded result');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-3']);
  });

  it('coalesces concurrent cold-start submissions into one completion-producing turn', async () => {
    const client = new DelayedFakeCodexClient();
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const first = manager.enqueue(input('msg-1', 'first'));
    const second = manager.enqueue(input('msg-2', 'second'));
    await waitFor(() => client.inputs.length === 2);

    expect(client.handlerCount).toBe(1);
    client.resolveNext('turn-1');
    client.resolveNext('turn-2');
    const admissions = await Promise.all([first, second]);
    const firstTurn = requireSubmittedTurn(admissions[0]);
    expect(requireSubmittedTurn(admissions[1])).toBe(firstTurn);

    client.emitCompleted('thread-1', 'turn-1', 'folded result');
    client.emitCompleted('thread-1', 'turn-2', 'extra physical result');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-2']);
  });

  it('folds compatible structured submissions and restores exactly once', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const first = await submittedTurn(manager.submitTextInput({
      text: 'first',
      outputSchema: optionalValueSchema(),
    }));
    const folded = await submittedTurn(manager.submitTextInput({
      text: 'folded',
      outputSchema: {
        additionalProperties: false,
        required: [],
        properties: { value: { type: 'string' } },
        type: 'object',
      },
    }));
    expect(folded).toBe(first);
    expect(client.inputs).toEqual(['first', 'folded']);

    client.emitCompleted('thread-1', 'turn-1', '{"value":null}');
    client.emitCompleted('thread-1', 'turn-2', '{"value":"ignored"}');
    await waitFor(() => completed.length === 1);
    await flush();

    expect(completed[0]?.items).toContainEqual(
      expect.objectContaining({ text: '{"value":"ignored"}' }),
    );
    await expect(first.settled).resolves.toEqual({
      status: 'completed',
      resultText: '{"value":"ignored"}',
      truncated: false,
    });
  });

  it('rejects incompatible structured folding without another turn/start', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    await manager.submitTextInput({
      text: 'optional',
      outputSchema: optionalValueSchema(),
    });
    await expect(manager.submitTextInput({
      text: 'required nullable',
      outputSchema: requiredNullableValueSchema(),
    })).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    });
    expect(client.inputs).toEqual(['optional']);
  });

  it.each([
    ['structured then plain', true],
    ['plain then structured', false],
  ])('rejects active-turn mixing for %s', async (_label, structuredFirst) => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });
    const structured = {
      text: 'structured',
      outputSchema: optionalValueSchema(),
    };
    const plain = { text: 'plain' };

    await manager.submitTextInput(structuredFirst ? structured : plain);
    await expect(
      manager.submitTextInput(structuredFirst ? plain : structured),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    });
    expect(client.inputs).toHaveLength(1);
  });

  it('settles restoration failure without forwarding completion', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const turn = await submittedTurn(manager.submitTextInput({
      text: 'invalid restored shape',
      outputSchema: {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'string' } },
        },
        required: ['values'],
        additionalProperties: false,
      },
    }));
    client.emitCompleted('thread-1', 'turn-1', '{"values":{}}');
    const outcome = await turn.settled;

    expect(completed).toEqual([]);
    expect(outcome).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining('$.values: expected array'),
      },
    });
  });

  it('drops structured late completion after stop without restoring twice', async () => {
    const client = new FoldingFakeCodexClient(['turn-1']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const turn = await submittedTurn(manager.submitTextInput({
      text: 'wait',
      outputSchema: optionalValueSchema(),
    }));
    await manager.stop();
    client.emitCompleted('thread-1', 'turn-1', '{');
    await flush();

    expect(completed).toEqual([]);
    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
  });

  it('starts a fresh subscription for a sequential send after the previous turn completed', async () => {
    const client = new FoldingFakeCodexClient(['turn-1', 'turn-2']);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    await expect(manager.enqueue(input('msg-1', 'first'))).resolves
      .toMatchObject({ status: 'submitted' });

    client.emitCompleted('thread-1', 'turn-1', 'first result');
    await waitFor(() => completed.length === 1);
    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1']);

    await expect(manager.enqueue(input('msg-2', 'second'))).resolves
      .toMatchObject({ status: 'submitted' });
    client.emitCompleted('thread-1', 'turn-2', 'second result');
    await waitFor(() => completed.length === 2);
    expect(completed.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  });

  it('settles each still-pending turn as stopped on stop()', async () => {
    // A manual client never emits turn/completed, so the submitted turn stays
    // in flight until stop() tears it down.
    const client = new ManualFakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    const turn = requireSubmittedTurn(res);

    await manager.stop();
    await expect(turn.settled).resolves.toEqual({ status: 'stopped' });
    expect(client.handlerCount).toBe(0);
  });

  it('does not re-settle a completed turn as stopped', async () => {
    const client = new FakeCodexClient();
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      // The auto-completing client clears the pending turn before stop().
      onTurnCompleted: () => undefined,
    });

    const turn = await submittedTurn(manager.enqueue(input('msg-1', 'work')));
    await waitFor(() => client.inputs.length === 1);
    // Let the queued turn/completed microtask clear the pending set.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const completedOutcome = await turn.settled;
    await manager.stop();
    await expect(turn.settled).resolves.toBe(completedOutcome);
    expect(completedOutcome.status).toBe('completed');
  });

  it('settles a turn as failed on a fatal codex error notification (willRetry:false)', async () => {
    const client = new ErroringFakeCodexClient(false);
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: () => undefined,
    });

    const res = await manager.enqueue(input('msg-1', 'work'));
    const turn = requireSubmittedTurn(res);

    const outcome = await turn.settled;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('expected failed outcome');
    expect(outcome.error.message).toContain('boom');
  });

  it('ignores a transient codex error (willRetry:true) and completes normally', async () => {
    const client = new ErroringFakeCodexClient(true);
    const completed: CollectedTurn[] = [];
    const manager = new TurnManager({
      dispatcherId: 'flow',
      getThreadId: () => 'thread-1',
      client: client as never,
      onTurnCompleted: (turn) => completed.push(turn),
    });

    const turn = await submittedTurn(manager.enqueue(input('msg-1', 'work')));
    await waitFor(() => completed.length === 1);
    expect(completed[0]?.turnId).toBe('turn-1');
    await expect(turn.settled).resolves.toMatchObject({ status: 'completed' });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function submittedTurn(
  admission: Promise<RuntimeAdmission>,
): Promise<RuntimeTurn> {
  return requireSubmittedTurn(await admission);
}

function requireSubmittedTurn(admission: RuntimeAdmission | undefined): RuntimeTurn {
  if (admission?.status !== 'submitted') {
    throw new Error(`expected submitted admission, got ${admission?.status ?? 'missing'}`);
  }
  return admission.turn;
}

function input(messageId: string, text: string) {
  return {
    sourceId: messageId,
    text,
  };
}

function optionalValueSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: { type: 'string' } },
    additionalProperties: false,
  };
}

function requiredNullableValueSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: { type: ['string', 'null'] } },
    required: ['value'],
    additionalProperties: false,
  };
}

/** A fake client that acks turn/start but never emits turn/completed. */
class ManualFakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as { input: Array<{ text: string }> };
    this.inputs.push(p.input[0]?.text ?? '');
    return { turn: { id: `turn-${this.nextTurnId++}` } } as TurnStartResponse as R;
  }
}

class FakeCodexClient {
  readonly inputs: string[] = [];
  readonly methods: string[] = [];
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.methods.push(method);
    const p = params as {
      threadId: string;
      input: Array<{ text: string }>;
      outputSchema?: Record<string, unknown>;
    };
    const text = p.input[0]?.text ?? '';
    this.inputs.push(text);
    this.outputSchemas.push(p.outputSchema);
    const turnId = `turn-${this.nextTurnId++}`;
    queueMicrotask(() => {
      this.emit({
        method: 'item/completed',
        params: {
          threadId: p.threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: 'agentMessage', id: `item-${turnId}`, text },
        },
      });
      this.emit({
        method: 'turn/completed',
        params: {
          threadId: p.threadId,
          turn: { id: turnId, items: [] },
        },
      });
    });
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

class FoldingFakeCodexClient {
  readonly inputs: string[] = [];
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private nextIndex = 0;

  constructor(private readonly turnIds: string[]) {}

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      input: Array<{ text: string }>;
      outputSchema?: Record<string, unknown>;
    };
    this.inputs.push(p.input[0]?.text ?? '');
    this.outputSchemas.push(p.outputSchema);
    const turnId = this.turnIds[this.nextIndex++];
    if (turnId === undefined) throw new Error('no scripted turn id');
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

class FailOnceFakeCodexClient {
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();
  private requests = 0;

  get requestCount(): number {
    return this.requests;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.requests += 1;
    const p = params as { outputSchema?: Record<string, unknown> };
    this.outputSchemas.push(p.outputSchema);
    if (this.requests === 1) throw new Error('turn/start rejected');
    return { turn: { id: 'turn-2' } } as TurnStartResponse as R;
  }
}

class RecoveringFakeCodexClient {
  private readonly handlers = new Set<NotificationHandler>();
  private requests = 0;

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    this.requests += 1;
    if (this.requests === 1) throw new Error('turn/start rejected');
    return { turn: { id: 'turn-2' } } as TurnStartResponse as R;
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

class DelayedFakeCodexClient {
  readonly inputs: string[] = [];
  private readonly handlers = new Set<NotificationHandler>();
  private readonly pending: Array<{
    resolve: (turnId: string) => void;
    reject: (error: Error) => void;
  }> = [];

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as {
      input: Array<{ text: string }>;
    };
    this.inputs.push(p.input[0]?.text ?? '');
    return new Promise<R>((resolve, reject) => {
      this.pending.push({
        resolve: (turnId) => {
          resolve({ turn: { id: turnId } } as TurnStartResponse as R);
        },
        reject,
      });
    });
  }

  resolveNext(turnId: string): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error('no pending turn/start');
    pending.resolve(turnId);
  }

  rejectNext(error: Error): void {
    const pending = this.pending.shift();
    if (pending === undefined) throw new Error('no pending turn/start');
    pending.reject(error);
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}

/**
 * Acks turn/start then emits a codex `error` notification. With willRetry=false
 * (fatal) it emits no turn/completed — the turn must still settle as `failed`.
 * With willRetry=true (transient) a normal turn/completed follows.
 */
class ErroringFakeCodexClient {
  private readonly handlers = new Set<NotificationHandler>();
  private nextTurnId = 1;

  constructor(private readonly willRetry: boolean) {}

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const p = params as { threadId: string; input: Array<{ text: string }> };
    const turnId = `turn-${this.nextTurnId++}`;
    queueMicrotask(() => {
      this.emit({
        method: 'error',
        params: {
          threadId: p.threadId,
          turnId,
          willRetry: this.willRetry,
          error: { message: 'boom' },
        },
      });
      if (this.willRetry) {
        this.emit({
          method: 'turn/completed',
          params: { threadId: p.threadId, turn: { id: turnId, items: [] } },
        });
      }
    });
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }

  private emit(notification: ServerNotification): void {
    for (const handler of this.handlers) handler(notification);
  }
}
