/** Native protocol replays through the real RPC and provider; no live Claude child. */
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeCodeAgentRuntimeProvider } from '../src/provider.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import type {
  AgentRuntime,
  RuntimeActivity,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function harness(onActivity?: (activity: RuntimeActivity) => void) {
  const writes: Array<{ uuid: string }> = [];
  const activity: RuntimeActivity[] = [];
  const reap = vi.fn();
  const createSession = vi.fn();
  let rpc!: ClaudeCodeStreamRpc;
  let exitSession!: () => void;
  const provider = createClaudeCodeAgentRuntimeProvider({
    resolveBinPath: (bin) => bin,
    generateSessionId: () => 'test-session',
    sessionFactory: (spec) => {
      createSession();
      let alive = false;
      let onExit: ((error: Error) => void) | undefined;
      const sessionRpc = new ClaudeCodeStreamRpc(new Writable({
        write(chunk: Buffer, _encoding, callback) {
          writes.push(JSON.parse(chunk.toString()) as { uuid: string });
          callback();
        },
      }), {
        sessionId: spec.sessionId,
        outputSchemaEnabled: spec.outputSchemaEnabled,
        turnTimeoutMs: 5_000,
        reapOnTimeout: reap,
        onProtocolEvent: spec.onProtocolEvent,
      });
      rpc = sessionRpc;
      exitSession = () => {
        alive = false;
        const error = new Error('native child exited');
        sessionRpc.fail(error);
        onExit?.(error);
      };
      return {
        start: async () => { alive = true; },
        submit: (prompt, options, uuid) => sessionRpc.submit(prompt, options, uuid),
        isAlive: () => alive,
        setOnExit: (handler) => { onExit = handler; },
        stop: async () => {
          alive = false;
          sessionRpc.stop();
        },
      };
    },
  });
  const runtime = await provider.createRuntime({
    identity: { runtimeId: 'background-test', sessionId: null },
    config: defaultDispatcherClaudeCodeConfig(),
    cwd: '/tmp/dreamux-background-test',
    mcpServers: [],
    skillSources: [],
    disabledFeatures: [],
    paths: {
      cacheDir: () => '/tmp/dreamux-background-test/cache',
      logsDir: () => '/tmp/dreamux-background-test/logs',
      runtimeSocketDirs: () => ['/tmp/dreamux-background-test/sockets'],
    },
    state: { publish: async () => undefined },
    activity: (event) => { activity.push(event); onActivity?.(event); },
  });
  runtimes.push(runtime);
  await runtime.start();
  const emit = (...events: Record<string, unknown>[]): void => {
    rpc.onStdoutChunk(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  };
  const lifecycle = (uuid: string, state: string): void => {
    emit({ type: 'command_lifecycle', command_uuid: uuid, state });
  };
  const result = (text: string, extra: Record<string, unknown> = {}): void => {
    emit({ type: 'result', subtype: 'success', result: text, ...extra });
  };
  const submit = async (text: string): Promise<RuntimeSubmission> => {
    const admission = await runtime.submit({ text });
    if (admission.status !== 'submitted') throw new Error(`admission: ${admission.status}`);
    await tick();
    return admission.submission;
  };
  const completion = async (submission: RuntimeSubmission): Promise<RuntimeCompletion> => {
    const settlement = await submission.settled;
    if (settlement.kind !== 'completion') throw new Error(`settlement: ${settlement.kind}`);
    return settlement.completion;
  };
  const initial = await submit('initial');
  lifecycle(writes[0]!.uuid, 'started');
  emit({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] });
  result('same', { user_message_uuid: writes[0]!.uuid });
  lifecycle(writes[0]!.uuid, 'completed');
  const initialCompletion = await completion(initial);
  await tick();
  return { runtime, writes, activity, reap, createSession, emit, lifecycle, result, submit, completion, initialCompletion, exitSession: () => exitSession() };
}

const assistant = (text: string): Record<string, unknown> => ({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
});

describe('resident background turns and submitted commands', () => {
  it('publishes background text, tools, compaction and end without pending requests, then serves another input', async () => {
    const h = await harness();
    h.activity.length = 0;
    h.emit(assistant('background work'), {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'background-tool', name: 'Bash', input: { command: 'pwd' } }] },
    }, {
      type: 'user',
      message: { content: [
        { type: 'text', text: 'private injected context' },
        { type: 'tool_result', tool_use_id: 'background-tool', content: 'done' },
      ] },
    }, { type: 'system', subtype: 'compact_boundary' });
    h.result('background answer');
    expect(h.activity.map((event) => event.kind)).toEqual([
      'assistant.message', 'tool.call', 'tool.call', 'assistant.message', 'turn.ended',
    ]);
    expect(h.activity[2]).toMatchObject({ toolName: 'Bash', status: 'completed', result: 'done', arguments: { command: 'pwd' } });
    expect(h.activity[3]).toMatchObject({ text: 'Compacted session' });
    expect(h.activity[4]).toMatchObject({ status: 'completed' });

    const next = await h.submit('next');
    h.lifecycle(h.writes[1]!.uuid, 'started');
    h.result('next answer', { user_message_uuid: h.writes.at(-1)!.uuid });
    h.lifecycle(h.writes[1]!.uuid, 'completed');
    expect(await h.completion(next)).toEqual({ status: 'completed', resultText: 'next answer' });
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it.each([{}, { user_message_uuid: 'internal-background-input' }, { origin: { kind: 'task-notification' } }])(
    'settles a started steer regardless of the result metadata %j', async (extra) => {
      const h = await harness();
      // Aggregation starts before B exists and must survive B's admission.
      h.emit(assistant('background answer'));
      const b = await h.submit('B');
      const uuid = h.writes[1]!.uuid;
      h.lifecycle(uuid, 'queued');
      h.lifecycle(uuid, 'started');
      h.lifecycle(uuid, 'completed');
      h.result('', extra);
      expect(await h.completion(b)).toEqual({ status: 'completed', resultText: 'background answer' });
      await tick();
      expect(h.reap).not.toHaveBeenCalled();
      expect(h.createSession).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['before', 'after'])('keeps a sole queued request pending across a background result, with completed %s its own result', async (terminalOrder) => {
    const h = await harness();
    const b = await h.submit('B');
    const settled = vi.fn();
    void b.settled.then(settled);
    const uuid = h.writes[1]!.uuid;
    h.lifecycle(uuid, 'queued');
    h.result('same', { user_message_uuid: 'internal-background-input' });
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.lifecycle(uuid, 'started');
    if (terminalOrder === 'before') h.lifecycle(uuid, 'completed');
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.result('same', { user_message_uuid: uuid });
    if (terminalOrder === 'after') h.lifecycle(uuid, 'completed');
    const token = await h.completion(b);
    expect(token).toEqual(h.initialCompletion);
    expect(token).not.toBe(h.initialCompletion);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it.each([{}, { user_message_uuid: 'internal-background-input' }])(
    'does not let an unrelated result consume a sole request awaiting queued acknowledgement %j', async (extra) => {
      const h = await harness();
      const b = await h.submit('B');
      const settled = vi.fn();
      void b.settled.then(settled);
      h.result('background answer', extra);
      await tick();
      expect(settled).not.toHaveBeenCalled();
      h.lifecycle(h.writes[1]!.uuid, 'queued');
      h.lifecycle(h.writes[1]!.uuid, 'started');
      h.result('B answer', { user_message_uuid: h.writes[1]!.uuid });
      h.lifecycle(h.writes[1]!.uuid, 'completed');
      expect(await h.completion(b)).toMatchObject({ resultText: 'B answer' });
      expect(h.reap).not.toHaveBeenCalled();
    },
  );

  it.each(['queued', 'refused', 'discarded'])('supports no-start matching-UUID compatibility when B is %s, without answering B early', async (state) => {
    const h = await harness();
    const a = await h.submit('A');
    const b = await h.submit('B');
    const aUuid = h.writes[1]!.uuid;
    const bUuid = h.writes[2]!.uuid;
    const aSettled = vi.fn();
    const bSettled = vi.fn();
    void a.settled.then(aSettled);
    void b.settled.then(bSettled);
    h.lifecycle(bUuid, state);
    h.result('A answer', { user_message_uuid: aUuid });
    await tick();
    expect(aSettled).toHaveBeenCalledWith({
      kind: 'completion', completion: { status: 'completed', resultText: 'A answer' },
    });
    if (state === 'queued') expect(bSettled).not.toHaveBeenCalled();
    else expect(bSettled).toHaveBeenCalledWith({ kind: 'failed', error: expect.any(Error) });
    const aToken = await h.completion(a);
    h.lifecycle(aUuid, 'completed');

    if (state === 'queued') {
      await tick();
      expect(bSettled).not.toHaveBeenCalled();
      h.lifecycle(bUuid, 'started');
      h.result('B answer', { user_message_uuid: bUuid });
      h.lifecycle(bUuid, 'completed');
      const bToken = await h.completion(b);
      expect(bToken).toEqual({ status: 'completed', resultText: 'B answer' });
      expect(bToken).not.toBe(aToken);
    } else {
      await expect(b.settled).resolves.toMatchObject({ kind: 'failed' });
    }
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('supports no-start matching-UUID compatibility alongside all started fold members', async () => {
    const h = await harness();
    const a = await h.submit('A');
    const b = await h.submit('B');
    const c = await h.submit('C');
    for (const { uuid } of h.writes.slice(2)) {
      h.lifecycle(uuid, 'started');
      h.lifecycle(uuid, 'completed');
    }
    h.result('A, B and C answer', { user_message_uuid: h.writes[1]!.uuid });
    h.lifecycle(h.writes[1]!.uuid, 'completed');
    const [aToken, bToken, cToken] = await Promise.all([a, b, c].map(h.completion));
    expect(aToken).toEqual({ status: 'completed', resultText: 'A, B and C answer' });
    expect(bToken).toBe(aToken);
    expect(cToken).toBe(aToken);
    expect(Object.isFrozen(aToken)).toBe(true);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('settles folded background steers with one immutable token after both completed events, then accepts another request', async () => {
    const h = await harness();
    h.emit(assistant('background'));
    const b = await h.submit('B');
    const c = await h.submit('C');
    for (const { uuid } of h.writes.slice(1)) h.lifecycle(uuid, 'queued');
    for (const { uuid } of h.writes.slice(1)) h.lifecycle(uuid, 'started');
    for (const { uuid } of h.writes.slice(1)) h.lifecycle(uuid, 'completed');
    h.result('B and C answer', { origin: { kind: 'task-notification' } });
    const [bToken, cToken] = await Promise.all([h.completion(b), h.completion(c)]);
    expect(bToken).toEqual({ status: 'completed', resultText: 'B and C answer' });
    expect(cToken).toBe(bToken);
    expect(Object.isFrozen(bToken)).toBe(true);
    await tick();
    const next = await h.submit('next');
    h.lifecycle(h.writes[3]!.uuid, 'started');
    h.result('next answer', { user_message_uuid: h.writes.at(-1)!.uuid });
    h.lifecycle(h.writes[3]!.uuid, 'completed');
    expect(await h.completion(next)).toMatchObject({ resultText: 'next answer' });
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('does not give a background result to input awaiting its native write', async () => {
    let admission: Promise<RuntimeAdmission> | undefined;
    const h = await harness((activity) => {
      if (activity.kind === 'assistant.message' && activity.text === 'admit B now') {
        admission = h.runtime.submit({ text: 'B' });
      }
    });
    h.emit(assistant('admit B now'), { type: 'result', subtype: 'success', result: 'background answer' });
    // Activity delivery called submit synchronously; the native write awaits the session.
    expect(h.writes).toHaveLength(1);
    const accepted = await admission;
    if (accepted?.status !== 'submitted') throw new Error('expected B admission');
    const settled = vi.fn();
    void accepted.submission.settled.then(settled);
    await tick();
    expect(h.writes).toHaveLength(2);
    expect(settled).not.toHaveBeenCalled();
    h.lifecycle(h.writes[1]!.uuid, 'queued');
    h.lifecycle(h.writes[1]!.uuid, 'started');
    h.result('B answer');
    h.lifecycle(h.writes[1]!.uuid, 'completed');
    expect(await h.completion(accepted.submission)).toMatchObject({ resultText: 'B answer' });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it.each(['later', 'queued', 'started'])('settles native failure for the consumed group with another input %s, then clears failed text', async (nextState) => {
    const h = await harness();
    const a = await h.submit('A');
    const aUuid = h.writes[1]!.uuid;
    h.lifecycle(aUuid, 'started');
    h.emit(assistant('failed partial answer'));
    const b = nextState === 'later' ? null : await h.submit('B');
    if (b !== null) h.lifecycle(h.writes[2]!.uuid, nextState);
    if (nextState === 'started') h.lifecycle(h.writes[2]!.uuid, 'cancelled');
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'model_error', errors: ['native model failure'] });
    h.lifecycle(aUuid, 'cancelled');
    const failed = await h.completion(a);
    expect(failed).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: 'native model failure' }) });
    if (nextState === 'started') expect(await h.completion(b!)).toBe(failed);
    const next = nextState === 'queued' ? b! : await h.submit('next input');
    const nextUuid = h.writes.at(-1)!.uuid;
    h.lifecycle(nextUuid, 'started');
    h.result('');
    h.lifecycle(nextUuid, 'completed');
    expect(await h.completion(next)).toEqual({ status: 'completed', resultText: null });
    expect(await h.completion(a)).toBe(failed);
    expect(h.reap).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(['refused', 'discarded'])('retains the running answer when a queued steer is %s', async (state) => {
    const h = await harness();
    const a = await h.submit('A');
    const aUuid = h.writes[1]!.uuid;
    h.lifecycle(aUuid, 'started');
    h.emit(assistant('running answer'));
    const b = await h.submit('B');
    h.lifecycle(h.writes[2]!.uuid, 'queued');
    h.lifecycle(h.writes[2]!.uuid, state);
    h.result('', { user_message_uuid: aUuid });
    h.lifecycle(aUuid, 'completed');
    expect(await h.completion(a)).toEqual({ status: 'completed', resultText: 'running answer' });
    await expect(b.settled).resolves.toMatchObject({ kind: 'failed' });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('reports a failed native end when a background session exits with no pending request', async () => {
    const h = await harness();
    h.activity.length = 0;
    h.emit(assistant('background work'));
    h.exitSession();
    await tick();
    expect(h.activity.filter((event) => event.kind === 'turn.ended')).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'native child exited' }),
    ]);
  });

  it('reports one failed native end and fails the request when its session exits', async () => {
    const h = await harness();
    const a = await h.submit('A');
    h.lifecycle(h.writes[1]!.uuid, 'started');
    h.activity.length = 0;
    h.emit(assistant('running work'));
    h.exitSession();
    await expect(a.settled).resolves.toMatchObject({ kind: 'failed' });
    await tick();
    expect(h.activity.filter((event) => event.kind === 'turn.ended')).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'native child exited' }),
    ]);
  });

  it('reports a background exit before write as failed admission, then resumes for the next input', async () => {
    let admission: Promise<RuntimeAdmission> | undefined;
    const h = await harness((event) => {
      if (event.kind === 'assistant.message' && event.text === 'admit before exit') {
        admission = h.runtime.submit({ text: 'A' });
        h.exitSession();
      }
    });
    h.activity.length = 0;
    h.emit(assistant('admit before exit'));
    expect(h.writes).toHaveLength(1);
    await expect(admission).resolves.toMatchObject({ status: 'failed' });
    expect(h.writes).toHaveLength(1);
    await tick();
    expect(h.activity.filter((event) => event.kind === 'turn.ended')).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'native child exited' }),
    ]);
    const next = await h.submit('next input');
    expect(h.createSession).toHaveBeenCalledTimes(2);
    h.lifecycle(h.writes[1]!.uuid, 'started');
    h.emit({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] });
    h.result('A answer', { user_message_uuid: h.writes[1]!.uuid });
    h.lifecycle(h.writes[1]!.uuid, 'completed');
    expect(await h.completion(next)).toMatchObject({ resultText: 'A answer' });
  });

  it('ignores late native protocol callbacks after stop', async () => {
    const h = await harness();
    h.emit(assistant('background work'));
    await h.runtime.stop();
    const beforeLate = [...h.activity];
    expect(beforeLate.at(-1)).toMatchObject({ kind: 'turn.ended', status: 'interrupted' });
    h.emit(assistant('late background text'));
    h.result('late background result');
    expect(h.activity).toEqual(beforeLate);
  });

  it('reports native success/is_error API failure before cancelled, then answers subsequent input', async () => {
    const h = await harness();
    h.activity.length = 0;
    const a = await h.submit('A');
    const uuid = h.writes[1]!.uuid;
    h.lifecycle(uuid, 'queued');
    h.lifecycle(uuid, 'started');
    // Real CLI 2.1.263 with a controlled HTTP 401 response; identifiers are synthetic.
    const message = 'Failed to authenticate. API Error: 401 Controlled probe authentication failure';
    h.result(message, {
      is_error: true, terminal_reason: 'api_error',
      user_message_uuid: uuid, user_message_uuids: [uuid],
    });
    h.lifecycle(uuid, 'cancelled');
    const failed = await h.completion(a);
    expect(failed).toMatchObject({ status: 'failed', error: expect.objectContaining({ message }) });
    expect(h.activity.filter((event) => event.kind === 'turn.ended'))
      .toEqual([expect.objectContaining({ status: 'failed', reason: message })]);

    const b = await h.submit('B');
    const bUuid = h.writes[2]!.uuid;
    h.lifecycle(bUuid, 'queued');
    h.lifecycle(bUuid, 'started');
    h.result('B answer', { user_message_uuid: bUuid });
    h.lifecycle(bUuid, 'completed');
    expect(await h.completion(b)).toEqual({ status: 'completed', resultText: 'B answer' });
    expect(await h.completion(a)).toBe(failed);
    expect(h.activity.filter((event) => event.kind === 'turn.ended').map((event) => event.status))
      .toEqual(['failed', 'completed']);
    expect(h.reap).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it('reports UUID-less errors and preserves queued work through native failure', async () => {
    const h = await harness();
    h.activity.length = 0;
    const nativeFailure = { type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'model_error', errors: ['native model failure'] };
    h.emit(nativeFailure);
    expect(h.reap).not.toHaveBeenCalled();
    const a = await h.submit('A');
    h.lifecycle(h.writes[1]!.uuid, 'started');
    const b = await h.submit('B');
    h.lifecycle(h.writes[2]!.uuid, 'queued');
    h.emit(assistant('failed partial answer'));
    h.lifecycle(h.writes[1]!.uuid, 'cancelled');
    h.emit(nativeFailure);
    const settled = vi.fn();
    void b.settled.then(settled);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.lifecycle(h.writes[2]!.uuid, 'started');
    h.result('B answer');
    h.lifecycle(h.writes[2]!.uuid, 'completed');
    expect(await h.completion(b)).toMatchObject({ resultText: 'B answer' });
    expect(await h.completion(a)).toMatchObject({
      status: 'failed', error: expect.objectContaining({ message: 'native model failure' }),
    });
    expect(h.activity.filter((event) => event.kind === 'turn.ended').map((event) => event.status))
      .toEqual(['failed', 'failed', 'completed']);
    expect(h.reap).not.toHaveBeenCalled();
  });
});
