/** Synthetic protocol replays; native ordering evidence is recorded in the task. */
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import type { ClaudeCodeStreamRpcOptions } from '../src/rpc.js';
import type { ClaudeProtocolEvent, CommandLifecycleState } from '../src/types.js';
import type { RuntimeAdmission, RuntimeCompletion, RuntimeSubmission } from '@excitedjs/dreamux-types';

interface Input { uuid: string; message: { content: Array<{ text: string }> } }
type WriteCallback = (error?: Error | null) => void;

function harness(options: Partial<ClaudeCodeStreamRpcOptions> = {}) {
  const writes: Input[] = [];
  const events: ClaudeProtocolEvent[] = [];
  const reap = vi.fn();
  const stdin = {
    writable: true,
    onWrite: (_input: Input, callback: WriteCallback) => callback(),
    write(chunk: string, callback: WriteCallback = () => undefined) {
      const input = JSON.parse(chunk) as Input;
      writes.push(input);
      this.onWrite(input, callback);
      return true;
    },
  };
  const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
    sessionId: 'session', turnTimeoutMs: 1_000, reapOnTimeout: reap,
    onProtocolEvent: (event) => events.push(event), ...options,
  });
  rpcs.push(rpc);
  const emit = (...lines: Record<string, unknown>[]) => {
    rpc.onStdoutChunk(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  };
  const lifecycle = (uuid: string, ...states: CommandLifecycleState[]) => {
    emit(...states.map((state) => ({ type: 'command_lifecycle', command_uuid: uuid, state })));
  };
  const init = (supported = true) => emit({ type: 'system', subtype: 'init', session_id: 'session', capabilities: supported ? ['msg_lifecycle_v1'] : [] });
  const result = (text: string, uuid?: string, extra: Record<string, unknown> = {}) => {
    emit({ type: 'result', subtype: 'success', result: text, user_message_uuid: uuid, ...extra });
  };
  const assistant = (text: string) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const send = (uuid: string) => accepted(rpc.submit(uuid, {}, uuid));
  const results = () => events.filter((event) => event.kind === 'result');
  return { rpc, stdin, writes, events, reap, emit, lifecycle, init, result, assistant, send, results };
}

const rpcs: ClaudeCodeStreamRpc[] = [];
afterEach(() => {
  for (const rpc of rpcs.splice(0)) rpc.stop();
  vi.useRealTimers();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function accepted(admission: Promise<RuntimeAdmission>): Promise<RuntimeSubmission> {
  const value = await admission;
  if (value.status !== 'submitted') throw new Error(`expected submitted, received ${value.status}`);
  return value.submission;
}
async function completion(submission: RuntimeSubmission): Promise<RuntimeCompletion> {
  const settlement = await submission.settled;
  if (settlement.kind !== 'completion') throw new Error(`expected completion, received ${settlement.kind}`);
  return settlement.completion;
}
const artifact = { type: 'result', subtype: 'error_during_execution' };

describe('resident request admission and settlement', () => {
  it('acknowledges input before its answer, then accepts another input before late completed', async () => {
    const h = harness();
    const a = await h.send('A');
    const settled = vi.fn();
    void a.settled.then(settled);
    h.lifecycle('A', 'started');
    h.init();
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.result('same', 'A');
    const first = await completion(a);
    const b = await h.send('B');
    h.lifecycle('B', 'started');
    h.lifecycle('A', 'completed');
    h.result('same', 'B');
    const second = await completion(b);
    expect(first).toEqual({ status: 'completed', resultText: 'same' });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(h.writes.map((input) => input.uuid)).toEqual(['A', 'B']);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'])('shares one completion for folded inputs with completed %s result', async (order) => {
    const h = harness();
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.init();
    const b = await h.send('B');
    h.lifecycle('B', 'queued', 'started');
    if (order === 'before') {
      h.lifecycle('A', 'completed');
      h.lifecycle('B', 'completed');
    }
    h.result('folded', 'A');
    if (order === 'after') {
      h.lifecycle('A', 'completed');
      h.lifecycle('B', 'completed');
    }
    const [first, second] = await Promise.all([completion(a), completion(b)]);
    expect(first).toEqual({ status: 'completed', resultText: 'folded' });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]!.commandUuids).toEqual(['A', 'B']);
  });

  it.each([{}, { user_message_uuid: 'internal' }, { origin: { kind: 'task-notification' } }])('answers consumed background steers regardless of result metadata %j', async (extra) => {
    const h = harness();
    h.init();
    h.assistant('background answer');
    const b = await h.send('B');
    const c = await h.send('C');
    h.lifecycle('B', 'queued', 'started', 'completed');
    h.lifecycle('C', 'queued', 'started', 'completed');
    h.result('', undefined, extra);
    const [first, second] = await Promise.all([completion(b), completion(c)]);
    expect(first).toEqual({ status: 'completed', resultText: 'background answer' });
    expect(second).toBe(first);
  });

  it('keeps queued input pending across an unrelated background result', async () => {
    const h = harness();
    h.init();
    const b = await h.send('B');
    const settled = vi.fn();
    void b.settled.then(settled);
    h.lifecycle('B', 'queued');
    h.result('background');
    await tick();
    expect(settled).not.toHaveBeenCalled();
    expect(h.results()[0]!.commandUuids).toEqual([]);
    h.lifecycle('B', 'started', 'completed');
    h.result('B answer', 'B');
    expect(await completion(b)).toEqual({ status: 'completed', resultText: 'B answer' });
  });

  it('retains a completed request until its answer arrives, without gating other inputs', async () => {
    const h = harness();
    const a = await h.send('A');
    h.lifecycle('A', 'started', 'completed');
    h.init();
    const settled = vi.fn();
    void a.settled.then(settled);
    const b = await h.send('B');
    h.lifecycle('B', 'queued');
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.result('A answer');
    expect(await completion(a)).toMatchObject({ resultText: 'A answer' });
    h.lifecycle('B', 'started');
    h.result('B answer');
    expect(await completion(b)).toMatchObject({ resultText: 'B answer' });
  });

  it('preserves input order while capability is unknown and flushes on started before init', async () => {
    const h = harness();
    const a = await h.send('A');
    const b = h.send('B');
    const c = h.send('C');
    expect(h.writes.map((input) => input.uuid)).toEqual(['A']);
    h.lifecycle('A', 'started');
    h.init(false);
    await Promise.all([b, c]);
    expect(h.writes.map((input) => input.message.content[0]!.text)).toEqual(['A', 'B', 'C']);
    h.lifecycle('B', 'started');
    h.lifecycle('C', 'started');
    h.result('all');
    const values = await Promise.all([a, await b, await c].map(completion));
    expect(values[1]).toBe(values[0]);
    expect(values[2]).toBe(values[0]);
  });

  it('accepts an immediate native result before the write callback and ignores its late error', async () => {
    const h = harness();
    let callback!: WriteCallback;
    h.stdin.onWrite = (input, cb) => {
      callback = cb;
      h.lifecycle(input.uuid, 'started');
      h.result('early');
    };
    const a = await h.send('A');
    expect(await completion(a)).toMatchObject({ resultText: 'early' });
    callback(new Error('late write failure'));
    expect(await completion(a)).toMatchObject({ resultText: 'early' });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('treats native consumption as admission even if the write callback later fails', async () => {
    const h = harness();
    let callback!: WriteCallback;
    h.stdin.onWrite = (input, cb) => {
      callback = cb;
      h.lifecycle(input.uuid, 'started');
    };
    const a = await h.send('A');
    callback(new Error('late write error'));
    h.result('accepted natively');
    expect(await completion(a)).toMatchObject({ resultText: 'accepted natively' });
  });

  it('does not flush remaining unwritten requests when a write callback stops the session', async () => {
    const h = harness();
    const a = await h.send('A');
    const b = h.rpc.submit('B');
    const c = h.rpc.submit('C');
    h.stdin.onWrite = (_input, callback) => {
      callback();
      h.rpc.stop();
    };
    h.lifecycle('A', 'started');
    const acceptedB = await accepted(b);
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    await expect(acceptedB.settled).resolves.toEqual({ kind: 'stopped' });
    await expect(c).resolves.toEqual({ status: 'stopped' });
    expect(h.writes.map((input) => input.message.content[0]!.text)).toEqual(['A', 'B']);
  });

  it('preserves write order when an early callback submits input during capability release', async () => {
    const h = harness();
    const a = await h.send('A');
    const b = h.send('B');
    const c = h.send('C');
    let d!: Promise<RuntimeSubmission>;
    h.stdin.onWrite = (input, callback) => {
      if (input.uuid === 'B') d = h.send('D');
      callback();
    };
    h.lifecycle('A', 'started');
    const requests = [a, await b, await c, await d];
    expect(h.writes.map((input) => input.uuid)).toEqual(['A', 'B', 'C', 'D']);
    h.lifecycle('B', 'started');
    h.lifecycle('C', 'started');
    h.lifecycle('D', 'started');
    h.result('all answered');
    const answers = await Promise.all(requests.map(completion));
    expect(answers[0]).toEqual({ status: 'completed', resultText: 'all answered' });
    for (const answer of answers) expect(answer).toBe(answers[0]);
  });

  it('lets a result callback submit the next request without attributing the previous answer to it', async () => {
    let next!: Promise<RuntimeSubmission>;
    const h = harness({
      onProtocolEvent: (event) => {
        if (event.kind === 'result' && event.outcome.text === 'A answer') next = h.send('B');
      }
    });
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.result('A answer');
    const b = await next;
    const settled = vi.fn();
    void b.settled.then(settled);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    h.lifecycle('B', 'started');
    h.result('B answer');
    expect(await completion(a)).toMatchObject({ resultText: 'A answer' });
    expect(await completion(b)).toMatchObject({ resultText: 'B answer' });
  });

  it('preserves an observed result when its callback stops the session', async () => {
    const h = harness({ onProtocolEvent: (event) => { if (event.kind === 'result') h.rpc.stop(); } });
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.result('observed');
    expect(await completion(a)).toMatchObject({ resultText: 'observed' });
  });
});

describe('supported compatibility inputs', () => {
  it.each(['queued', 'refused', 'discarded'] as const)('answers a no-start matching UUID independently of B being %s', async (state) => {
    const h = harness();
    const a = await h.send('A');
    h.init();
    const b = await h.send('B');
    h.lifecycle('B', state);
    h.result('A answer', 'A');
    expect(await completion(a)).toMatchObject({ resultText: 'A answer' });
    if (state === 'queued') {
      const settled = vi.fn();
      void b.settled.then(settled);
      await tick();
      expect(settled).not.toHaveBeenCalled();
      h.lifecycle('B', 'started');
      h.result('B answer', 'B');
      expect(await completion(b)).toMatchObject({ resultText: 'B answer' });
    } else await expect(b.settled).resolves.toMatchObject({ kind: 'failed' });
  });

  it('combines a no-start matching UUID with every started fold member', async () => {
    const h = harness();
    const a = await h.send('A');
    h.init();
    const b = await h.send('B');
    h.lifecycle('B', 'started', 'completed');
    h.result('both', 'A');
    expect(await completion(b)).toBe(await completion(a));
  });

  it('rejects unwritten concurrent input when capability is absent, then supports subsequent single input', async () => {
    const h = harness();
    const a = await h.send('A');
    const b = h.rpc.submit('B');
    h.init(false);
    await expect(b).resolves.toMatchObject({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('msg_lifecycle_v1') }) });
    h.result('legacy');
    expect(await completion(a)).toMatchObject({ resultText: 'legacy' });
    const c = await h.send('C');
    h.result('later');
    expect(await completion(c)).toMatchObject({ resultText: 'later' });
    expect(h.writes.map((input) => input.uuid)).toEqual(['A', 'C']);
  });

  it('releases unwritten input when the first matching result arrives before capability is decided', async () => {
    const h = harness();
    const a = await h.send('A');
    const b = h.rpc.submit('B');
    h.result('A', 'A');
    expect(await completion(a)).toMatchObject({ resultText: 'A' });
    await expect(b).resolves.toMatchObject({ status: 'failed' });
    expect(h.writes).toHaveLength(1);
  });

  it.each([true, false])('never uses a foreign UUID as sole-request fallback with lifecycle=%s', async (supported) => {
    const h = harness();
    h.init(supported);
    const a = await h.send('A');
    const settled = vi.fn();
    void a.settled.then(settled);
    h.result('foreign', 'internal');
    await tick();
    expect(settled).not.toHaveBeenCalled();
    if (supported) {
      h.result('unbound');
      await tick();
      expect(settled).not.toHaveBeenCalled();
    }
    h.result('actual', supported ? 'A' : undefined);
    expect(await completion(a)).toMatchObject({ resultText: 'actual' });
  });

  it('uses the older system-subtype lifecycle as consumption evidence', async () => {
    const h = harness();
    const a = await h.send('A');
    h.emit({ type: 'system', subtype: 'command_lifecycle', command_uuid: 'A', state: 'started' });
    h.result('answer');
    expect(await completion(a)).toMatchObject({ resultText: 'answer' });
  });
});

describe('cancellation and transport lifetime', () => {
  it('cancels only the queued request and retains the generating answer', async () => {
    const h = harness();
    h.init();
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.assistant('running answer');
    const b = await h.send('B');
    h.lifecycle('B', 'queued', 'cancelled');
    await expect(b.settled).resolves.toEqual({ kind: 'stopped' });
    expect(h.events.some((event) => event.kind === 'interrupted')).toBe(false);
    h.result('', 'A');
    expect(await completion(a)).toMatchObject({ resultText: 'running answer' });
  });

  it.each(['before', 'after', 'absent'])('discards cancelled native text with interrupt artifact %s cancellation, preserving queued work', async (order) => {
    const h = harness();
    h.init();
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.assistant('cancelled text');
    const b = await h.send('B');
    h.lifecycle('B', 'queued');
    if (order === 'before') h.emit(artifact);
    h.lifecycle('A', 'cancelled');
    if (order === 'after') h.emit(artifact);
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    h.lifecycle('B', 'started');
    h.result('');
    expect(await completion(b)).toEqual({ status: 'completed', resultText: null });
    expect(h.events.filter((event) => event.kind === 'interrupted')).toHaveLength(1);
    expect(h.results()).toHaveLength(1);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('retains other consumed fold members when one request is cancelled', async () => {
    const h = harness();
    h.init();
    const a = await h.send('A');
    const b = await h.send('B');
    h.lifecycle('A', 'started');
    h.lifecycle('B', 'started');
    h.assistant('cancelled text');
    h.lifecycle('A', 'cancelled');
    h.result('B answer');
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    expect(await completion(b)).toMatchObject({ resultText: 'B answer' });
  });

  it('discards cancelled internal native text without maintaining an explicit request for it', async () => {
    const h = harness();
    h.lifecycle('internal', 'started');
    h.assistant('cancelled');
    h.lifecycle('internal', 'cancelled');
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.result('');
    expect(await completion(a)).toEqual({ status: 'completed', resultText: null });
  });

  it('fails every outstanding request on child loss and settles no completion', async () => {
    const h = harness();
    h.init();
    const a = await h.send('A');
    const b = await h.send('B');
    h.lifecycle('A', 'started');
    h.lifecycle('B', 'queued');
    const error = new Error('child exited');
    h.rpc.fail(error);
    await expect(a.settled).resolves.toEqual({ kind: 'failed', error });
    await expect(b.settled).resolves.toEqual({ kind: 'failed', error });
    expect(h.results()).toEqual([]);
  });

  it('stops accepted requests and suppresses late native callbacks', async () => {
    const h = harness();
    h.init();
    const a = await h.send('A');
    h.rpc.stop();
    const events = [...h.events];
    h.assistant('late');
    h.result('late', 'A');
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    expect(h.events).toEqual(events);
  });

  it('emits no further protocol callback when a lifecycle observer stops the session', async () => {
    const events: ClaudeProtocolEvent[] = [];
    const h = harness({ onProtocolEvent: (event) => {
      events.push(event);
      if (event.kind === 'command_lifecycle' && event.state === 'cancelled') h.rpc.stop();
    } });
    const a = await h.send('A');
    h.lifecycle('A', 'started', 'cancelled', 'completed');
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    expect(events).toEqual([
      { kind: 'command_lifecycle', commandUuid: 'A', state: 'started' },
      { kind: 'command_lifecycle', commandUuid: 'A', state: 'cancelled' },
    ]);
  });

  it.each(['stop', 'fail'] as const)('classifies unconfirmed native writes as ambiguous on %s', async (action) => {
    const h = harness();
    let callback!: WriteCallback;
    h.stdin.onWrite = (_input, cb) => { callback = cb; };
    const a = h.rpc.submit('A');
    const b = h.rpc.submit('B'); // Not written: capability remains unknown.
    if (action === 'stop') h.rpc.stop(); else h.rpc.fail(new Error('lost transport'));
    await expect(a).resolves.toMatchObject({ status: 'ambiguous' });
    await expect(b).resolves.toMatchObject({ status: action === 'stop' ? 'stopped' : 'failed' });
    callback();
    expect(h.writes).toHaveLength(1);
  });

  it.each(['throw', 'callback'])('reports an ambiguous native write failure through %s', async (mode) => {
    const h = harness();
    h.stdin.onWrite = (_input, callback) => {
      const error = new Error('write failed');
      if (mode === 'throw') throw error; else callback(error);
    };
    await expect(h.rpc.submit('A')).resolves.toMatchObject({ status: 'ambiguous' });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('reports a proven failure before writing to an unavailable child', async () => {
    const h = harness();
    h.stdin.writable = false;
    await expect(h.rpc.submit('A')).resolves.toMatchObject({ status: 'failed' });
    expect(h.writes).toHaveLength(0);
  });
});

describe('idle policy and result contract', () => {
  it('reaps genuinely silent outstanding requests, including queued input', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.init();
    const a = await h.send('A');
    const b = await h.send('B');
    h.lifecycle('B', 'queued');
    vi.advanceTimersByTime(1_000);
    await expect(a.settled).resolves.toMatchObject({ kind: 'failed' });
    await expect(b.settled).resolves.toMatchObject({ kind: 'failed' });
    expect(h.reap).toHaveBeenCalledTimes(1);
  });

  it('resets idle time on every native line and clears it as soon as requests are answered', async () => {
    vi.useFakeTimers();
    const h = harness();
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(800);
      h.assistant('working');
    }
    expect(h.reap).not.toHaveBeenCalled();
    h.result('done');
    await completion(a);
    // No completed frame is needed to release the request's deadline.
    vi.advanceTimersByTime(10_000);
    h.assistant('background');
    h.result('background');
    vi.advanceTimersByTime(10_000);
    expect(h.reap).not.toHaveBeenCalled();
    expect(h.results()[1]!.commandUuids).toEqual([]);
  });

  it.each([
    { extra: { session_id: 'foreign' }, schema: false, message: 'pinned native session' },
    { extra: {}, schema: true, message: 'structured_output' },
    { extra: { subtype: 'error_during_execution', errors: ['model failure'] }, schema: false, message: 'model failure' },
  ])('fails completion for a violated result contract %j', async ({ extra, schema, message }) => {
    const h = harness({ outputSchemaEnabled: schema });
    const a = await h.send('A');
    h.lifecycle('A', 'started');
    h.result('answer', 'A', extra);
    expect(await completion(a)).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining(message) }) });
  });

  it('preserves structured null as a successful JSON result', async () => {
    const h = harness({ outputSchemaEnabled: true });
    const a = await h.send('A');
    h.result('unused', 'A', { structured_output: null });
    expect(await completion(a)).toEqual({ status: 'completed', resultText: 'null' });
  });

  it('keeps Remote Control and tool permission replies independent of requests', () => {
    const urls: string[] = [];
    const h = harness({ onRemoteControlUrl: (url) => urls.push(url) });
    h.rpc.enableRemoteControl();
    const request = h.writes[0] as unknown as { request_id: string };
    h.emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { session_url: 'https://example.invalid/session' } } });
    h.emit({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', input: { command: 'pwd' } } });
    expect(urls).toEqual(['https://example.invalid/session']);
    expect(h.writes[1]).toMatchObject({ type: 'control_response', response: { request_id: 'permission', response: { behavior: 'allow', updatedInput: { command: 'pwd' } } } });
    expect(h.results()).toEqual([]);
  });
});
