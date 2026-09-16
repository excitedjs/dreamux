import { describe, expect, it } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import type { CodexWsClient } from '../src/rpc.js';
import type { CodexProcess } from '../src/supervisor.js';
import { FAKE_PATHS, FakeCodexProcess, FakeCodexWsClient, noopStateSink, waitFor } from './helpers/codex-runtime-fakes.js';

function createRuntime(client: FakeCodexWsClient, sessionId: string | null = null): CodexRuntime {
  return new CodexRuntime({ runtimeId: 'effort-test', sessionId }, {
    cwd: '/fake/cwd',
    state: noopStateSink(),
    activitySink: () => undefined,
    codec: null,
    paths: FAKE_PATHS,
    allocateSocketPath: () => '/fake/run/effort.sock',
    codexProcessFactory: () => new FakeCodexProcess() as unknown as CodexProcess,
    codexClientFactory: () => client as unknown as CodexWsClient,
  });
}

describe('Codex ultrathink submissions', () => {
  it('requests the model maximum and restores the original effort on an ordinary submission', async () => {
    const client = new FakeCodexWsClient();
    const runtime = createRuntime(client);
    await runtime.start();
    try {
      await runtime.submit({ text: 'ordinary task' });
      await runtime.submit({ text: '请ultrathink一下' });
      await runtime.submit({ text: 'next task' });
      const requests = client.requests.filter((request) => request.method === 'turn/start');
      expect(requests.map((request) => (request.params as { effort?: string }).effort))
        .toEqual([undefined, 'xhigh', 'low']);
      expect(requests[1]?.params).toMatchObject({ input: [{ text: '请ultrathink一下' }] });
      expect(requests[2]?.params).toMatchObject({ input: [{ text: 'next task' }] });
    } finally {
      await runtime.stop();
    }
  });

  it.each(['ULTRATHINK', 'UltraThink', 'prefixULTRATHINKsuffix', 'quoted: "ultrathink"'])(
    'matches %s without altering the original text', async (text) => {
      const client = new FakeCodexWsClient();
      const runtime = createRuntime(client);
      await runtime.start();
      try {
        expect((await runtime.submit({ text })).status).toBe('submitted');
        const params = client.requests.find((request) => request.method === 'turn/start')?.params;
        expect(params).toMatchObject({ effort: 'xhigh', input: [{ text }] });
      } finally {
        await runtime.stop();
      }
    },
  );

  it.each([
    { supported: ['high', 'low', 'medium'], ordinary: null, expected: 'high', baseline: 'medium' },
    { supported: ['max', 'medium', 'xhigh'], ordinary: 'medium', expected: 'max', baseline: 'medium' },
    { supported: ['ultra', 'max', 'persistent', 'disabled'], ordinary: 'max', expected: 'max', baseline: 'max' },
  ])('uses the model maximum $expected and restores $baseline after repeated triggers', async ({ supported, ordinary, expected, baseline }) => {
    const client = new FakeCodexWsClient({
      model: 'selected-model', reasoningEffort: ordinary,
      models: [
        { model: 'other-model', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] },
        { model: 'selected-model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: supported.map((reasoningEffort) => ({ reasoningEffort })) },
      ],
    });
    const runtime = createRuntime(client);
    await runtime.start();
    try {
      for (const text of ['ultrathink first', 'ultrathink second', 'ordinary', 'still ordinary']) {
        expect((await runtime.submit({ text })).status).toBe('submitted');
      }
      const requests = client.requests.filter((request) => request.method === 'turn/start');
      expect(requests.map((request) => (request.params as { effort: string }).effort))
        .toEqual([expected, expected, baseline, baseline]);
      expect(requests[3]?.params).toMatchObject({ input: [{ text: 'still ordinary' }] });
    } finally {
      await runtime.stop();
    }
  });

  it.each([['low', 'low'], [null, 'medium']])(
    'restores configured effort %s after resuming a thread left at a temporary high effort', async (configuredEffort, expected) => {
      const client = new FakeCodexWsClient({ reasoningEffort: 'xhigh', configuredEffort });
      const runtime = createRuntime(client, 'resumed-thread');
      await runtime.start();
      try {
        await runtime.submit({ text: 'ordinary after restart' });
        await runtime.submit({ text: 'ultrathink again' });
        await runtime.submit({ text: 'ordinary again' });
        const requests = client.requests.filter((request) => request.method === 'turn/start');
        expect(requests.map((request) => (request.params as { effort: string }).effort))
          .toEqual([expected, 'xhigh', expected]);
        expect(requests[0]?.params).toMatchObject({ threadId: 'resumed-thread', input: [{ text: 'ordinary after restart' }] });
      } finally {
        await runtime.stop();
      }
    },
  );

  it('admits marked and ordinary busy inputs into the same native turn without awaiting completion', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false, scriptedTurnIds: ['folded', 'folded', 'folded'] });
    const runtime = createRuntime(client);
    await runtime.start();
    try {
      const submissions = [];
      for (const text of ['first task', 'ultrathink appended', 'ordinary appended']) {
        const admission = await runtime.submit({ text });
        if (admission.status !== 'submitted') throw new Error(`Unexpected admission: ${admission.status}`);
        submissions.push(admission.submission);
      }
      expect(client.requests.filter((request) => request.method === 'turn/start')
        .map((request) => (request.params as { effort?: string }).effort))
        .toEqual([undefined, 'xhigh', 'low']);
      client.emitCompleted('fresh-thread-1', 'folded', 'done');
      const settlements = await Promise.all(submissions.map((submission) => submission.settled));
      expect(settlements).toHaveLength(3);
      expect(settlements[0]).toMatchObject({ kind: 'completion', completion: { resultText: 'done' } });
      expect(settlements[1]).toEqual(settlements[0]);
      expect(settlements[2]).toEqual(settlements[0]);
    } finally {
      await runtime.stop();
    }
  });

  it('does not change another runtime or global settings', async () => {
    const markedClient = new FakeCodexWsClient();
    const ordinaryClient = new FakeCodexWsClient({ freshThreadId: 'other-thread' });
    const marked = createRuntime(markedClient);
    const ordinary = createRuntime(ordinaryClient);
    await Promise.all([marked.start(), ordinary.start()]);
    try {
      await marked.submit({ text: 'ultrathink' });
      await ordinary.submit({ text: 'ordinary' });
      expect(ordinaryClient.requests.find((request) => request.method === 'turn/start')?.params)
        .not.toHaveProperty('effort');
      expect([...markedClient.methods, ...ordinaryClient.methods].some((method) => /config\/.*write/i.test(method))).toBe(false);
    } finally {
      await Promise.all([marked.stop(), ordinary.stop()]);
    }
  });

  it.each([{ supportedReasoningEfforts: [] }, { supportedReasoningEfforts: [{ reasoningEffort: 'unknown-effort' }] }])('rejects unusable model effort metadata before submitting input', async ({ supportedReasoningEfforts }) => {
    const client = new FakeCodexWsClient({ models: [{ model: 'test-model', defaultReasoningEffort: 'low', supportedReasoningEfforts }] });
    const runtime = createRuntime(client);
    await runtime.start();
    try {
      expect(await runtime.submit({ text: 'ultrathink' })).toMatchObject({ status: 'failed', error: expect.any(Error) });
      expect(client.methods).not.toContain('turn/start');
      expect((await runtime.submit({ text: 'ordinary' })).status).toBe('submitted');
    } finally {
      await runtime.stop();
    }
  });

  it('finds the selected model on a later catalog page', async () => {
    const client = new FakeCodexWsClient();
    const runtime = createRuntime(client);
    await runtime.start();
    client.block('model/list');
    try {
      const admission = runtime.submit({ text: 'ultrathink' });
      await waitFor(() => client.hasBlocked('model/list'));
      client.release('model/list', { data: [], nextCursor: 'second-page' });
      expect((await admission).status).toBe('submitted');
      expect(client.requests.filter((request) => request.method === 'model/list').at(-1)?.params)
        .toMatchObject({ cursor: 'second-page', includeHidden: true });
    } finally {
      await runtime.stop();
    }
  });

  it('does not send input when stopped during catalog discovery', async () => {
    const client = new FakeCodexWsClient();
    const runtime = createRuntime(client);
    await runtime.start();
    client.block('model/list');
    const admission = runtime.submit({ text: 'ultrathink' });
    await waitFor(() => client.hasBlocked('model/list'));
    await runtime.stop();
    expect((await admission).status).not.toBe('submitted');
    expect(client.methods).not.toContain('turn/start');
  });

  it('rejects input when the active native session fails during catalog discovery', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const runtime = createRuntime(client);
    await runtime.start();
    try {
      await runtime.submit({ text: 'active task' });
      client.block('model/list');
      const admission = runtime.submit({ text: 'ultrathink appended' });
      await waitFor(() => client.hasBlocked('model/list'));
      client.emitUnscopedError('fresh-thread-1', 'native session failed');
      client.release('model/list', {
        data: [{ model: 'test-model', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
        nextCursor: null,
      });
      expect(await admission).toMatchObject({ status: 'failed', error: new Error('native session failed') });
      expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});
