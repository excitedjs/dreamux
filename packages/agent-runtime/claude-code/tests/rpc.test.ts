/**
 * Focused unit tests for the claude-code turn RPC's idle/inactivity deadline
 * (issue #156). `turn_timeout_ms` is a *max-idle* window, not a total-turn cap:
 *
 *  - a turn that keeps emitting stream lines past the window must NOT be reaped
 *    (the deadline resets on every inbound line); and
 *  - a turn whose still-alive child goes silent for the whole window IS reaped
 *    (preserving the #120 anti-hang intent — a truly wedged child is idle).
 *
 * These drive `ClaudeCodeStreamRpc` directly over a fake stdin + a fake clock,
 * so they are deterministic (no real `claude`, no wall-clock races).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';

import {
  ClaudeCodeStreamRpc,
  ClaudeSteerAdmissionError,
} from '../src/rpc.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimal Writable stub: records writes, reports writable, fires the cb. */
class FakeStdin {
  writable = true;
  readonly writes: string[] = [];
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(chunk);
    cb?.(null);
    return true;
  }
}

class DeferredSteerStdin extends FakeStdin {
  private steerCallback: ((err?: Error | null) => void) | null = null;

  override write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(chunk);
    if (this.writes.length === 1) cb?.(null);
    else this.steerCallback = cb ?? null;
    return true;
  }

  finishSteer(error?: Error): void {
    const callback = this.steerCallback;
    this.steerCallback = null;
    callback?.(error ?? null);
  }
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    session_id: 's1',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * A terminal `result` envelope. `userMessageUuid` is the CLI's
 * `result.user_message_uuid` — the client-supplied `uuid` of the command this
 * result answers, and the only key that tells the several results of one
 * steered turn apart. Omitting it models an older build that does not emit it.
 */
function resultLine(text = 'final', userMessageUuid?: string): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: 's1',
    ...(userMessageUuid === undefined
      ? {}
      : { user_message_uuid: userMessageUuid }),
  })}\n`;
}

/** Let the event loop turn, so any premature settlement would already have fired. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function initLine(capabilities: string[] = ['msg_lifecycle_v1']): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    capabilities,
  })}\n`;
}

function commandLifecycleLine(
  commandUuid: string,
  state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded',
): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
  })}\n`;
}

function writtenCommandUuid(stdin: FakeStdin, index: number): string {
  const envelope = JSON.parse(stdin.writes[index] ?? '{}') as { uuid?: unknown };
  if (typeof envelope.uuid !== 'string') throw new Error('missing command uuid');
  return envelope.uuid;
}

function writtenPrompt(stdin: FakeStdin, index: number): string {
  const envelope = JSON.parse(stdin.writes[index] ?? '{}') as {
    message?: { content?: Array<{ text?: unknown }> };
  };
  const text = envelope.message?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('missing command prompt');
  return text;
}

describe('ClaudeCodeStreamRpc idle deadline (issue #156)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT reap a turn that keeps streaming past the window (resets each line)', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);

    // Emit a stream line every 800ms — each under the 1000ms idle window — for
    // a total of 4000ms, far longer than the window. Continuous activity keeps
    // resetting the deadline, so it must never fire.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      rpc.onStdoutChunk(assistantLine(`step ${i}`));
    }
    expect(reap).not.toHaveBeenCalled();

    // The terminal result settles the turn (and clears the timer).
    rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('final', commandUuid));
    const outcome = await turn;
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toBe('final');
    expect(reap).not.toHaveBeenCalled();
  });

  it('reaps a turn whose child goes silent for the whole window', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const rejection = expect(turn).rejects.toThrow(/stalled|no stream activity/i);

    // No stream activity for the full window → the idle deadline fires.
    vi.advanceTimersByTime(1_000);
    await rejection;
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('releases a pre-init live steer when the active turn times out', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const steer = rpc.steerTurn('follow up');
    const turnRejection = expect(turn).rejects.toThrow(/no stream activity/u);
    const steerRejection = expect(steer).rejects.toThrow(/no stream activity/u);
    expect(stdin.writes).toHaveLength(1);

    vi.advanceTimersByTime(1_000);

    await turnRejection;
    await steerRejection;
    expect(stdin.writes).toHaveLength(1);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('reaps after the window when activity stops mid-turn (idle from the last line)', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const rejection = expect(turn).rejects.toThrow(/stalled|no stream activity/i);

    // Some early activity, then silence. The deadline is measured from the last
    // line, so it fires one window after activity ceases — not from submit.
    vi.advanceTimersByTime(900);
    rpc.onStdoutChunk(assistantLine('one'));
    vi.advanceTimersByTime(900); // < window since the reset → still alive
    expect(reap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // crosses the window from the last line
    await rejection;
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the fold empties, without waiting on the idle reap', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);
    const rejection = expect(turn).rejects.toThrow(
      /lost every submitted command.*cancelled/u,
    );

    // The turn's only command is cancelled: no `result` will ever arrive, so
    // nothing can answer this turn. It must fail on the cancellation itself.
    rpc.onStdoutChunk(initLine());
    rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'cancelled'));

    // No clock advanced, so this rejection cannot have come from the deadline.
    await rejection;
    expect(reap).not.toHaveBeenCalled();

    // And the deadline died with the turn: a healthy resident child is never
    // reaped as collateral, however long it stays quiet afterwards.
    vi.advanceTimersByTime(10_000);
    expect(reap).not.toHaveBeenCalled();
  });

  it('fails a multi-command turn once the last of its commands is discarded', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });
    const steerUuid = writtenCommandUuid(stdin, 1);
    const rejection = expect(turn).rejects.toThrow(
      /lost every submitted command.*discarded/u,
    );

    // Losing one of two commands is survivable — the turn waits on the other.
    rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'cancelled'));
    let settled = false;
    const observed = turn.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // Losing the last one is terminal, and the message names that last cause.
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'discarded'));
    await rejection;
    await observed;
    expect(settled).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(reap).not.toHaveBeenCalled();
  });

  it('enables Remote Control with a startup control request and captures the URL', () => {
    const stdin = new FakeStdin();
    const urls: string[] = [];
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: () => {
        /* not used */
      },
      onRemoteControlUrl: (url) => urls.push(url),
    });

    rpc.enableRemoteControl();
    expect(stdin.writes).toHaveLength(1);
    const request = JSON.parse(stdin.writes[0]!) as {
      type: string;
      request_id: string;
      request: { subtype: string; enabled: boolean };
    };
    expect(request).toMatchObject({
      type: 'control_request',
      request: { subtype: 'remote_control', enabled: true },
    });

    rpc.onStdoutChunk(`${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { session_url: 'https://example.invalid/session/fake' },
      },
    })}\n`);
    expect(urls).toEqual(['https://example.invalid/session/fake']);
  });
});

describe('ClaudeCodeStreamRpc active steering', () => {
  it('queues ordered pre-init steers and flushes them synchronously when support is proven', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    const second = rpc.steerTurn('second', { priority: 'next' });
    const third = rpc.steerTurn('third', { priority: 'next' });
    let secondSettled = false;
    let thirdSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    void third.then(
      () => {
        thirdSettled = true;
      },
      () => {
        thirdSettled = true;
      },
    );
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(thirdSettled).toBe(false);
    expect(stdin.writes).toHaveLength(1);

    rpc.onStdoutChunk(
      `${initLine()}${commandLifecycleLine(initialUuid, 'completed')}${resultLine('initial result', initialUuid)}`,
    );
    await Promise.all([second, third]);

    expect(stdin.writes).toHaveLength(3);
    expect([0, 1, 2].map((index) => writtenPrompt(stdin, index))).toEqual([
      'first',
      'second',
      'third',
    ]);
    const firstSteerUuid = writtenCommandUuid(stdin, 1);
    const secondSteerUuid = writtenCommandUuid(stdin, 2);
    expect(new Set([initialUuid, firstSteerUuid, secondSteerUuid]).size).toBe(3);

    let turnSettled = false;
    void turn.finally(() => {
      turnSettled = true;
    });
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    rpc.onStdoutChunk(commandLifecycleLine(firstSteerUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('first steer result', firstSteerUuid));
    rpc.onStdoutChunk(commandLifecycleLine(secondSteerUuid, 'completed'));
    await Promise.resolve();
    expect(turnSettled).toBe(false);
    rpc.onStdoutChunk(resultLine('final steer result', secondSteerUuid));

    await expect(turn).resolves.toMatchObject({
      text: 'final steer result',
      isError: false,
    });
  });

  it('reuses the resident-session capability decision on later turns', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const firstTurn = rpc.submitTurn('first');
    const firstUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    rpc.onStdoutChunk(commandLifecycleLine(firstUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('first result', firstUuid));
    await expect(firstTurn).resolves.toMatchObject({ text: 'first result' });

    const secondTurn = rpc.submitTurn('second');
    const secondUuid = writtenCommandUuid(stdin, 1);
    const steer = rpc.steerTurn('third');
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(3);
    await steer;
    const steerUuid = writtenCommandUuid(stdin, 2);

    rpc.onStdoutChunk(commandLifecycleLine(secondUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('second result', secondUuid));
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('third result', steerUuid));
    await expect(secondTurn).resolves.toMatchObject({ text: 'third result' });
  });

  it('rejects a queued pre-init steer when init proves lifecycle unsupported', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    const steer = rpc.steerTurn('second');
    const rejection = expect(steer).rejects.toThrow(/msg_lifecycle_v1/u);
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(1);

    rpc.onStdoutChunk(initLine([]));
    await rejection;
    expect(stdin.writes).toHaveLength(1);

    // The rejected steer never joined the fold, so the initial command's own
    // result is the whole turn.
    rpc.onStdoutChunk(resultLine('done', initialUuid));
    await expect(turn).resolves.toMatchObject({ text: 'done' });
  });

  it('releases a queued pre-init steer on stop without a late write', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const steer = rpc.steerTurn('second');
    const turnRejection = expect(turn).rejects.toThrow(/stopped mid-turn/u);
    const steerRejection = expect(steer).rejects.toThrow(/stopped mid-turn/u);
    expect(stdin.writes).toHaveLength(1);

    rpc.failPending(new Error('claude resident session stopped mid-turn'));
    await turnRejection;
    await steerRejection;

    rpc.onStdoutChunk(initLine());
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(1);
  });

  it('releases a queued pre-init steer when the initial turn terminalizes first', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    const steer = rpc.steerTurn('second');
    const steerRejection = expect(steer).rejects.toThrow(
      /ended before live-steer capability was decided/u,
    );
    expect(stdin.writes).toHaveLength(1);

    rpc.onStdoutChunk(resultLine('done', initialUuid));

    await expect(turn).resolves.toMatchObject({ text: 'done' });
    await steerRejection;
    expect(stdin.writes).toHaveLength(1);
  });

  it('writes a stream-json user envelope while a turn is pending', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });
    const steerUuid = writtenCommandUuid(stdin, 1);

    expect(stdin.writes).toHaveLength(2);
    expect(JSON.parse(stdin.writes[1] ?? '{}')).toEqual({
      type: 'user',
      uuid: steerUuid,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
      },
      priority: 'next',
    });

    rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('initial', initialUuid));
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('done', steerUuid));
    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
  });

  it('classifies a post-write steer interrupted by stop as ambiguous and ignores its late callback', async () => {
    const stdin = new DeferredSteerStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    rpc.onStdoutChunk(initLine());
    const steer = rpc.steerTurn('second');
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(2);

    const stopped = new Error('stopped while native write was unconfirmed');
    const turnRejection = expect(turn).rejects.toBe(stopped);
    const steerRejection = expect(steer).rejects.toMatchObject({
      name: 'ClaudeSteerAdmissionError',
      admission: 'ambiguous',
    } satisfies Partial<ClaudeSteerAdmissionError>);
    rpc.failPending(stopped);

    await Promise.all([turnRejection, steerRejection]);
    stdin.finishSteer(new Error('late callback'));
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(2);
  });

  it('folds steered results delivered seconds apart into one settlement (last submission wins)', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    const second = rpc.steerTurn('second', { priority: 'next' });
    const third = rpc.steerTurn('third', { priority: 'next' });
    rpc.onStdoutChunk(initLine());
    await Promise.all([second, third]);
    const firstSteerUuid = writtenCommandUuid(stdin, 1);
    const secondSteerUuid = writtenCommandUuid(stdin, 2);

    const settlements: string[] = [];
    void turn.then(
      (outcome) => settlements.push(`resolved:${outcome.text}`),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // A `priority` steer does NOT interrupt the running command: Claude
    // finishes it, answers it, and only then runs the queued steer. Probed
    // against a live 2.1.231 session, the two `result` envelopes arrive ~2.3s
    // apart in *separate* stdout flushes. Each delivery below is therefore its
    // own `onStdoutChunk` call with the event loop turning in between, so a
    // premature settlement would already have fired by the next assertion.
    rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(commandLifecycleLine(firstSteerUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('first steer result', firstSteerUuid));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(commandLifecycleLine(secondSteerUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('final steer result', secondSteerUuid));

    await expect(turn).resolves.toMatchObject({
      text: 'final steer result',
      isError: false,
    });
    // Exactly one settlement, carrying the last submitted command's answer.
    await macrotask();
    expect(settlements).toEqual(['resolved:final steer result']);
  });

  it('does not let a settled turn\'s late result settle the next turn', async () => {
    const stdin = new FakeStdin();
    const log = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      log,
    });

    // Turn A settles on its own result.
    const turnA = rpc.submitTurn('a');
    const uuidA = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    rpc.onStdoutChunk(resultLine('a result', uuidA));
    await expect(turnA).resolves.toMatchObject({ text: 'a result' });

    // Turn B opens in the window before A's trailing traffic has drained.
    const turnB = rpc.submitTurn('b');
    const uuidB = writtenCommandUuid(stdin, 1);
    let settledB = false;
    void turnB.finally(() => {
      settledB = true;
    });

    // A stale result for A must never settle B — B would hand its sender A's
    // answer. It is dropped with a warning instead.
    log.mockClear();
    rpc.onStdoutChunk(resultLine('a stale result', uuidA));
    await macrotask();
    expect(settledB).toBe(false);
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining(uuidA),
    );

    // B still settles on its own result, with its own text.
    rpc.onStdoutChunk(resultLine('b result', uuidB));
    await expect(turnB).resolves.toMatchObject({ text: 'b result' });
  });

  it('settles a result that carries no user_message_uuid (older CLI builds)', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('go');
    rpc.onStdoutChunk(initLine());
    // No attribution key on the wire: the fold cannot be observed, so the
    // result must settle the turn rather than wait for the idle reap.
    rpc.onStdoutChunk(resultLine('done'));

    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
  });

  it('warns that degrading is lossy when a steered turn gets an unattributed result', async () => {
    const stdin = new FakeStdin();
    const log = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      log,
    });

    const turn = rpc.submitTurn('first');
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });

    // Without `user_message_uuid` a steered turn cannot be folded, so it
    // settles on the pre-steer answer. Anti-hang wins over waiting, but the
    // lost steer answer must leave a trace.
    log.mockClear();
    rpc.onStdoutChunk(resultLine('initial result'));
    await expect(turn).resolves.toMatchObject({ text: 'initial result' });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('no user_message_uuid'),
    );
  });

  it('does not hang or reject when a steered command is discarded', async () => {
    const stdin = new FakeStdin();
    const log = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      log,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });
    const steerUuid = writtenCommandUuid(stdin, 1);

    // A discarded command never produces a `result`. It must leave the fold —
    // otherwise the turn waits on it until the 600s idle reap — but it must
    // not reject the turn either: the initial command's result still settles
    // it normally.
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'discarded'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(steerUuid));

    rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('done', initialUuid));

    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
  });

  it('settles immediately when the last outstanding command is discarded', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });
    const steerUuid = writtenCommandUuid(stdin, 1);

    // The initial command answers first and the turn waits on the steer; the
    // steer is then discarded, emptying the outstanding set. The turn settles
    // right there with what did arrive.
    rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    await macrotask();
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'discarded'));

    await expect(turn).resolves.toMatchObject({
      text: 'initial result',
      isError: false,
    });
  });

  it('settles on the result when the resident CLI emits command_lifecycle as a top-level type', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);

    // The resident CLI emits `command_lifecycle` as a top-level `type`
    // ({"type":"command_lifecycle",...}), not as a `system` subtype. The turn
    // must still settle on the `result` envelope regardless of that shape.
    rpc.onStdoutChunk(
      `${JSON.stringify({
        type: 'command_lifecycle',
        command_uuid: commandUuid,
        state: 'completed',
      })}\n`,
    );
    rpc.onStdoutChunk(resultLine('final', commandUuid));

    await expect(turn).resolves.toMatchObject({
      text: 'final',
      isError: false,
    });
  });

  it('logs a warning when a result arrives with no pending turn', async () => {
    const stdin = new FakeStdin();
    const log = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      log,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('first', commandUuid));
    await expect(turn).resolves.toMatchObject({ text: 'first' });

    // A late result (e.g. a steered command draining in a later stdout flush)
    // has no turn to settle; it must be logged, not silently dropped.
    log.mockClear();
    rpc.onStdoutChunk(resultLine('late'));
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('no pending turn'),
    );
  });

  it('fails live steer loudly when command lifecycle is unavailable', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine([]));
    await expect(rpc.steerTurn('second')).rejects.toThrow(/msg_lifecycle_v1/);
    expect(stdin.writes).toHaveLength(1);

    rpc.onStdoutChunk(resultLine('done', initialUuid));
    await expect(turn).resolves.toMatchObject({ text: 'done' });
    expect(initialUuid).toMatch(UUID_RE);
  });
});
