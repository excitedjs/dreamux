/**
 * TurnManager contract tests for the value-keyed turn contract.
 *
 * Protocol fidelity rule: the fakes below only replay native codex app-server
 * facts — a `turn/start` JSON-RPC response carrying a native turn id, and the
 * `item/started` / `item/completed` / `turn/completed` / `error` notifications.
 * No fake is ever told how many completions to produce. Fold vs queue is
 * expressed purely natively (does `turn/start` answer with the SAME native turn
 * id or a NEW one?) and the contract outcome — completion token identity and
 * count — is asserted on the manager's output.
 */

import { describe, expect, it } from 'vitest';

import { TurnManager, type TurnManagerOptions } from '../src/turn-manager.js';
import type { NotificationHandler } from '../src/rpc.js';
import type { ServerNotification, ThreadItem, TurnStartResponse } from '../src/types.js';
import type { CollectedTurn } from '../src/events.js';
import { DEFAULT_MESSAGE_ID_DEDUPE_WINDOW } from '@excitedjs/dreamux-utils';
import type {
  InboundTurnInput,
  RuntimeActivityEvent,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

describe('TurnManager native turn identity', () => {
  it('settles both sends with one identical token when turn/start returns the same native turn id', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-1']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'steered')));
    expect(client.inputs).toEqual(['first', 'steered']);
    expect(second).not.toBe(first);

    client.emitTurnCompleted('thread-1', 'turn-1', 'one native result');

    const firstToken = await settledCompletion(first);
    const secondToken = await settledCompletion(second);
    expect(secondToken).toBe(firstToken);
    expect(Object.isFrozen(firstToken)).toBe(true);
    expect(firstToken).toMatchObject({
      status: 'completed',
      resultText: 'one native result',
      truncated: false,
    });
    expect(firstToken.displaySubmission).toBe(first);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });

  it('settles each send with its own token when turn/start returns a new native turn id', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-2']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'second')));

    client.emitTurnCompleted('thread-1', 'turn-1', 'first result');
    client.emitTurnCompleted('thread-1', 'turn-2', 'second result');

    const firstToken = await settledCompletion(first);
    const secondToken = await settledCompletion(second);
    expect(secondToken).not.toBe(firstToken);
    expect(firstToken).toMatchObject({ status: 'completed', resultText: 'first result' });
    expect(secondToken).toMatchObject({ status: 'completed', resultText: 'second result' });
    expect(firstToken.displaySubmission).toBe(first);
    expect(secondToken.displaySubmission).toBe(second);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  });

  it('keys completion identity on the native turn id, never on byte-identical result text', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-1', 'turn-2']);
    const harness = createHarness(client);

    const folded = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const foldedFollower = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'steered')));
    const queued = requireSubmitted(await harness.manager.enqueue(input('msg-3', 'queued')));

    client.emitTurnCompleted('thread-1', 'turn-1', 'identical text');
    client.emitTurnCompleted('thread-1', 'turn-2', 'identical text');

    const foldedToken = await settledCompletion(folded);
    const followerToken = await settledCompletion(foldedFollower);
    const queuedToken = await settledCompletion(queued);

    expect(followerToken).toBe(foldedToken);
    expect(queuedToken).not.toBe(foldedToken);
    expect(foldedToken).toMatchObject({ status: 'completed', resultText: 'identical text' });
    expect(queuedToken).toMatchObject({ status: 'completed', resultText: 'identical text' });
    // With the text identical, display attribution is what actually
    // discriminates: `turn-2`'s result must display through the send that
    // opened `turn-2`, never through the folded `turn-1` window. (The
    // `not.toBe` above states the contract but cannot fail while `finalize()`
    // freezes a fresh literal per native turn record.)
    expect(foldedToken.displaySubmission).toBe(folded);
    expect(queuedToken.displaySubmission).toBe(queued);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  });
});

describe('TurnManager late turn/start binding', () => {
  it('binds a turn/completed observed before the turn/start response into a real completion', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitTurnCompleted('thread-1', 'turn-1', 'early result');
    expect(harness.completedTurns).toEqual([]);

    client.resolveNext('turn-1');
    const submission = requireSubmitted(await admission);
    const token = await settledCompletion(submission);

    expect(token).toMatchObject({ status: 'completed', resultText: 'early result' });
    expect(token.displaySubmission).toBe(submission);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('binds a late turn/start response for an already terminal turn id to the cached token', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const firstAdmission = harness.manager.enqueue(input('msg-1', 'first'));
    await waitFor(() => client.inputs.length === 1);
    client.resolveNext('turn-1');
    const first = requireSubmitted(await firstAdmission);

    const secondAdmission = harness.manager.enqueue(input('msg-2', 'steered'));
    await waitFor(() => client.inputs.length === 2);
    // The native result lands while the second turn/start is still in flight.
    client.emitTurnCompleted('thread-1', 'turn-1', 'shared native result');
    const firstToken = await settledCompletion(first);

    client.resolveNext('turn-1');
    const second = requireSubmitted(await secondAdmission);
    const secondToken = await settledCompletion(second);

    expect(secondToken).toBe(firstToken);
    expect(secondToken.displaySubmission).toBe(first);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });
});

describe('TurnManager outputSchema classification', () => {
  it('fails an unsupported outputSchema before any turn/start reaches the wire', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = await harness.manager.submitTextInput({
      text: 'invalid schema',
      outputSchema: {
        type: 'object',
        properties: { value: { type: ['string', 'number'] } },
        additionalProperties: false,
      },
    });

    expect(admission).toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message: expect.stringContaining('$.properties.value.type'),
      },
    });
    expect(client.inputs).toEqual([]);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('fails an incompatible outputSchema against an active native turn without a second turn/start', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput({
      text: 'structured',
      outputSchema: optionalValueSchema(),
    })).resolves.toMatchObject({ status: 'submitted' });

    await expect(harness.manager.submitTextInput({
      text: 'incompatible structured',
      outputSchema: requiredNullableValueSchema(),
    })).resolves.toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message: expect.stringContaining('incompatible outputSchema'),
      },
    });
    await expect(harness.manager.submitTextInput({ text: 'incompatible plain' }))
      .resolves.toMatchObject({ status: 'failed' });

    expect(client.inputs).toEqual(['structured']);
    expect(harness.completedTurns).toEqual([]);
  });

  it('folds a compatible outputSchema into the same native turn id and restores the payload once', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-1']);
    const harness = createHarness(client);
    const callerSchema = optionalValueSchema();

    const first = requireSubmitted(await harness.manager.submitTextInput({
      text: 'structured',
      outputSchema: callerSchema,
    }));
    const second = requireSubmitted(await harness.manager.submitTextInput({
      text: 'compatible structured',
      outputSchema: {
        additionalProperties: false,
        required: [],
        properties: { value: { type: 'string' } },
        type: 'object',
      },
    }));

    expect(client.outputSchemas).toEqual([
      {
        type: 'object',
        properties: { value: { type: ['string', 'null'] } },
        required: ['value'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { value: { type: ['string', 'null'] } },
        required: ['value'],
        additionalProperties: false,
      },
    ]);
    expect(client.outputSchemas[0]).not.toBe(callerSchema);

    client.emitTurnCompleted('thread-1', 'turn-1', '{"value":null}');

    const firstToken = await settledCompletion(first);
    expect(await settledCompletion(second)).toBe(firstToken);
    expect(firstToken).toMatchObject({ status: 'completed', resultText: '{}' });
    expect(harness.completedTurns).toHaveLength(1);
    expect(harness.completedTurns[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'agentMessage', text: '{}' }),
    );
  });
});

describe('TurnManager terminal integrity', () => {
  it('does not create a second completion for a duplicate turn/completed on one turn id', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    client.emitTurnCompleted('thread-1', 'turn-1', 'only result');
    const token = await settledCompletion(submission);

    client.emitTurnCompleted('thread-1', 'turn-1', 'only result');
    await flush();

    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
    expect(await settledCompletion(submission)).toBe(token);
    expect(harness.activity.map((event) => event.activity.id))
      .toEqual(['turn-1:item-turn-1:completed']);
  });

  it('fails loudly and settles as failed (no token) on conflicting terminal facts for one turn id', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitRawTurnCompleted('thread-1', {
      id: 'turn-1',
      items: [{ type: 'agentMessage', id: 'item-1', text: 'done' }],
    });
    client.emitRawTurnCompleted('thread-1', {
      id: 'turn-1',
      error: { message: 'boom' },
    });

    client.resolveNext('turn-1');
    const submission = requireSubmitted(await admission);
    const settlement = await submission.settled;

    expect(settlement.kind).toBe('failed');
    if (settlement.kind !== 'failed') throw new Error('expected a failed settlement');
    expect(settlement.error.message).toContain('conflicting terminal facts for turn turn-1');
    expect(harness.completedTurns).toEqual([]);
    expect(harness.logs).toContainEqual({
      level: 'error',
      message: expect.stringContaining('conflicting terminal facts for turn turn-1'),
    });

    await expect(harness.manager.enqueue(input('msg-2', 'after protocol failure')))
      .resolves.toMatchObject({ status: 'failed' });
    expect(client.inputs).toEqual(['work']);
  });
});

describe('TurnManager message_id dedupe window', () => {
  it('re-admits an evicted message_id once the configured window rolls over', async () => {
    const client = new AutoCompletingFakeCodexClient();
    const harness = createHarness(client, { messageIdDedupeWindow: 2 });

    await expect(harness.manager.enqueue(input('msg-1', 'first')))
      .resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.enqueue(input('msg-2', 'second')))
      .resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.enqueue(input('msg-3', 'third')))
      .resolves.toMatchObject({ status: 'submitted' });

    await expect(harness.manager.enqueue(input('msg-2', 'still inside the window')))
      .resolves.toEqual({ status: 'duplicate' });
    await expect(harness.manager.enqueue(input('msg-1', 'redelivered after eviction')))
      .resolves.toMatchObject({ status: 'submitted' });

    expect(client.inputs).toEqual([
      'first',
      'second',
      'third',
      'redelivered after eviction',
    ]);
  });

  it('bounds the default dedupe window at DEFAULT_MESSAGE_ID_DEDUPE_WINDOW entries', async () => {
    const client = new AutoCompletingFakeCodexClient();
    const harness = createHarness(client);

    for (let index = 0; index < DEFAULT_MESSAGE_ID_DEDUPE_WINDOW; index += 1) {
      await expect(harness.manager.enqueue(input(`msg-${index}`, `body-${index}`)))
        .resolves.toMatchObject({ status: 'submitted' });
    }
    // The oldest id is still inside the window at exactly the bound.
    await expect(harness.manager.enqueue(input('msg-0', 'still inside the window')))
      .resolves.toEqual({ status: 'duplicate' });

    // One more distinct id pushes the oldest out of the bounded window.
    await expect(harness.manager.enqueue(input('msg-overflow', 'overflow')))
      .resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.enqueue(input('msg-0', 'redelivered after eviction')))
      .resolves.toMatchObject({ status: 'submitted' });

    expect(client.inputs).toHaveLength(DEFAULT_MESSAGE_ID_DEDUPE_WINDOW + 2);
    expect(client.inputs.at(-1)).toBe('redelivered after eviction');
  });
});

describe('TurnManager orphan cleanup', () => {
  it('drops activity for a native turn id that never binds a submission', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitItemStarted('thread-1', 'turn-orphan', {
      type: 'commandExecution',
      id: 'call-orphan',
      command: 'ls',
    });
    expect(harness.activity).toEqual([]);

    client.resolveNext('turn-1');
    const submission = requireSubmitted(await admission);
    expect(harness.activity).toEqual([]);

    // With no admission in flight the orphan fact is dropped on arrival.
    client.emitItemStarted('thread-1', 'turn-orphan', {
      type: 'commandExecution',
      id: 'call-orphan',
      command: 'ls',
    });
    await flush();
    expect(harness.activity).toEqual([]);

    client.emitTurnCompleted('thread-1', 'turn-1', 'own result');
    await expect(settledCompletion(submission)).resolves.toMatchObject({
      status: 'completed',
      resultText: 'own result',
    });
    expect(harness.activity.map((event) => event.activity.id))
      .toEqual(['turn-1:item-turn-1:completed']);
  });

  it('drops a turn/completed with no accepted submission and warns', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    client.emitTurnCompleted('thread-1', 'turn-1', 'own result');
    await settledCompletion(submission);

    client.emitTurnCompleted('thread-1', 'turn-orphan', 'nobody asked for this');
    await flush();

    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'dropping native terminal turn-orphan without an accepted submission',
    });
    expect(harness.manager.isBusy()).toBe(false);
  });
});

describe('TurnManager stop', () => {
  it('settles an accepted submission with no observed native result as stopped and creates no token', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    await harness.manager.stop();

    await expect(submission.settled).resolves.toEqual({ kind: 'stopped' });
    expect(harness.completedTurns).toEqual([]);
    expect(harness.activity).toEqual([]);
    expect(client.handlerCount).toBe(0);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('does not return from stop() while an accepted submission is still unsettled', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);

    let stopReturned = false;
    const stopping = harness.manager.stop().then(() => { stopReturned = true; });
    await flush();
    await flush();
    expect(stopReturned).toBe(false);

    client.resolveNext('turn-1');
    await stopping;

    const submission = requireSubmitted(await admission);
    await expect(submission.settled).resolves.toEqual({ kind: 'stopped' });
    expect(harness.completedTurns).toEqual([]);
  });

  it('still delivers a native result observed before the stop linearization point', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitTurnCompleted('thread-1', 'turn-1', 'result before stop');

    const stopping = harness.manager.stop();
    client.resolveNext('turn-1');
    await stopping;

    const submission = requireSubmitted(await admission);
    const token = await settledCompletion(submission);
    expect(token).toMatchObject({ status: 'completed', resultText: 'result before stop' });
    expect(token.displaySubmission).toBe(submission);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });
});

describe('TurnManager live activity projection', () => {
  it('projects item/started and item/completed through activitySink before the terminal result', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    client.emitItemStarted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-7',
      command: 'ls -a',
    });
    client.emitItemCompleted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-7',
      command: 'ls -a',
      status: 'completed',
      aggregatedOutput: 'a\nb',
    }, 1_711);
    expect(harness.completedTurns).toEqual([]);

    client.emitTurnCompleted('thread-1', 'turn-1', 'all done');
    const token = await settledCompletion(submission);

    expect(harness.activity.map((event) => event.activity)).toEqual([
      {
        kind: 'tool.call',
        id: 'turn-1:call-7:started',
        callId: 'call-7',
        toolName: 'exec_command',
        status: 'started',
        arguments: 'ls -a',
        result: null,
        error: null,
      },
      {
        kind: 'tool.call',
        id: 'turn-1:call-7:completed',
        callId: 'call-7',
        toolName: 'exec_command',
        status: 'completed',
        arguments: 'ls -a',
        result: 'a\nb',
        error: null,
      },
      {
        kind: 'assistant.message',
        id: 'turn-1:item-turn-1:completed',
        text: 'all done',
        truncated: false,
      },
    ]);
    expect(harness.activity[1]?.occurredAt).toBe(1_711);
    expect(harness.activity.every((event) => event.submission === submission)).toBe(true);
    expect(token.displaySubmission).toBe(submission);
    expect(harness.timeline).toEqual([
      'activity:turn-1:call-7:started',
      'activity:turn-1:call-7:completed',
      'activity:turn-1:item-turn-1:completed',
      'terminal:turn-1',
    ]);
  });

  it('projects buffered pre-response activity exactly once when the submission binds', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'work'));
    await waitFor(() => client.inputs.length === 1);
    client.emitItemStarted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-1',
      command: 'pwd',
    });
    expect(harness.activity).toEqual([]);

    client.resolveNext('turn-1');
    const submission = requireSubmitted(await admission);
    expect(harness.activity.map((event) => event.activity.id)).toEqual(['turn-1:call-1:started']);
    expect(harness.activity[0]?.submission).toBe(submission);

    client.emitTurnCompleted('thread-1', 'turn-1', 'done');
    await settledCompletion(submission);
    expect(harness.timeline).toEqual([
      'activity:turn-1:call-1:started',
      'activity:turn-1:item-turn-1:completed',
      'terminal:turn-1',
    ]);
  });

  it('projects folded activity once, attributed to the display submission', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-1']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    client.emitItemStarted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-1',
      command: 'pwd',
    });
    expect(harness.activity).toHaveLength(1);

    // The follower joins the SAME native turn id: it must not replay the fact.
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'steered')));
    expect(harness.activity).toHaveLength(1);

    client.emitItemCompleted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-1',
      command: 'pwd',
      status: 'completed',
      output: '/repo',
    }, 42);
    client.emitTurnCompleted('thread-1', 'turn-1', 'folded result');

    const token = await settledCompletion(first);
    expect(await settledCompletion(second)).toBe(token);
    expect(harness.activity.map((event) => event.activity.id)).toEqual([
      'turn-1:call-1:started',
      'turn-1:call-1:completed',
      'turn-1:item-turn-1:completed',
    ]);
    expect(harness.activity.every((event) => event.submission === first)).toBe(true);
    expect(token.displaySubmission).toBe(first);
  });

  it('projects each queued native turn separately, in native event order', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-2']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'second')));

    client.emitItemStarted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-a',
      command: 'first-cmd',
    });
    client.emitItemStarted('thread-1', 'turn-2', {
      type: 'commandExecution',
      id: 'call-b',
      command: 'second-cmd',
    });
    client.emitItemCompleted('thread-1', 'turn-1', {
      type: 'commandExecution',
      id: 'call-a',
      command: 'first-cmd',
      status: 'failed',
      error: 'exit 1',
    }, 7);
    client.emitTurnCompleted('thread-1', 'turn-1', 'first result');
    client.emitTurnCompleted('thread-1', 'turn-2', 'second result');

    const firstToken = await settledCompletion(first);
    const secondToken = await settledCompletion(second);
    expect(secondToken).not.toBe(firstToken);

    expect(harness.activity.map((event) => [event.activity.id, event.submission === first])).toEqual([
      ['turn-1:call-a:started', true],
      ['turn-2:call-b:started', false],
      ['turn-1:call-a:completed', true],
      ['turn-1:item-turn-1:completed', true],
      ['turn-2:item-turn-2:completed', false],
    ]);
    expect(harness.activity[1]?.submission).toBe(second);
    expect(harness.activity[2]?.activity).toMatchObject({
      kind: 'tool.call',
      callId: 'call-a',
      status: 'failed',
      error: 'exit 1',
    });
    // Each native turn's activity is projected before that turn's terminal.
    expect(harness.timeline).toEqual([
      'activity:turn-1:call-a:started',
      'activity:turn-2:call-b:started',
      'activity:turn-1:call-a:completed',
      'activity:turn-1:item-turn-1:completed',
      'terminal:turn-1',
      'activity:turn-2:item-turn-2:completed',
      'terminal:turn-2',
    ]);
  });

});

describe('TurnManager inbound submission', () => {
  it('submits every accepted message through turn/start without coalescing', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-2']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'second')));
    expect(client.inputs).toEqual(['first', 'second']);

    client.emitTurnCompleted('thread-1', 'turn-1', 'first result');
    client.emitTurnCompleted('thread-1', 'turn-2', 'second result');

    expect(await settledCompletion(first))
      .toMatchObject({ status: 'completed', resultText: 'first result' });
    expect(await settledCompletion(second))
      .toMatchObject({ status: 'completed', resultText: 'second result' });
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  });
});

describe('TurnManager text input submission', () => {
  it('submits plain text input as a turn when the thread is bound', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput({
      text: 'Restart completed.',
      sourceId: 'restart',
    })).resolves.toEqual({
      status: 'submitted',
      submission: expect.objectContaining({ settled: expect.any(Promise) }),
    });
    expect(client.inputs).toEqual(['Restart completed.']);
    expect(client.outputSchemas).toEqual([undefined]);
  });

  it('does not treat prior channel input as a reason to skip plain text input', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-1']);
    const harness = createHarness(client);

    // The SAME source id on the channel-message stream must not reserve the
    // text-input stream: the two dedupe namespaces are independent.
    await expect(harness.manager.enqueue(input('restart', 'real work')))
      .resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.submitTextInput({
      text: 'Restart completed.',
      sourceId: 'restart',
    })).resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.enqueue(input('restart', 'channel replay')))
      .resolves.toEqual({ status: 'duplicate' });

    expect(client.inputs).toEqual(['real work', 'Restart completed.']);
  });

  it('fails (does not throw) when no thread is bound', async () => {
    const client = new ScriptedFakeCodexClient([]);
    const harness = createHarness(client, { getThreadId: () => null });

    await expect(harness.manager.submitTextInput({ text: 'Restart completed.' }))
      .resolves.toMatchObject({
        status: 'failed',
        error: { message: 'input submitted without thread_id' },
      });
    expect(client.inputs).toEqual([]);
    expect(client.handlerCount).toBe(0);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('dedupes stable sourceIds', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput({
      text: 'Restart completed.',
      sourceId: 'restart',
    })).resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.submitTextInput({
      text: 'Restart completed.',
      sourceId: 'restart',
    })).resolves.toEqual({ status: 'duplicate' });

    expect(client.inputs).toEqual(['Restart completed.']);
  });

  it('releases a source reservation after proven pre-admission failure', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    let threadId: string | null = null;
    const harness = createHarness(client, { getThreadId: () => threadId });

    await expect(harness.manager.submitTextInput({
      text: 'first attempt',
      sourceId: 'retryable-source',
    })).resolves.toMatchObject({ status: 'failed' });

    threadId = 'thread-1';
    await expect(harness.manager.submitTextInput({
      text: 'safe retry',
      sourceId: 'retryable-source',
    })).resolves.toMatchObject({ status: 'submitted' });

    expect(client.inputs).toEqual(['safe retry']);
  });

  it('shares a concurrent source reservation and commits one accepted native write', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const first = harness.manager.submitTextInput({
      text: 'first payload',
      sourceId: 'concurrent-source',
    });
    const second = harness.manager.submitTextInput({
      text: 'ignored duplicate payload',
      sourceId: 'concurrent-source',
    });
    await waitFor(() => client.inputs.length === 1);
    client.resolveNext('turn-1');

    const [firstAdmission, secondAdmission] = await Promise.all([first, second]);
    expect(secondAdmission).toBe(firstAdmission);
    const submission = requireSubmitted(firstAdmission);
    expect(client.inputs).toEqual(['first payload']);

    await expect(harness.manager.submitTextInput({
      text: 'accepted retry',
      sourceId: 'concurrent-source',
    })).resolves.toEqual({ status: 'duplicate' });

    client.emitTurnCompleted('thread-1', 'turn-1', 'shared result');
    expect(await settledCompletion(submission))
      .toMatchObject({ status: 'completed', resultText: 'shared result' });
    expect(client.inputs).toEqual(['first payload']);
  });

  it('commits an ambiguous source and never repeats its native write', async () => {
    const client = new FailOnceFakeCodexClient();
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput({
      text: 'possibly accepted',
      sourceId: 'ambiguous-source',
    })).resolves.toMatchObject({
      status: 'ambiguous',
      error: { message: 'turn/start rejected' },
    });
    await expect(harness.manager.submitTextInput({
      text: 'must not be written again',
      sourceId: 'ambiguous-source',
    })).resolves.toEqual({ status: 'duplicate' });

    expect(client.inputs).toEqual(['possibly accepted']);
  });

  it.each([
    ['a plain ambiguous failure', false],
    ['a structured ambiguous failure', true],
  ])('recovers on the single retained subscription after %s', async (_label, failedStructured) => {
    const client = new FailOnceFakeCodexClient();
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput(
      failedStructured
        ? { text: 'failed structured', outputSchema: optionalValueSchema() }
        : { text: 'failed plain' },
    )).resolves.toMatchObject({ status: 'ambiguous' });
    expect(client.handlerCount).toBe(1);

    const submission = requireSubmitted(await harness.manager.submitTextInput(
      failedStructured
        ? { text: 'plain recovery' }
        : { text: 'structured recovery', outputSchema: optionalValueSchema() },
    ));
    expect(client.handlerCount).toBe(1);

    client.emitTurnCompleted(
      'thread-1',
      'turn-2',
      failedStructured ? 'plain result' : '{"value":null}',
    );

    const restored = failedStructured ? 'plain result' : '{}';
    expect(await settledCompletion(submission))
      .toMatchObject({ status: 'completed', resultText: restored });
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-2']);
    expect(harness.completedTurns[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'agentMessage', text: restored }),
    );
  });
});

describe('TurnManager outputSchema wire contract', () => {
  it('passes outputSchema to turn/start and settles the validated JSON text', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    };

    const submission = requireSubmitted(await harness.manager.submitTextInput({
      text: 'answer as JSON',
      sourceId: 'structured',
      outputSchema,
    }));
    expect(client.outputSchemas).toEqual([outputSchema]);

    client.emitTurnCompleted('thread-1', 'turn-1', '{"answer":4}');

    expect(await settledCompletion(submission))
      .toMatchObject({ status: 'completed', resultText: '{"answer":4}' });
    expect(harness.completedTurns).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        items: [expect.objectContaining({ type: 'agentMessage', text: '{"answer":4}' })],
      },
    ]);
  });

  it('compiles and restores optional output fields before completion', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);
    const outputSchema = {
      type: 'object',
      properties: { kept: { type: 'string' }, dropped: { type: 'string' } },
      additionalProperties: false,
    };

    const submission = requireSubmitted(await harness.manager.submitTextInput({
      text: 'return optional JSON',
      outputSchema,
    }));

    // Optional properties become required-and-nullable on the wire.
    expect(client.outputSchemas).toEqual([{
      type: 'object',
      properties: {
        dropped: { type: ['string', 'null'] },
        kept: { type: ['string', 'null'] },
      },
      required: ['dropped', 'kept'],
      additionalProperties: false,
    }]);
    expect(client.outputSchemas[0]).not.toBe(outputSchema);

    client.emitTurnCompleted('thread-1', 'turn-1', '{"kept":"yes","dropped":null}');

    // Restoration drops the null stand-in for the absent optional field.
    expect(await settledCompletion(submission))
      .toMatchObject({ status: 'completed', resultText: '{"kept":"yes"}' });
    expect(harness.completedTurns[0]?.items).toContainEqual(
      expect.objectContaining({ type: 'agentMessage', text: '{"kept":"yes"}' }),
    );
  });

  it('settles restoration failure without forwarding completion', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.submitTextInput({
      text: 'invalid restored shape',
      outputSchema: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'string' } } },
        required: ['values'],
        additionalProperties: false,
      },
    }));
    client.emitTurnCompleted('thread-1', 'turn-1', '{"values":{}}');

    const completion = await settledCompletion(submission);
    expect(completion).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('$.values: expected array') },
    });
    expect(completion.displaySubmission).toBe(submission);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(harness.completedTurns).toEqual([]);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('discards an ambiguous submission codec before the next turn', async () => {
    const client = new FailOnceFakeCodexClient();
    const harness = createHarness(client);

    await expect(harness.manager.submitTextInput({
      text: 'structured failure',
      outputSchema: optionalValueSchema(),
    })).resolves.toMatchObject({ status: 'ambiguous' });
    expect(harness.manager.isBusy()).toBe(false);

    await expect(harness.manager.submitTextInput({ text: 'plain successor' }))
      .resolves.toMatchObject({ status: 'submitted' });

    expect(client.outputSchemas).toEqual([expect.any(Object), undefined]);
    expect(client.inputs).toEqual(['structured failure', 'plain successor']);
  });

  it.each([
    ['structured then plain', true],
    ['plain then structured', false],
  ])('rejects active-turn mixing for %s', async (_label, structuredFirst) => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);
    const structured = { text: 'structured', outputSchema: optionalValueSchema() };
    const plain = { text: 'plain' };

    await expect(harness.manager.submitTextInput(structuredFirst ? structured : plain))
      .resolves.toMatchObject({ status: 'submitted' });
    await expect(harness.manager.submitTextInput(structuredFirst ? plain : structured))
      .resolves.toMatchObject({
        status: 'failed',
        error: {
          name: 'UnsupportedAgentRuntimeFeatureError',
          feature: 'outputSchema',
          message: expect.stringContaining('incompatible outputSchema'),
        },
      });

    expect(client.inputs).toEqual([structuredFirst ? 'structured' : 'plain']);
  });
});

describe('TurnManager turn lifecycle', () => {
  it('forwards the completed turn (with its turn id) on turn/completed', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    expect(harness.completedTurns).toEqual([]);

    client.emitTurnCompleted('thread-1', 'turn-1', 'work result');
    await settledCompletion(submission);

    expect(harness.completedTurns).toEqual([
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        items: [expect.objectContaining({
          type: 'agentMessage',
          id: 'item-turn-1',
          text: 'work result',
        })],
      },
    ]);
  });

  it('serves a sequential send after the previous turn completed on the retained subscription', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-2']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    client.emitTurnCompleted('thread-1', 'turn-1', 'first result');
    expect(await settledCompletion(first))
      .toMatchObject({ status: 'completed', resultText: 'first result' });
    expect(harness.manager.isBusy()).toBe(false);
    expect(client.handlerCount).toBe(1);

    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'second')));
    client.emitTurnCompleted('thread-1', 'turn-2', 'second result');
    const secondToken = await settledCompletion(second);

    expect(secondToken).toMatchObject({ status: 'completed', resultText: 'second result' });
    expect(secondToken.displaySubmission).toBe(second);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(client.handlerCount).toBe(1);
  });

  it('waitIdle treats the in-flight admission window as busy', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const admission = harness.manager.enqueue(input('msg-1', 'first'));
    await waitFor(() => client.inputs.length === 1);
    expect(harness.manager.isBusy()).toBe(true);

    let idle = false;
    void harness.manager.waitIdle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);

    client.resolveNext('turn-1');
    const submission = requireSubmitted(await admission);
    await flush();
    // The submission is accepted but its native turn has not settled yet.
    expect(harness.manager.isBusy()).toBe(true);
    expect(idle).toBe(false);

    client.emitTurnCompleted('thread-1', 'turn-1', 'done');
    await settledCompletion(submission);
    await waitFor(() => idle);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('retains a completed submission when a later send fails ambiguously and a third send joins', async () => {
    const client = new DeferredFakeCodexClient();
    const harness = createHarness(client);

    const firstAdmission = harness.manager.enqueue(input('msg-1', 'first'));
    await waitFor(() => client.inputs.length === 1);
    client.resolveNext('turn-1');
    const first = requireSubmitted(await firstAdmission);

    const secondAdmission = harness.manager.enqueue(input('msg-2', 'second'));
    await waitFor(() => client.inputs.length === 2);
    // turn-1 finishes while the second turn/start is still in flight, and that
    // turn/start is then lost.
    client.emitTurnCompleted('thread-1', 'turn-1', 'first result');
    client.rejectNext(new Error('turn/start response lost'));

    await expect(secondAdmission).resolves.toMatchObject({
      status: 'ambiguous',
      error: { message: 'turn/start response lost' },
    });
    const firstToken = await settledCompletion(first);
    expect(firstToken).toMatchObject({ status: 'completed', resultText: 'first result' });
    expect(firstToken.displaySubmission).toBe(first);

    const thirdAdmission = harness.manager.enqueue(input('msg-3', 'third'));
    await waitFor(() => client.inputs.length === 3);
    client.resolveNext('turn-3');
    const third = requireSubmitted(await thirdAdmission);
    client.emitTurnCompleted('thread-1', 'turn-3', 'final result');

    expect(await settledCompletion(third))
      .toMatchObject({ status: 'completed', resultText: 'final result' });
    expect(await settledCompletion(first)).toBe(firstToken);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-3']);
    expect(client.inputs).toEqual(['first', 'second', 'third']);
  });
});

describe('TurnManager stop drainage', () => {
  it('settles each still-pending turn as stopped on stop()', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1', 'turn-2']);
    const harness = createHarness(client);

    const first = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'first')));
    const second = requireSubmitted(await harness.manager.enqueue(input('msg-2', 'second')));

    await harness.manager.stop();

    await expect(first.settled).resolves.toEqual({ kind: 'stopped' });
    await expect(second.settled).resolves.toEqual({ kind: 'stopped' });
    expect(harness.completedTurns).toEqual([]);
    expect(client.handlerCount).toBe(0);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('does not re-settle a completed turn as stopped', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    client.emitTurnCompleted('thread-1', 'turn-1', 'work result');
    const token = await settledCompletion(submission);

    await harness.manager.stop();

    expect((await submission.settled).kind).toBe('completion');
    expect(await settledCompletion(submission)).toBe(token);
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
    expect(harness.manager.isBusy()).toBe(false);
    await expect(harness.manager.enqueue(input('msg-2', 'after stop')))
      .resolves.toEqual({ status: 'stopped' });
    expect(client.inputs).toEqual(['work']);
  });

  it('drops structured late completion after stop without restoring twice', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.submitTextInput({
      text: 'wait',
      outputSchema: optionalValueSchema(),
    }));
    await harness.manager.stop();

    client.emitTurnCompleted('thread-1', 'turn-1', '{');
    await flush();

    expect(harness.completedTurns).toEqual([]);
    expect(harness.activity).toEqual([]);
    expect(client.handlerCount).toBe(0);
    await expect(submission.settled).resolves.toEqual({ kind: 'stopped' });
  });
});

describe('TurnManager codex error notifications', () => {
  it('settles a turn as failed on a fatal codex error notification (willRetry:false)', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    // A fatal error terminates the turn: codex emits no turn/completed after it.
    client.emitError('thread-1', 'turn-1', false, 'boom');

    const completion = await settledCompletion(submission);
    if (completion.status !== 'failed') throw new Error('expected a failed completion token');
    expect(completion.error.message).toContain('boom');
    expect(completion.displaySubmission).toBe(submission);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(harness.completedTurns).toEqual([]);
    expect(harness.manager.isBusy()).toBe(false);
  });

  it('ignores a transient codex error (willRetry:true) and completes normally', async () => {
    const client = new ScriptedFakeCodexClient(['turn-1']);
    const harness = createHarness(client);

    const submission = requireSubmitted(await harness.manager.enqueue(input('msg-1', 'work')));
    client.emitError('thread-1', 'turn-1', true, 'transient boom');
    await flush();
    expect(harness.completedTurns).toEqual([]);

    client.emitTurnCompleted('thread-1', 'turn-1', 'recovered result');

    expect(await settledCompletion(submission))
      .toMatchObject({ status: 'completed', resultText: 'recovered result' });
    expect(harness.completedTurns.map((turn) => turn.turnId)).toEqual(['turn-1']);
  });
});

interface Harness {
  manager: TurnManager;
  activity: RuntimeActivityEvent[];
  timeline: string[];
  completedTurns: CollectedTurn[];
  logs: Array<{ level: string; message: string }>;
}

function createHarness(
  client: object,
  overrides: Partial<TurnManagerOptions> = {},
): Harness {
  const activity: RuntimeActivityEvent[] = [];
  const timeline: string[] = [];
  const completedTurns: CollectedTurn[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const manager = new TurnManager({
    dispatcherId: 'flow',
    getThreadId: () => 'thread-1',
    client: client as never,
    activitySink: (event) => {
      activity.push(event);
      timeline.push(`activity:${event.activity.id}`);
    },
    onTurnCompleted: (turn) => {
      completedTurns.push(turn);
      timeline.push(`terminal:${turn.turnId}`);
    },
    log: (level, message) => { logs.push({ level, message }); },
    ...overrides,
  });
  return { manager, activity, timeline, completedTurns, logs };
}

function requireSubmitted(admission: RuntimeAdmission): RuntimeSubmission {
  if (admission.status !== 'submitted') {
    throw new Error(`expected a submitted admission, got ${admission.status}`);
  }
  return admission.submission;
}

async function settledCompletion(submission: RuntimeSubmission): Promise<RuntimeCompletion> {
  const settlement = await submission.settled;
  if (settlement.kind !== 'completion') {
    throw new Error(`expected a completion settlement, got ${settlement.kind}`);
  }
  return settlement.completion;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function input(sourceId: string, text: string): InboundTurnInput {
  return { sourceId, text };
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

interface TurnStartRequestParams {
  threadId: string;
  input: Array<{ text: string }>;
  cwd?: string | null;
  outputSchema?: Record<string, unknown>;
}

/** Replays native codex app-server frames; knows nothing about completions. */
abstract class FakeCodexClientBase {
  readonly inputs: string[] = [];
  readonly outputSchemas: Array<Record<string, unknown> | undefined> = [];
  private readonly handlers = new Set<NotificationHandler>();

  get handlerCount(): number {
    return this.handlers.size;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  emitItemStarted(threadId: string, turnId: string, item: ThreadItem): void {
    this.emit({ method: 'item/started', params: { threadId, turnId, item } });
  }

  emitItemCompleted(
    threadId: string,
    turnId: string,
    item: ThreadItem,
    completedAtMs: number,
  ): void {
    this.emit({
      method: 'item/completed',
      params: { threadId, turnId, completedAtMs, item },
    });
  }

  /** The common native shape: a final assistant item, then the turn terminal. */
  emitTurnCompleted(threadId: string, turnId: string, text: string): void {
    this.emitItemCompleted(
      threadId,
      turnId,
      { type: 'agentMessage', id: `item-${turnId}`, text },
      Date.now(),
    );
    this.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, items: [] } },
    });
  }

  emitRawTurnCompleted(
    threadId: string,
    turn: { id: string; items?: ThreadItem[]; error?: { message: string } },
  ): void {
    this.emit({ method: 'turn/completed', params: { threadId, turn } });
  }

  /** A codex `error` notification scoped to one native turn id. */
  emitError(threadId: string, turnId: string, willRetry: boolean, message: string): void {
    this.emit({
      method: 'error',
      params: { threadId, turnId, willRetry, error: { message } },
    });
  }

  protected recordRequest(method: string, params: unknown): TurnStartRequestParams {
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
    const parsed = params as TurnStartRequestParams;
    this.inputs.push(parsed.input[0]?.text ?? '');
    this.outputSchemas.push(parsed.outputSchema);
    return parsed;
  }

  protected emit(notification: ServerNotification): void {
    for (const handler of [...this.handlers]) handler(notification);
  }
}

/** Answers `turn/start` with scripted native turn ids (same id === native fold). */
class ScriptedFakeCodexClient extends FakeCodexClientBase {
  private nextIndex = 0;

  constructor(private readonly turnIds: readonly string[]) {
    super();
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    this.recordRequest(method, params);
    const turnId = this.turnIds[this.nextIndex++];
    if (turnId === undefined) throw new Error('no scripted native turn id left');
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }
}

/** Holds the `turn/start` response open so tests can order native frames. */
class DeferredFakeCodexClient extends FakeCodexClientBase {
  private readonly pending: Array<{
    resolve: (turnId: string) => void;
    reject: (error: Error) => void;
  }> = [];

  request<R>(method: string, params: unknown): Promise<R> {
    this.recordRequest(method, params);
    return new Promise<R>((resolve, reject) => {
      this.pending.push({
        resolve: (turnId) => { resolve({ turn: { id: turnId } } as TurnStartResponse as R); },
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
}

/** Answers with a fresh native turn id and immediately replays its terminal. */
class AutoCompletingFakeCodexClient extends FakeCodexClientBase {
  private nextTurnId = 1;

  async request<R>(method: string, params: unknown): Promise<R> {
    const parsed = this.recordRequest(method, params);
    const turnId = `turn-${this.nextTurnId++}`;
    const text = parsed.input[0]?.text ?? '';
    queueMicrotask(() => { this.emitTurnCompleted(parsed.threadId, turnId, text); });
    return { turn: { id: turnId } } as TurnStartResponse as R;
  }
}

/** Rejects the first `turn/start`, then answers with the native id `turn-2`. */
class FailOnceFakeCodexClient extends FakeCodexClientBase {
  private requests = 0;

  async request<R>(method: string, params: unknown): Promise<R> {
    this.recordRequest(method, params);
    this.requests += 1;
    if (this.requests === 1) throw new Error('turn/start rejected');
    return { turn: { id: 'turn-2' } } as TurnStartResponse as R;
  }
}
