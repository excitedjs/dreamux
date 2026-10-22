import type {
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompletionDeliveryPolicy,
  type PreparedCompletionFact,
} from '../src/service/completion-router/index.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
import { TeammateCollection } from '../src/service/agent/index.js';
import {
  controllableRuntimeSubmission,
  foldSubmissions,
} from './helpers/runtime-submission.js';
import { deferred } from './helpers/controlled-runtime-provider.js';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = await dispatcherFixture();
  await f.host.start();
  const agent = f.host.dispatcherAgent.mustAgent();
  const delivered: PreparedCompletionFact[] = [];
  const recipient = {
    prepareCompletion: async (fact: PreparedCompletionFact) => ({
      submit: async () => {
        delivered.push(fact);
        return { status: 'accepted' as const };
      },
    }),
  };
  const admission = await agent.submitInput({
    source: 'task',
    text: 'work',
    completionRecipient: recipient,
  });
  if (admission.status !== 'submitted')
    throw new Error('request was not admitted');
  const runtime = f.provider.runtimes[0]!;
  return {
    ...f,
    agent,
    recipient,
    delivered,
    turn: admission.turn,
    runtime,
    input: runtime.submissions[0]!,
  };
}
const native = (text: string): RuntimeCompletion =>
  Object.freeze({ status: 'completed', resultText: text });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AgentService owns requested result reports', () => {
  it('returns the selected value immediately and reports the identical provider token once', async () => {
    const f = await fixture();
    const original = CompletionDeliveryPolicy.prototype.deliverRuntime;
    const tokens: Array<RuntimeCompletion | null> = [];
    const spy = vi
      .spyOn(CompletionDeliveryPolicy.prototype, 'deliverRuntime')
      .mockImplementation(function (
        this: CompletionDeliveryPolicy,
        recipient,
        token,
        fact,
      ) {
        tokens.push(token);
        return original.call(this, recipient, token, fact);
      });
    const completion = f.input.complete('done');
    expect(await f.turn.settled).toEqual({
      status: 'completed',
      resultText: 'done',
    });
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(tokens).toEqual([completion]);
    expect(tokens[0]).toBe(completion);
    expect(Object.isFrozen(tokens[0])).toBe(true);
    expect(f.delivered[0]).toEqual({
      kind: 'teammate',
      source: f.agent.name,
      role: 'dispatcher',
      status: 'completed',
      result: 'done',
    });
    await f.agent.stopForHost();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it.each(['host-stop', 'close'] as const)(
    'suppresses settlement observed after %s and does not revive it',
    async (operation) => {
      const f = await fixture();
      const ending =
        operation === 'host-stop'
          ? f.agent.stopForHost()
          : f.agent.close({ note: 'owner ended input' });
      const completion = f.input.complete('after fence');
      await ending;
      expect(await f.turn.settled).toEqual({
        status: 'completed',
        resultText: 'after fence',
      });
      expect(f.input.settle({ kind: 'completion', completion })).toBe(false);
      expect(f.delivered).toEqual([]);
      if (operation === 'host-stop') await f.agent.activate();
      await tick();
      expect(f.delivered).toEqual([]);
    },
  );
  it.each(['stopped', 'failed', 'rejected'] as const)(
    'reports an independently %s accepted input with no native token',
    async (kind) => {
      const f = await fixture();
      const original = CompletionDeliveryPolicy.prototype.deliverRuntime;
      const tokens: Array<RuntimeCompletion | null> = [];
      vi.spyOn(
        CompletionDeliveryPolicy.prototype,
        'deliverRuntime',
      ).mockImplementation(function (
        this: CompletionDeliveryPolicy,
        recipient,
        token,
        fact,
      ) {
        tokens.push(token);
        return original.call(this, recipient, token, fact);
      });
      const error = new Error('accepted input lost its runtime');
      if (kind === 'stopped') f.input.stop();
      else if (kind === 'failed') f.input.fail(error);
      else {
        const rejected: RuntimeSubmission = Object.freeze({
          settled: Promise.reject(error),
        });
        vi.spyOn(f.runtime.runtime, 'submit').mockResolvedValueOnce({
          status: 'submitted',
          submission: rejected,
        });
        const second = await f.agent.submitInput({
          source: 'task',
          text: 'rejected input',
          completionRecipient: f.recipient,
        });
        if (second.status !== 'submitted')
          throw new Error('rejected promise not admitted');
        expect(await second.turn.settled).toEqual({ status: 'failed', error });
      }
      if (kind !== 'rejected')
        expect(await f.turn.settled).toEqual(
          kind === 'stopped'
            ? { status: 'stopped' }
            : { status: 'failed', error },
        );
      await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
      expect(tokens).toEqual([null]);
      expect(f.delivered[0]).toMatchObject({
        status: kind === 'stopped' ? 'stopped' : 'failed',
        result: null,
      });
    },
  );
  it('reports a failed native value with its identity but preserves header-only failure content', async () => {
    const f = await fixture();
    const error = new Error('private native failure');
    const token = f.input.failCompletion(error);
    const spy = vi.spyOn(CompletionDeliveryPolicy.prototype, 'deliverRuntime');
    expect(await f.turn.settled).toEqual({ status: 'failed', error });
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(
      f.recipient,
      token,
      expect.objectContaining({ status: 'failed', result: null }),
    );
  });
  it.each(['host-stop', 'close'] as const)(
    'joins a started requested report on %s after the input has selected its result',
    async (operation) => {
      const f = await fixture();
      const invoked = deferred<void>();
      const release = deferred<void>();
      const original = CompletionDeliveryPolicy.prototype.deliverRuntime;
      const spy = vi
        .spyOn(CompletionDeliveryPolicy.prototype, 'deliverRuntime')
        .mockImplementation(async function (
          this: CompletionDeliveryPolicy,
          recipient,
          token,
          fact,
        ) {
          invoked.resolve();
          await release.promise;
          return original.call(this, recipient, token, fact);
        });
      f.input.complete('before stop');
      await f.turn.settled;
      await invoked.promise;
      const ending =
        operation === 'host-stop'
          ? f.agent.stopForHost()
          : f.agent.close({ note: 'after selection' });
      let ended = false;
      void ending.then(() => {
        ended = true;
      });
      await tick();
      expect(ended).toBe(false);
      release.resolve();
      await ending;
      expect(f.delivered).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['host-stop', 'close'] as const)(
    'surfaces a report rejection during %s after retiring the accepted input',
    async (operation) => {
      const f = await fixture();
      const error = new Error('owned report rejected after input retirement');
      const rejected = deferred<void>();
      vi.spyOn(
        CompletionDeliveryPolicy.prototype,
        'deliverRuntime',
      ).mockImplementation(async () => {
        rejected.resolve();
        throw error;
      });
      f.input.complete('selected value');
      expect(await f.turn.settled).toEqual({
        status: 'completed',
        resultText: 'selected value',
      });
      await rejected.promise;
      await tick();
      const ending =
        operation === 'host-stop'
          ? f.agent.stopForHost()
          : f.agent.close({ note: 'after rejected report' });
      await expect(ending).rejects.toBe(error);
      // Convergence has observed the failure; retry can release the same owner.
      if (operation === 'host-stop') await f.agent.stopForHost();
      else await f.agent.close({ note: 'retry after failure observed' });
    },
  );
  it('keeps settlement-only compatibility for old providers and folds separate inputs with one value', async () => {
    const f = await fixture();
    const second = await f.agent.submitInput({
      source: 'task',
      text: 'folded',
      completionRecipient: f.recipient,
    });
    if (second.status !== 'submitted')
      throw new Error('second request not admitted');
    expect(second.turn.id).not.toBe(f.turn.id);
    foldSubmissions(f.runtime.submissions, 'one answer');
    expect(await f.turn.settled).toEqual({
      status: 'completed',
      resultText: 'one answer',
    });
    expect(await second.turn.settled).toEqual({
      status: 'completed',
      resultText: 'one answer',
    });
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
  });
  it('uses completion identity rather than equal text for distinct ordinary native reports', async () => {
    const f = await fixture();
    const spawned = await f.host.teammates.spawn({
      name: 'member',
      prompt: 'member work',
      intent: 'identity',
    });
    if (!(f.host.teammates instanceof TeammateCollection))
      throw new Error('missing actual collection');
    const runtime = f.provider.runtimes.at(-1)!;
    const member = f.host.teammates
      .materializedEntities()
      .find((member) => member.name === spawned.teammate.name)!;
    const first = native('same');
    const second = native('same');
    runtime.context.events({ kind: 'turn.result', completion: first });
    runtime.submissions[0]!.settle({ kind: 'completion', completion: first });
    runtime.context.events({ kind: 'turn.result', completion: second });
    await vi.waitFor(() =>
      expect(
        f.runtime.inputs.filter((text) =>
          text.startsWith('<task-notification>'),
        ),
      ).toHaveLength(2),
    );
    await member.stopForHost();
    expect(
      f.runtime.inputs.filter((text) => text.startsWith('<task-notification>')),
    ).toHaveLength(2);
  });
  it('enters the requested report queue in its settlement reaction before a later dispatcher fence', async () => {
    const f = await fixture();
    void f.input.submission.settled.then(() => f.host.fence.close());
    f.input.complete('selected before aggregate fence');
    await f.turn.settled;
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(f.host.fence.isClosing()).toBe(true);
    expect(f.delivered[0]?.result).toBe('selected before aggregate fence');
  });
  it('drops a requested report when the dispatcher fence precedes the settlement reaction', async () => {
    const f = await fixture();
    f.host.fence.close();
    f.input.complete('selected behind aggregate fence');
    await f.turn.settled;
    await tick();
    expect(f.delivered).toEqual([]);
  });
  it('does not let a private unadmitted settlement create a reply right', async () => {
    const f = await fixture();
    const privateInput = controllableRuntimeSubmission();
    const ambiguous = deferred<void>();
    vi.spyOn(f.runtime.runtime, 'submit').mockImplementationOnce(async () => {
      privateInput.complete('unadmitted');
      ambiguous.resolve();
      return { status: 'ambiguous', error: new Error('write not confirmed') };
    });
    const admission = await f.agent.submitInput({
      source: 'task',
      text: 'ambiguous input',
      completionRecipient: f.recipient,
    });
    await ambiguous.promise;
    expect(admission.status).toBe('ambiguous');
    await tick();
    expect(f.delivered).toEqual([]);
    expect(privateInput.stop()).toBe(false);
  });
});
