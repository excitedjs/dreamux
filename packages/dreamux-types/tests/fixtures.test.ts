/**
 * Runtime assertion that the external-provider fixture (which imports
 * `@excitedjs/dreamux-types` only) behaves, proving the type package is enough
 * to author a provider against. Type-only imports compile away, so this also
 * confirms the package surface is consumable. The fixture's
 * `@excitedjs/dreamux-types`-only import discipline is checked in
 * `import-boundary.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import type {
  RuntimeActivityEvent,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

import {
  EXTERNAL_RUNTIME_CAPABILITIES,
  createNativeTurnWindowRuntimeFixture,
  createPendingAdmissionRuntimeFixture,
  describeConfigContext,
  fixtureChannelFactory,
  fixtureChannelProvider,
  fixtureRuntimeFactory,
  fixtureRuntimeProvider,
} from './fixtures/external-provider.js';

/**
 * Take the frozen completion token an accepted send settled with. Fails loudly
 * on any other settlement, so a `stopped`/`failed` settlement can never be
 * mistaken for a token.
 */
async function completionOf(
  submission: RuntimeSubmission,
): Promise<RuntimeCompletion> {
  const settlement = await submission.settled;
  expect(settlement.kind).toBe('completion');
  if (settlement.kind !== 'completion') throw new Error('unreachable');
  return settlement.completion;
}

describe('external provider fixture', () => {
  it('declares neutral runtime capabilities', () => {
    expect(EXTERNAL_RUNTIME_CAPABILITIES.resume.supported).toBe(false);
  });

  it('narrows provider descriptors to their kind (P2)', () => {
    expect(fixtureRuntimeProvider.descriptor.kind).toBe('agentRuntime');
    expect(fixtureChannelProvider.descriptor.kind).toBe('channel');
  });

  it('factories echo the seed descriptor from the loader context (P1)', async () => {
    const runtime = await fixtureRuntimeFactory({
      ref: 'npm:@example/fixture-runtime',
      descriptor: fixtureRuntimeProvider.descriptor,
    });
    expect(runtime.descriptor.kind).toBe('agentRuntime');
    const channel = await fixtureChannelFactory({
      ref: 'npm:@example/fixture-channel',
      descriptor: fixtureChannelProvider.descriptor,
    });
    expect(channel.descriptor.kind).toBe('channel');
  });

  it('delivers a plain text turn through required completionInput', async () => {
    const runtime = fixtureRuntimeProvider.createRuntime({
      identity: { runtime_id: 'd1', checkpoint: null },
      config: { model: 'm' },
      cwd: '/tmp/fixture',
      mcpServers: [],
      // Required by the create context and installed before start().
      activitySink: () => {},
    });
    expect(runtime.completionInput).toBeDefined();
    const result = await runtime.completionInput({
      text: 'done',
      sourceId: 't1',
    });
    expect(result.status).toBe('submitted');
    if (result.status === 'submitted') {
      await expect(result.submission.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { status: 'completed' },
      });
    }
  });

  it('formats a config-read context', () => {
    expect(
      describeConfigContext({
        providerRef: 'npm:@example/fixture',
        agentId: 'a1',
        file: 'config.json',
        prefix: 'agents[0]',
      }),
    ).toBe('npm:@example/fixture:a1');
  });

  it('implements a full AgentRuntimeProvider against types only', async () => {
    expect(fixtureRuntimeProvider.descriptor.kind).toBe('agentRuntime');
    // `readConfig` is sync-or-async (parity with `ChannelProvider.readConfig`,
    // F4); awaiting covers both shapes.
    const config = await fixtureRuntimeProvider.readConfig?.(
      { model: 'fixture-model' },
      {
        providerRef: 'npm:@example/fixture-runtime',
        agentId: 'a1',
        file: 'config.json',
        prefix: 'agents[0]',
      },
    );
    expect(config).toEqual({ model: 'fixture-model' });

    const runtime = fixtureRuntimeProvider.createRuntime({
      identity: { runtime_id: 'd1', checkpoint: null },
      config: config ?? { model: 'default' },
      cwd: '/tmp/fixture',
      mcpServers: [],
      activitySink: () => {},
    });
    expect(runtime.getStatus()).toBe('declared');
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');
    const result = await runtime.channelInput({ text: 'hi', sourceId: 'm1' });
    expect(result.status).toBe('submitted');
    if (result.status === 'submitted') {
      await expect(result.submission.settled).resolves.toMatchObject({
        kind: 'completion',
        completion: { status: 'completed' },
      });
    }
    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('does not resolve stop before an already-started admission converges', async () => {
    const fixture = createPendingAdmissionRuntimeFixture();
    const admission = fixture.runtime.completionInput({
      text: 'in flight',
      sourceId: 'external-stop-contract',
    });
    await fixture.admissionStarted;

    const stopping = fixture.runtime.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    // Drain real macrotasks, not a single microtask: a one-tick fence is
    // defeated by any `stop()` that merely awaits a couple of resolved
    // promises, so it would not prove the ORDERING the contract requires
    // ("stop MUST NOT resolve while an already-started admission can still
    // resolve to a newly accepted submission").
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(stopped).toBe(false);

    fixture.releaseTransport();
    // `toEqual` is exact: a stopped admission carries no `submission`, and with
    // no submission to hang `displaySubmission` on this path can mint no
    // completion token at all.
    await expect(admission).resolves.toEqual({ status: 'stopped' });
    await stopping;
    await expect(fixture.runtime.channelInput({
      text: 'late',
      sourceId: 'external-late-contract',
    })).resolves.toEqual({ status: 'stopped' });
    expect(fixture.runtime.getStatus()).toBe('stopped');
  });

  it('folds two sends onto one native result: both settle with the same frozen token', async () => {
    const fixture = createNativeTurnWindowRuntimeFixture();
    const first = await fixture.runtime.completionInput({
      text: 'first',
      sourceId: 'fold-1',
    });
    const second = await fixture.runtime.channelInput({
      text: 'second',
      sourceId: 'fold-2',
    });
    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    if (first.status !== 'submitted' || second.status !== 'submitted') return;

    // ONE provider-observed native result closes the open window.
    const native = fixture.completeNativeTurn('folded result');
    const firstToken = await completionOf(first.submission);
    const secondToken = await completionOf(second.submission);

    expect(firstToken).toBe(secondToken);
    expect(firstToken).toBe(native);
    expect(Object.isFrozen(firstToken)).toBe(true);
    // The send that opened the window owns the display position.
    expect(native.displaySubmission).toBe(first.submission);
  });

  it('queues two native results: distinct tokens even with byte-identical text', async () => {
    const fixture = createNativeTurnWindowRuntimeFixture();
    const first = await fixture.runtime.completionInput({
      text: 'same text',
      sourceId: 'queue-1',
    });
    expect(first.status).toBe('submitted');
    if (first.status !== 'submitted') return;
    const firstNative = fixture.completeNativeTurn('identical result text');

    const second = await fixture.runtime.completionInput({
      text: 'same text',
      sourceId: 'queue-2',
    });
    expect(second.status).toBe('submitted');
    if (second.status !== 'submitted') return;
    const secondNative = fixture.completeNativeTurn('identical result text');

    const firstToken = await completionOf(first.submission);
    const secondToken = await completionOf(second.submission);

    // Each submission settles with the token minted by ITS OWN native result...
    expect(firstToken).toBe(firstNative);
    expect(secondToken).toBe(secondNative);
    // ...and each token displays through its own send, so a queued result can
    // never be attributed to the window that came before it.
    expect(firstToken.displaySubmission).toBe(first.submission);
    expect(secondToken.displaySubmission).toBe(second.submission);
    expect(firstToken).toMatchObject({ resultText: 'identical result text' });
    expect(secondToken).toMatchObject({ resultText: 'identical result text' });
    // Two native results are two identities, byte-identical text or not.
    expect(firstToken).not.toBe(secondToken);
  });

  it('mints each token with the result text of the native result that produced it', async () => {
    // Guards against a provider that reuses one payload for every completion:
    // byte-identical text is legal, but it must be the text the native result
    // actually carried, per token.
    const fixture = createNativeTurnWindowRuntimeFixture();
    const tokens: RuntimeCompletion[] = [];
    for (const text of ['alpha answer', 'beta answer', null]) {
      const accepted = await fixture.runtime.completionInput({
        text: 'go',
        sourceId: `text-${tokens.length}`,
      });
      expect(accepted.status).toBe('submitted');
      tokens.push(fixture.completeNativeTurn(text));
    }

    expect(tokens.map((token) =>
      token.status === 'completed' ? token.resultText : '<failed>')).toEqual([
      'alpha answer',
      'beta answer',
      null,
    ]);
    expect(new Set(tokens).size).toBe(3);
  });

  it('reports live activity through the required sink, attributed to the owning submission', async () => {
    // The create context's `activitySink` is REQUIRED, and an external provider
    // authored against the types alone must be able to drive it.
    const activity: RuntimeActivityEvent[] = [];
    const runtime = fixtureRuntimeProvider.createRuntime({
      identity: { runtime_id: 'activity-1', checkpoint: null },
      config: { model: 'fixture-model' },
      cwd: '/tmp/fixture',
      mcpServers: [],
      activitySink: (event) => {
        activity.push(event);
      },
    });
    await runtime.start();

    const accepted = await runtime.channelInput({
      text: 'observe me',
      sourceId: 'activity-1',
    });
    expect(accepted.status).toBe('submitted');
    if (accepted.status !== 'submitted') return;

    expect(activity.length).toBeGreaterThan(0);
    for (const event of activity) {
      // Every fact is attributed to the send that owns it, not to a global slot.
      expect(event.submission).toBe(accepted.submission);
      expect(typeof event.occurredAt).toBe('number');
    }
    expect(activity.map((event) => event.activity.kind)).toContain(
      'assistant.message',
    );
    await runtime.stop();
  });

  it('resolves a channel target through the fixture session', async () => {
    const session = fixtureChannelProvider.createSession({
      dispatcher_id: 'd1',
      channel_id: 'fixture',
      provider: 'npm:@example/fixture-channel',
      config: {},
    });
    const target = await session.resolveTarget({ id: 'group-123' });
    expect(target).toEqual({
      target_type: 'group',
      target_key: 'group-123',
      bindable: true,
    });
  });
});
