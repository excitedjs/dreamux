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

type LifecycleState =
  | 'queued'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'discarded';

/** The legacy `system`-subtype lifecycle shape (older streams, the fixture). */
function commandLifecycleLine(
  commandUuid: string,
  state: LifecycleState,
): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
  })}\n`;
}

/**
 * The resident CLI's real lifecycle shape: a top-level `type`, one envelope
 * per state transition. Every submitted uuid walks `queued → started →
 * completed | cancelled`, folded commands included — which is why terminality
 * here, not result counting, is the settlement gate.
 */
function lifecycleChunk(
  commandUuid: string,
  ...states: LifecycleState[]
): string {
  return states
    .map(
      (state) =>
        `${JSON.stringify({
          type: 'command_lifecycle',
          command_uuid: commandUuid,
          state,
          uuid: `srv-${state}-${commandUuid}`,
          session_id: 's1',
        })}\n`,
    )
    .join('');
}

/**
 * What a `priority: 'now'` interrupt leaves behind: an error result with
 * neither a `result` key nor a `user_message_uuid`. It is an artifact of the
 * cancelled command, not an answer, so it must not settle a turn on its own.
 */
function interruptArtifactLine(): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    session_id: 's1',
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

  it('rejects at once when no command ever ran, without waiting on the idle reap', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);
    const rejection = expect(turn).rejects.toThrow(
      /without running any of its commands.*cancelled/u,
    );

    // The turn's only command is cancelled and never ran, so no `result` can
    // arrive. Nothing can answer this turn: fail on the cancellation itself.
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

  it('fails a multi-command turn only once the last unrun command is terminal', async () => {
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
      /without running any of its commands.*discarded/u,
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

  it('keeps waiting when a command completed but its result has not arrived yet', async () => {
    const stdin = new FakeStdin();
    const reap = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 1_000,
      reapOnTimeout: reap,
    });

    const turn = rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());

    // Terminal lifecycle states are observed both before and after the result
    // they belong to, so "every command terminal" alone must NOT be read as
    // "no result is coming" — that would reject a turn whose answer is in the
    // next flush.
    rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    let settled = false;
    void turn.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    rpc.onStdoutChunk(resultLine('late but real', commandUuid));
    await expect(turn).resolves.toMatchObject({ text: 'late but real' });
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

    rpc.onStdoutChunk(resultLine('first steer result', firstSteerUuid));
    rpc.onStdoutChunk(commandLifecycleLine(firstSteerUuid, 'completed'));
    await Promise.resolve();
    expect(turnSettled).toBe(false);
    rpc.onStdoutChunk(resultLine('final steer result', secondSteerUuid));
    rpc.onStdoutChunk(commandLifecycleLine(secondSteerUuid, 'completed'));

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

    rpc.onStdoutChunk(resultLine('second result', secondUuid));
    rpc.onStdoutChunk(commandLifecycleLine(secondUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('third result', steerUuid));
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
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

    // No `msg_lifecycle_v1`, so no `command_lifecycle` will ever arrive: the
    // result is the only terminal signal this build has, and the turn settles
    // on it (the one degrade path).
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

    rpc.onStdoutChunk(resultLine('initial', initialUuid));
    rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'completed'));
    rpc.onStdoutChunk(resultLine('done', steerUuid));
    rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
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

  it('settles a fold of three commands answered by ONE result, at the last completed', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('second', { priority: 'next' });
    await rpc.steerTurn('third');
    const secondUuid = writtenCommandUuid(stdin, 1);
    const thirdUuid = writtenCommandUuid(stdin, 2);

    const settlements: string[] = [];
    void turn.then(
      (outcome) => settlements.push(`resolved:${outcome.text}`),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // The probed fold: messages queued while the in-flight turn is inside a
    // tool call are absorbed at the next query-loop boundary, answered
    // together, and produce ONE result. The folded uuids are never named by
    // any result — counting results per submitted uuid deadlocks here.
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'queued', 'started'));
    await macrotask();
    rpc.onStdoutChunk(lifecycleChunk(secondUuid, 'queued'));
    rpc.onStdoutChunk(lifecycleChunk(thirdUuid, 'queued'));
    rpc.onStdoutChunk(
      lifecycleChunk(secondUuid, 'started') + lifecycleChunk(thirdUuid, 'started'),
    );
    await macrotask();

    rpc.onStdoutChunk(lifecycleChunk(secondUuid, 'completed'));
    rpc.onStdoutChunk(lifecycleChunk(thirdUuid, 'completed'));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(resultLine('one answer for all three', initialUuid));
    await macrotask();
    // Two of three commands are terminal and the turn's only result is in:
    // still not done, because the host command has not gone terminal yet.
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await expect(turn).resolves.toMatchObject({
      text: 'one answer for all three',
      isError: false,
    });
    await macrotask();
    expect(settlements).toEqual(['resolved:one answer for all three']);
  });

  it('settles unfolded commands on the last one, not the first result', async () => {
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

    const settlements: string[] = [];
    void turn.then(
      (outcome) => settlements.push(`resolved:${outcome.text}`),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // A command that lands between turns runs on its own and gets its own
    // result, seconds apart from the next one and in a separate flush.
    rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    await macrotask();
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'started'));
    rpc.onStdoutChunk(resultLine('steer result', steerUuid));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await expect(turn).resolves.toMatchObject({ text: 'steer result' });
    await macrotask();
    expect(settlements).toEqual(['resolved:steer result']);
  });

  it('settles a fold whose result lands before the folded commands complete', async () => {
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

    const settlements: string[] = [];
    void turn.then(
      (outcome) => settlements.push(`resolved:${outcome.text}`),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // Lifecycle/result ordering flips between scenarios: here the fold's
    // single result arrives BEFORE the folded commands go terminal. The gate
    // must depend on eventual arrival only, never on order — and the result
    // carries the later, steered uuid rather than the first-submitted one.
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(resultLine('folded answer', steerUuid));
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await expect(turn).resolves.toMatchObject({ text: 'folded answer' });
    await macrotask();
    expect(settlements).toEqual(['resolved:folded answer']);
  });

  it('does not settle on the artifact result a priority interrupt produces', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    await rpc.steerTurn('interrupt', { priority: 'now' });
    const steerUuid = writtenCommandUuid(stdin, 1);

    const settlements: string[] = [];
    void turn.then(
      (outcome) => settlements.push(`resolved:${outcome.text}`),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // `priority: 'now'` genuinely interrupts: the running command is cancelled
    // and the CLI emits an `error_during_execution` envelope with neither a
    // `result` key nor a `user_message_uuid`. That artifact must not settle
    // the turn — the interrupting command's real answer is still coming.
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'cancelled'));
    rpc.onStdoutChunk(interruptArtifactLine());
    await macrotask();
    expect(settlements).toEqual([]);

    rpc.onStdoutChunk(resultLine('interrupting answer', steerUuid));
    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await expect(turn).resolves.toMatchObject({
      text: 'interrupting answer',
      isError: false,
    });
    await macrotask();
    expect(settlements).toEqual(['resolved:interrupting answer']);
  });

  it('does not let a settled turn\'s late result settle the next turn', async () => {
    const stdin = new FakeStdin();
    const log = vi.fn();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      log,
    });

    // Turn A settles.
    const turnA = rpc.submitTurn('a');
    const uuidA = writtenCommandUuid(stdin, 0);
    rpc.onStdoutChunk(initLine());
    rpc.onStdoutChunk(resultLine('a result', uuidA));
    rpc.onStdoutChunk(lifecycleChunk(uuidA, 'completed'));
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
    rpc.onStdoutChunk(lifecycleChunk(uuidB, 'completed'));
    await expect(turnB).resolves.toMatchObject({ text: 'b result' });
  });

  it('settles on the first result when the build has no lifecycle signal', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('go');
    // No `msg_lifecycle_v1`: no `command_lifecycle` envelope will ever arrive,
    // so waiting for lifecycle terminality would hang forever. The result is
    // the only terminal event such a build has.
    rpc.onStdoutChunk(initLine([]));
    rpc.onStdoutChunk(resultLine('done'));

    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
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

    // A discarded command never produces anything further, so it is terminal
    // and the turn stops waiting on it — but it must not fail the turn: the
    // command that did run still answers it normally.
    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'discarded'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(steerUuid));

    rpc.onStdoutChunk(resultLine('done', initialUuid));
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));

    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
  });

  it('settles as soon as the last outstanding command is discarded', async () => {
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

    // The initial command runs and answers; the turn then waits only on the
    // steer, which the CLI discards. That empties the outstanding set, so the
    // turn settles right there with what did arrive.
    rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await macrotask();
    rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'discarded'));

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
