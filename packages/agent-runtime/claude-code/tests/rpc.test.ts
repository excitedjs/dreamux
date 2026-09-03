/**
 * Unit tests for the claude-code stream-json turn RPC.
 *
 * Two contracts are exercised here, both driven purely by replayed NATIVE
 * protocol lines (no live `claude`, fake stdin, fake clock):
 *
 *  - **The idle/inactivity deadline (issue #156).** `turnTimeoutMs` is a
 *    *max-idle* window, not a total-turn cap: a turn that keeps emitting stream
 *    lines past the window must NOT be reaped, while a still-alive child that
 *    goes silent for the whole window IS reaped.
 *
 *  - **Native completion boundaries.** `submitTurn` no longer resolves *with* a
 *    result: it resolves `void` once the resident command group has drained.
 *    Every valid native `result` envelope is forwarded, as it arrives, through
 *    `onProtocolEvent` as its own `{ kind: 'result' }` boundary. Downstream that
 *    boundary is what mints exactly one completion token, so the assertions
 *    below are about *how many* boundaries a native line sequence produces, in
 *    what order, and whether two boundaries are the same object.
 *
 * Fold vs. queue is expressed here only in native terms — which command uuids
 * are in the `started` set when a `result` lands — and never as an input that
 * pre-declares the expected number of completions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';

import {
  ClaudeCodeStreamRpc,
  ClaudeSteerAdmissionError,
} from '../src/rpc.js';
import type { ClaudeProtocolEvent, TurnOutcome } from '../src/types.js';

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

interface Harness {
  readonly stdin: FakeStdin;
  readonly rpc: ClaudeCodeStreamRpc;
  /** Every protocol event the RPC forwarded, in emission order. */
  readonly events: ClaudeProtocolEvent[];
  readonly reap: ReturnType<typeof vi.fn>;
  /** The native completion boundaries forwarded so far, in native order. */
  results(): TurnOutcome[];
  /** `uuid:state` for every forwarded lifecycle fact, in native order. */
  lifecycle(): string[];
  /** The coarse kind of every forwarded event, in emission order. */
  kinds(): string[];
  /**
   * One printable token per forwarded event, in emission order:
   * `result:<text>` for a native completion boundary, `<uuid>:<state>` for a
   * lifecycle fact, `stream` for live activity. Used where the contract is
   * about the *interleaving* of boundaries and lifecycle facts, so a folding
   * or reordering implementation produces a different sequence.
   */
  trace(): string[];
}

function createHarness(
  init: {
    turnTimeoutMs?: number;
    stdin?: FakeStdin;
    onRemoteControlUrl?: (url: string) => void;
    log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
  } = {},
): Harness {
  const stdin = init.stdin ?? new FakeStdin();
  const events: ClaudeProtocolEvent[] = [];
  const reap = vi.fn();
  const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
    turnTimeoutMs: init.turnTimeoutMs ?? 5_000,
    reapOnTimeout: reap,
    onRemoteControlUrl: init.onRemoteControlUrl,
    log: init.log,
    onProtocolEvent: (event) => {
      events.push(event);
    },
  });
  return {
    stdin,
    rpc,
    events,
    reap,
    results: () =>
      events.flatMap((event) => (event.kind === 'result' ? [event.outcome] : [])),
    lifecycle: () =>
      events.flatMap((event) =>
        event.kind === 'command_lifecycle'
          ? [`${event.commandUuid}:${event.state}`]
          : [],
      ),
    kinds: () => events.map((event) => event.kind),
    trace: () =>
      events.map((event) => {
        if (event.kind === 'result') return `result:${event.outcome.text}`;
        if (event.kind === 'command_lifecycle') {
          return `${event.commandUuid}:${event.state}`;
        }
        return 'stream';
      }),
  };
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
 * `result.user_message_uuid` — an optional attribution hint for the command
 * this result answers. Omitting it models a build that does not emit it.
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
  | 'discarded'
  | 'refused';

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
 * here, not result counting, is the drainage gate.
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
 * What an interrupt leaves behind: an error result with
 * neither a `result` key nor a `user_message_uuid`. It is an artifact of the
 * cancelled command, not an answer, so it is not a native completion boundary.
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

  it('keeps streaming past the idle window without a reap, and forwards every native line before the terminal result', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);

    // Emit a stream line every 800ms — each under the 1000ms idle window — for
    // a total of 4000ms, far longer than the window. Continuous activity keeps
    // resetting the deadline, so it must never fire.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      h.rpc.onStdoutChunk(assistantLine(`step ${i}`));
    }
    expect(h.reap).not.toHaveBeenCalled();
    // Live activity is pushed as it arrives, ahead of any terminal result.
    expect(h.kinds()).toEqual(['stream', 'stream', 'stream', 'stream', 'stream']);
    expect(h.results()).toEqual([]);

    // The terminal result is the single native completion boundary, and it is
    // forwarded strictly after the live stream lines.
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    h.rpc.onStdoutChunk(resultLine('final', commandUuid));
    await turn;
    expect(h.kinds().at(-1)).toBe('result');
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ isError: false, text: 'final' });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('reaps a turn whose child emits no native line for the whole window', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const rejection = expect(turn).rejects.toThrow(/stalled|no stream activity/i);

    // No stream activity for the full window → the idle deadline fires.
    vi.advanceTimersByTime(1_000);
    await rejection;
    expect(h.reap).toHaveBeenCalledTimes(1);
    expect(h.results()).toEqual([]);
  });

  it('releases a pre-init live steer with the stall error when the idle deadline fires', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const steer = h.rpc.steerTurn('follow up');
    const turnRejection = expect(turn).rejects.toThrow(/no stream activity/u);
    const steerRejection = expect(steer).rejects.toThrow(/no stream activity/u);
    expect(h.stdin.writes).toHaveLength(1);

    vi.advanceTimersByTime(1_000);

    await turnRejection;
    await steerRejection;
    expect(h.stdin.writes).toHaveLength(1);
    expect(h.reap).toHaveBeenCalledTimes(1);
    expect(h.results()).toEqual([]);
  });

  it('measures the idle window from the last native line, not from submit', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const rejection = expect(turn).rejects.toThrow(/stalled|no stream activity/i);

    // Some early activity, then silence. The deadline is measured from the last
    // line, so it fires one window after activity ceases — not from submit.
    vi.advanceTimersByTime(900);
    h.rpc.onStdoutChunk(assistantLine('one'));
    vi.advanceTimersByTime(900); // < window since the reset → still alive
    expect(h.reap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // crosses the window from the last line
    await rejection;
    expect(h.reap).toHaveBeenCalledTimes(1);
  });

  it('fails promptly when a started command is cancelled without a result, without idle reap', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);
    const rejection = expect(turn).rejects.toThrow(
      /without running any of its commands.*cancelled/u,
    );

    // The command started, then the native protocol proved it cannot produce a
    // result. Cancellation must release the started-since-result gate itself.
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'started'));
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'cancelled'));

    // No clock advanced, so this rejection cannot have come from the deadline.
    await rejection;
    expect(h.reap).not.toHaveBeenCalled();
    // A cancelled command is not a native answer: no completion boundary.
    expect(h.results()).toEqual([]);
    expect(h.lifecycle()).toEqual([
      `${commandUuid}:started`,
      `${commandUuid}:cancelled`,
    ]);

    // And the deadline died with the turn: a healthy resident child is never
    // reaped as collateral, however long it stays quiet afterwards.
    vi.advanceTimersByTime(10_000);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('enables Remote Control with a native control_request and captures the URL from the control_response', () => {
    const urls: string[] = [];
    const h = createHarness({
      turnTimeoutMs: 1_000,
      onRemoteControlUrl: (url) => urls.push(url),
    });

    h.rpc.enableRemoteControl();
    expect(h.stdin.writes).toHaveLength(1);
    const request = JSON.parse(h.stdin.writes[0]!) as {
      type: string;
      request_id: string;
      request: { subtype: string; enabled: boolean };
    };
    expect(request).toMatchObject({
      type: 'control_request',
      request: { subtype: 'remote_control', enabled: true },
    });

    h.rpc.onStdoutChunk(`${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: { session_url: 'https://example.invalid/session/fake' },
      },
    })}\n`);
    expect(urls).toEqual(['https://example.invalid/session/fake']);
  });

  it('fails a multi-command turn only once the last unrun command is terminal', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);
    const rejection = expect(turn).rejects.toThrow(
      /without running any of its commands.*discarded/u,
    );

    // Losing one of two commands is survivable — the window waits on the other.
    h.rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'cancelled'));
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
    h.rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'discarded'));
    await rejection;
    await observed;
    expect(settled).toBe(true);
    // Nothing ever answered, so no native completion boundary was minted.
    expect(h.results()).toEqual([]);
    expect(h.lifecycle()).toEqual([
      `${initialUuid}:cancelled`,
      `${steerUuid}:discarded`,
    ]);
    // The failure came from lifecycle terminality, not the idle deadline, and
    // the deadline died with the turn.
    vi.advanceTimersByTime(10_000);
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('keeps a started command gated when completed arrives before its result', async () => {
    const h = createHarness({ turnTimeoutMs: 1_000 });
    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());

    // Terminal lifecycle states are observed both before and after the result
    // they belong to, so "every command terminal" alone must NOT be read as
    // "no result is coming" — that would fail a window whose answer is in the
    // next flush, and would drop a real native completion boundary.
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'started'));
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    let settled = false;
    void turn.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.results()).toEqual([]);

    h.rpc.onStdoutChunk(resultLine('late but real', commandUuid));
    await turn;
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({
      text: 'late but real',
      isError: false,
    });
    expect(h.reap).not.toHaveBeenCalled();
  });
});

describe('ClaudeCodeStreamRpc native completion boundaries', () => {
  it('forwards ONE boundary when two started commands share a single native result', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    // Native fold: BOTH command uuids are in the started set when the single
    // `result` lands, and neither is named by it. That native shape — not any
    // test-supplied expectation — is what must produce one boundary.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'queued', 'started'));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'queued', 'started'));
    h.rpc.onStdoutChunk(resultLine('shared answer'));
    await macrotask();

    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'shared answer', isError: false });

    // The window has not drained yet: both commands still owe a terminal state.
    let drained = false;
    void turn.finally(() => {
      drained = true;
    });
    await macrotask();
    expect(drained).toBe(false);

    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await turn;
    // Still exactly one native completion boundary after drainage.
    expect(h.results()).toHaveLength(1);
    expect(h.lifecycle()).toEqual([
      `${initialUuid}:queued`,
      `${initialUuid}:started`,
      `${steerUuid}:queued`,
      `${steerUuid}:started`,
      `${initialUuid}:completed`,
      `${steerUuid}:completed`,
    ]);
  });

  it('forwards TWO distinct boundaries when each started command gets its own native result, even with byte-identical text', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    // Native queue: each command is started and answered on its own, so the
    // started set holds exactly one uuid at each `result`.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'queued', 'started'));
    h.rpc.onStdoutChunk(resultLine('echo', initialUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'queued', 'started'));
    h.rpc.onStdoutChunk(resultLine('echo', steerUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await turn;

    const [first, second] = h.results();
    expect(h.results()).toHaveLength(2);
    expect(first?.text).toBe('echo');
    expect(second?.text).toBe('echo');
    // Byte-identical text, two native results → two boundaries, so downstream
    // mints two distinct completion tokens rather than folding. Identity is
    // asserted through *placement*, not object distinctness: each boundary
    // must land inside its own command's started→completed bracket. A folding
    // implementation, or one that deferred both boundaries to the end of the
    // window, yields a different sequence here.
    expect(h.trace()).toEqual([
      `${initialUuid}:queued`,
      `${initialUuid}:started`,
      'result:echo',
      `${initialUuid}:completed`,
      `${steerUuid}:queued`,
      `${steerUuid}:started`,
      'result:echo',
      `${steerUuid}:completed`,
    ]);
  });

  it('does not drain a window whose newly started command still owes its result', async () => {
    // Covers the `startedSinceResult` gate in settleIfReady. After a result the
    // set is cleared, so a command that enters `started` AFTERWARDS is owed its
    // own result. If the window drained the moment every submitted uuid reached
    // a terminal state, that second native result would be forwarded to nobody
    // — the exact "queue swallows a real result" failure the value-keyed
    // contract exists to prevent.
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'queued', 'started'));
    h.rpc.onStdoutChunk(resultLine('first answer'));
    await macrotask();
    expect(h.results()).toHaveLength(1);

    // A steer lands AFTER the first result, so it starts a fresh owed-result
    // group rather than joining the answered one.
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'queued', 'started'));

    // Every submitted uuid is now terminal and a result has been seen, so the
    // only thing holding the window open is the owed second result.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    let drained = false;
    void turn.finally(() => {
      drained = true;
    });
    await macrotask();
    expect(drained).toBe(false);
    expect(h.results()).toHaveLength(1);

    // The owed result arrives: a SECOND native boundary, then drainage.
    h.rpc.onStdoutChunk(resultLine('second answer'));
    await turn;
    expect(h.results().map((outcome) => outcome.text)).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('fails the window loudly and reaps when a native result names a command it never submitted', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('go');
    const rejection = expect(turn).rejects.toThrow(
      /result envelope for unsubmitted command/u,
    );
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(resultLine('stray', 'never-submitted-uuid'));

    await rejection;
    // Ambiguous ownership is not a completion boundary.
    expect(h.results()).toEqual([]);
    expect(h.reap).toHaveBeenCalledTimes(1);
  });

  it('settles a fold of three commands answered by ONE result, at the last completed', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    await h.rpc.steerTurn('third');
    const secondUuid = writtenCommandUuid(h.stdin, 1);
    const thirdUuid = writtenCommandUuid(h.stdin, 2);

    const settlements: string[] = [];
    void turn.then(
      () => settlements.push('drained'),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // The probed fold: messages queued while the in-flight turn is inside a
    // tool call are absorbed at the next query-loop boundary, answered
    // together, and produce ONE result. The folded uuids are never named by
    // any result — counting results per submitted uuid deadlocks here.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'queued', 'started'));
    await macrotask();
    h.rpc.onStdoutChunk(lifecycleChunk(secondUuid, 'queued'));
    h.rpc.onStdoutChunk(lifecycleChunk(thirdUuid, 'queued'));
    h.rpc.onStdoutChunk(
      lifecycleChunk(secondUuid, 'started') + lifecycleChunk(thirdUuid, 'started'),
    );
    await macrotask();

    h.rpc.onStdoutChunk(lifecycleChunk(secondUuid, 'completed'));
    h.rpc.onStdoutChunk(lifecycleChunk(thirdUuid, 'completed'));
    await macrotask();
    // Two of three commands are terminal, but no native answer has landed, so
    // there is nothing to forward and nothing to drain on.
    expect(settlements).toEqual([]);
    expect(h.results()).toEqual([]);

    h.rpc.onStdoutChunk(resultLine('one answer for all three', initialUuid));
    await macrotask();
    // The single shared result is forwarded at once as ONE boundary, but the
    // window has not drained: the host command is still not terminal.
    expect(h.results().map((outcome) => outcome.text)).toEqual([
      'one answer for all three',
    ]);
    expect(settlements).toEqual([]);

    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await turn;
    await macrotask();
    expect(settlements).toEqual(['drained']);
    // Three commands, one native result → still exactly ONE boundary, and it
    // was pushed when the result landed rather than batched at drainage.
    expect(h.trace()).toEqual([
      `${initialUuid}:queued`,
      `${initialUuid}:started`,
      `${secondUuid}:queued`,
      `${thirdUuid}:queued`,
      `${secondUuid}:started`,
      `${thirdUuid}:started`,
      `${secondUuid}:completed`,
      `${thirdUuid}:completed`,
      'result:one answer for all three',
      `${initialUuid}:completed`,
    ]);
  });

  it('settles a fold whose result lands before the folded commands complete', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    const settlements: string[] = [];
    void turn.then(
      () => settlements.push('drained'),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // Lifecycle/result ordering flips between scenarios: here the fold's
    // single result arrives BEFORE the folded commands go terminal. Drainage
    // must depend on eventual arrival only, never on order — and the result
    // carries the later, steered uuid rather than the first-submitted one.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await macrotask();
    expect(settlements).toEqual([]);
    expect(h.results()).toEqual([]);

    h.rpc.onStdoutChunk(resultLine('folded answer', steerUuid));
    await macrotask();
    expect(h.results().map((outcome) => outcome.text)).toEqual(['folded answer']);
    expect(settlements).toEqual([]);

    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await turn;
    await macrotask();
    expect(settlements).toEqual(['drained']);
    expect(h.trace()).toEqual([
      `${initialUuid}:completed`,
      'result:folded answer',
      `${steerUuid}:completed`,
    ]);
  });

  it('settles unfolded commands on the last one, not the first result', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    const settlements: string[] = [];
    void turn.then(
      () => settlements.push('drained'),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // A command that lands between turns runs on its own and gets its own
    // result, seconds apart from the next one and in a separate flush. The
    // first result is a real boundary, but it does not drain the window.
    h.rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    await macrotask();
    expect(h.results().map((outcome) => outcome.text)).toEqual(['initial result']);
    expect(settlements).toEqual([]);

    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await macrotask();
    expect(settlements).toEqual([]);

    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'started'));
    h.rpc.onStdoutChunk(resultLine('steer result', steerUuid));
    await macrotask();
    expect(settlements).toEqual([]);

    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await turn;
    await macrotask();
    expect(settlements).toEqual(['drained']);
    // Two unfolded commands, two native results → two boundaries, each pushed
    // as it arrived and attributed to its own command's bracket.
    expect(h.trace()).toEqual([
      'result:initial result',
      `${initialUuid}:completed`,
      `${steerUuid}:started`,
      'result:steer result',
      `${steerUuid}:completed`,
    ]);
  });

  it('does not hang or reject when a steered command is discarded', async () => {
    const log = vi.fn();
    const h = createHarness({ log });
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    // A discarded command never produces anything further, so it is terminal
    // and the window stops waiting on it — but it must not fail the turn: the
    // command that did run still answers it normally.
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'discarded'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(steerUuid));

    h.rpc.onStdoutChunk(resultLine('done', initialUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await turn;

    // A discard is not a native answer: exactly one boundary, from the one
    // command that actually ran.
    expect(h.trace()).toEqual([
      `${steerUuid}:discarded`,
      'result:done',
      `${initialUuid}:completed`,
    ]);
    expect(h.results()[0]).toMatchObject({ text: 'done', isError: false });
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('settles as soon as the last outstanding command is discarded', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    // The initial command runs and answers; the window then waits only on the
    // steer, which the CLI discards. That empties the outstanding set, so the
    // window drains right there with what did arrive.
    h.rpc.onStdoutChunk(resultLine('initial result', initialUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    let drained = false;
    void turn.finally(() => {
      drained = true;
    });
    await macrotask();
    expect(drained).toBe(false);

    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'discarded'));
    await turn;
    expect(h.results().map((outcome) => outcome.text)).toEqual(['initial result']);
    expect(h.results()[0]).toMatchObject({ isError: false });
  });

  it('fails the window when its only command is natively refused, naming the refusal', async () => {
    const log = vi.fn();
    const h = createHarness({ log });
    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);
    const rejection = expect(turn).rejects.toThrow(
      /without running any of its commands.*refused/u,
    );

    // `refused` is the third never-ran terminal state (alongside `cancelled`
    // and `discarded`): nothing can answer this window, so it fails loudly
    // instead of waiting on a result that is not coming.
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(lifecycleChunk(commandUuid, 'refused'));

    await rejection;
    expect(h.lifecycle()).toEqual([`${commandUuid}:refused`]);
    expect(h.results()).toEqual([]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(commandUuid));
    expect(h.reap).not.toHaveBeenCalled();
  });

  it('drains normally when a steer is refused but the initial command answers', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    // A refused steer coexists with a command that answers normally, exactly
    // as a cancelled command does, so it must not fail the window.
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'refused'));
    h.rpc.onStdoutChunk(resultLine('answered anyway', initialUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'completed'));
    await turn;

    expect(h.trace()).toEqual([
      `${steerUuid}:refused`,
      'result:answered anyway',
      `${initialUuid}:completed`,
    ]);
  });

  it("does not let a settled turn's late result settle the next turn", async () => {
    const log = vi.fn();
    const h = createHarness({ log });

    // Window A drains.
    const turnA = h.rpc.submitTurn('a');
    const uuidA = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(resultLine('a result', uuidA));
    h.rpc.onStdoutChunk(lifecycleChunk(uuidA, 'completed'));
    await turnA;
    expect(h.results().map((outcome) => outcome.text)).toEqual(['a result']);

    // Window B opens before A's trailing traffic has drained.
    const turnB = h.rpc.submitTurn('b');
    const uuidB = writtenCommandUuid(h.stdin, 1);
    // Setup only. Both uuids are independent randomUUID() defaults, so a
    // reference comparison between them could never fail; assert the shape
    // that the stale-result path below actually depends on instead.
    expect(uuidB).toMatch(UUID_RE);
    // A stale result for A must never mint a boundary inside B — B's sender
    // would be handed A's answer as its own completion. The RPC now treats
    // that ambiguity as fatal: it fails B loudly and reaps the resident child
    // rather than dropping the line quietly (src/rpc.ts `result` case).
    const rejection = expect(turnB).rejects.toThrow(
      /result envelope for unsubmitted command/u,
    );
    log.mockClear();

    h.rpc.onStdoutChunk(resultLine('a stale result', uuidA));
    await rejection;

    // The decisive assertion: no second boundary exists, so nothing carrying
    // 'a stale result' can ever reach B's sender.
    expect(h.results().map((outcome) => outcome.text)).toEqual(['a result']);
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining(uuidA),
      expect.any(Error),
    );
    expect(h.reap).toHaveBeenCalledTimes(1);
  });

  it('logs an error and reaps when a result arrives with no pending turn', async () => {
    const log = vi.fn();
    const h = createHarness({ log });

    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(commandLifecycleLine(commandUuid, 'completed'));
    h.rpc.onStdoutChunk(resultLine('first', commandUuid));
    await turn;
    expect(h.results().map((outcome) => outcome.text)).toEqual(['first']);

    // A late result (e.g. a steered command draining in a later stdout flush)
    // has no command group to attribute it to. Forwarding it would mint a
    // completion boundary owned by nobody, so it is refused: the RPC logs at
    // 'error' and reaps the resident child (behaviour changed from the older
    // 'warn'-and-drop; see src/rpc.ts, the `pending === null` result branch).
    log.mockClear();
    h.rpc.onStdoutChunk(resultLine('late'));

    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('without an attributable command group'),
      expect.any(Error),
    );
    expect(h.reap).toHaveBeenCalledTimes(1);
    // Still exactly one boundary: the orphan was not forwarded.
    expect(h.results().map((outcome) => outcome.text)).toEqual(['first']);
  });
});

describe('ClaudeCodeStreamRpc active steering', () => {
  it('flushes queued pre-init steers synchronously in submission order once init proves msg_lifecycle_v1, forwarding one boundary per native result', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    const second = h.rpc.steerTurn('second');
    const third = h.rpc.steerTurn('third');
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
    expect(h.stdin.writes).toHaveLength(1);

    h.rpc.onStdoutChunk(
      `${initLine()}${commandLifecycleLine(initialUuid, 'completed')}${resultLine('initial result', initialUuid)}`,
    );
    // Synchronous flush: both steers hit stdin inside the init line handling,
    // before any await gives the caller a chance to run.
    expect(h.stdin.writes).toHaveLength(3);
    await Promise.all([second, third]);

    expect([0, 1, 2].map((index) => writtenPrompt(h.stdin, index))).toEqual([
      'first',
      'second',
      'third',
    ]);
    const firstSteerUuid = writtenCommandUuid(h.stdin, 1);
    const secondSteerUuid = writtenCommandUuid(h.stdin, 2);
    expect(new Set([initialUuid, firstSteerUuid, secondSteerUuid]).size).toBe(3);

    let turnSettled = false;
    void turn.finally(() => {
      turnSettled = true;
    });
    await Promise.resolve();
    expect(turnSettled).toBe(false);

    h.rpc.onStdoutChunk(resultLine('first steer result', firstSteerUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(firstSteerUuid, 'completed'));
    await Promise.resolve();
    expect(turnSettled).toBe(false);
    h.rpc.onStdoutChunk(resultLine('final steer result', secondSteerUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(secondSteerUuid, 'completed'));

    await turn;
    // Three native results → three boundaries, in native order.
    const boundaries = h.results();
    expect(boundaries.map((outcome) => outcome.text)).toEqual([
      'initial result',
      'first steer result',
      'final steer result',
    ]);
    // Each boundary is forwarded at the moment its native `result` lands,
    // interleaved with the lifecycle facts rather than batched at drainage.
    expect(h.trace()).toEqual([
      `${initialUuid}:completed`,
      'result:initial result',
      'result:first steer result',
      `${firstSteerUuid}:completed`,
      'result:final steer result',
      `${secondSteerUuid}:completed`,
    ]);
  });

  it('reuses the proven lifecycle capability on a later turn, so a steer writes without waiting for another init', async () => {
    const h = createHarness();
    const firstTurn = h.rpc.submitTurn('first');
    const firstUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    h.rpc.onStdoutChunk(commandLifecycleLine(firstUuid, 'completed'));
    h.rpc.onStdoutChunk(resultLine('first result', firstUuid));
    await firstTurn;
    expect(h.results().map((outcome) => outcome.text)).toEqual(['first result']);

    const secondTurn = h.rpc.submitTurn('second');
    const secondUuid = writtenCommandUuid(h.stdin, 1);
    const steer = h.rpc.steerTurn('third');
    // No new `init` line: the capability decision is resident-session wide, so
    // the steer is written straight away instead of being queued.
    expect(h.stdin.writes).toHaveLength(3);
    await steer;
    const steerUuid = writtenCommandUuid(h.stdin, 2);

    h.rpc.onStdoutChunk(resultLine('second result', secondUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(secondUuid, 'completed'));
    h.rpc.onStdoutChunk(resultLine('third result', steerUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
    await secondTurn;
    expect(h.results().map((outcome) => outcome.text)).toEqual([
      'first result',
      'second result',
      'third result',
    ]);
  });

  it('rejects a queued pre-init steer when init advertises no msg_lifecycle_v1, then settles on the lone native result', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    const steer = h.rpc.steerTurn('second');
    const rejection = expect(steer).rejects.toThrow(/msg_lifecycle_v1/u);
    await Promise.resolve();
    expect(h.stdin.writes).toHaveLength(1);

    h.rpc.onStdoutChunk(initLine([]));
    await rejection;
    expect(h.stdin.writes).toHaveLength(1);

    // No `msg_lifecycle_v1`, so no `command_lifecycle` will ever arrive: the
    // result is the only terminal signal this build has, and the window drains
    // on it (the one degrade path).
    h.rpc.onStdoutChunk(resultLine('done', initialUuid));
    await turn;
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'done', isError: false });
  });

  it('releases a queued pre-init steer on failPending without writing it late', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const steer = h.rpc.steerTurn('second');
    const turnRejection = expect(turn).rejects.toThrow(/stopped mid-turn/u);
    const steerRejection = expect(steer).rejects.toThrow(/stopped mid-turn/u);
    expect(h.stdin.writes).toHaveLength(1);

    h.rpc.failPending(new Error('claude resident session stopped mid-turn'));
    await turnRejection;
    await steerRejection;

    h.rpc.onStdoutChunk(initLine());
    await Promise.resolve();
    expect(h.stdin.writes).toHaveLength(1);
    expect(h.results()).toEqual([]);
  });

  it("releases a queued pre-init steer when the initial command's native result lands before capability is decided", async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    const steer = h.rpc.steerTurn('second');
    const steerRejection = expect(steer).rejects.toThrow(
      /ended before live-steer capability was decided/u,
    );
    expect(h.stdin.writes).toHaveLength(1);

    h.rpc.onStdoutChunk(resultLine('done', initialUuid));

    await turn;
    await steerRejection;
    expect(h.stdin.writes).toHaveLength(1);
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'done' });
  });

  it('writes a live steer as a native stream-json user envelope while the turn is pending', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('second');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    expect(h.stdin.writes).toHaveLength(2);
    expect(JSON.parse(h.stdin.writes[1] ?? '{}')).toEqual({
      type: 'user',
      uuid: steerUuid,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
      },
    });

    h.rpc.onStdoutChunk(resultLine('initial', initialUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(initialUuid, 'completed'));
    h.rpc.onStdoutChunk(resultLine('done', steerUuid));
    h.rpc.onStdoutChunk(commandLifecycleLine(steerUuid, 'completed'));
    await turn;
    const [first, second] = h.results();
    expect(h.results()).toHaveLength(2);
    expect(first).toMatchObject({ text: 'initial', isError: false });
    expect(second).toMatchObject({ text: 'done', isError: false });
    // Each boundary is forwarded when its own native result lands, before the
    // owning command's terminal lifecycle fact.
    expect(h.trace()).toEqual([
      'result:initial',
      `${initialUuid}:completed`,
      'result:done',
      `${steerUuid}:completed`,
    ]);
  });

  it('classifies a steer whose native write was interrupted by stop as ambiguous and ignores its late callback', async () => {
    const stdin = new DeferredSteerStdin();
    const h = createHarness({ stdin });

    const turn = h.rpc.submitTurn('first');
    h.rpc.onStdoutChunk(initLine());
    const steer = h.rpc.steerTurn('second');
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(2);

    const stopped = new Error('stopped while native write was unconfirmed');
    const turnRejection = expect(turn).rejects.toBe(stopped);
    const steerRejection = expect(steer).rejects.toMatchObject({
      name: 'ClaudeSteerAdmissionError',
      admission: 'ambiguous',
    } satisfies Partial<ClaudeSteerAdmissionError>);
    h.rpc.failPending(stopped);

    await Promise.all([turnRejection, steerRejection]);
    stdin.finishSteer(new Error('late callback'));
    await Promise.resolve();
    expect(stdin.writes).toHaveLength(2);
    // A stopped window observed no native result: no completion boundary.
    expect(h.results()).toEqual([]);
  });

  it('does not forward the error_during_execution artifact of an interrupt as a completion boundary', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine());
    await h.rpc.steerTurn('interrupt');
    const steerUuid = writtenCommandUuid(h.stdin, 1);

    const settlements: string[] = [];
    void turn.then(
      () => settlements.push('drained'),
      (err: Error) => settlements.push(`rejected:${err.message}`),
    );

    // An interrupt genuinely interrupts: the running command is cancelled
    // and the CLI emits an `error_during_execution` envelope with neither a
    // `result` key nor a `user_message_uuid`. That artifact is not a native
    // answer — it must neither settle the window nor mint a boundary.
    h.rpc.onStdoutChunk(lifecycleChunk(initialUuid, 'cancelled'));
    h.rpc.onStdoutChunk(interruptArtifactLine());
    await macrotask();
    expect(settlements).toEqual([]);
    expect(h.results()).toEqual([]);

    h.rpc.onStdoutChunk(resultLine('interrupting answer', steerUuid));
    h.rpc.onStdoutChunk(lifecycleChunk(steerUuid, 'completed'));
    await turn;
    await macrotask();
    expect(settlements).toEqual(['drained']);
    // Exactly one native answer arrived, so exactly one boundary.
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({
      text: 'interrupting answer',
      isError: false,
    });
  });

  it('settles on the first native result when init advertises no lifecycle capability', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('go');
    // No `msg_lifecycle_v1`: no `command_lifecycle` envelope will ever arrive,
    // so waiting for lifecycle terminality would hang forever. The result is
    // the only terminal event such a build has.
    h.rpc.onStdoutChunk(initLine([]));
    h.rpc.onStdoutChunk(resultLine('done'));

    await turn;
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'done', isError: false });
  });

  it('settles on the native result when command_lifecycle arrives as a top-level type', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('go');
    const commandUuid = writtenCommandUuid(h.stdin, 0);

    // The resident CLI emits `command_lifecycle` as a top-level `type`
    // ({"type":"command_lifecycle",...}), not as a `system` subtype. The window
    // must still drain on the `result` envelope regardless of that shape.
    h.rpc.onStdoutChunk(
      `${JSON.stringify({
        type: 'command_lifecycle',
        command_uuid: commandUuid,
        state: 'completed',
      })}\n`,
    );
    h.rpc.onStdoutChunk(resultLine('final', commandUuid));

    await turn;
    expect(h.lifecycle()).toEqual([`${commandUuid}:completed`]);
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'final', isError: false });
  });

  it('fails a live steer loudly when init proves msg_lifecycle_v1 is unavailable', async () => {
    const h = createHarness();
    const turn = h.rpc.submitTurn('first');
    const initialUuid = writtenCommandUuid(h.stdin, 0);
    h.rpc.onStdoutChunk(initLine([]));
    await expect(h.rpc.steerTurn('second')).rejects.toThrow(/msg_lifecycle_v1/);
    expect(h.stdin.writes).toHaveLength(1);

    h.rpc.onStdoutChunk(resultLine('done', initialUuid));
    await turn;
    expect(h.results()).toHaveLength(1);
    expect(h.results()[0]).toMatchObject({ text: 'done' });
    expect(initialUuid).toMatch(UUID_RE);
  });
});
