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

import { ClaudeCodeStreamRpc } from '../src/agent-runtime/builtin/claude-code/rpc.js';

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

function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    session_id: 's1',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;
}

function resultLine(text = 'final'): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: 's1',
  })}\n`;
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

    // Emit a stream line every 800ms — each under the 1000ms idle window — for
    // a total of 4000ms, far longer than the window. Continuous activity keeps
    // resetting the deadline, so it must never fire.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      rpc.onStdoutChunk(assistantLine(`step ${i}`));
    }
    expect(reap).not.toHaveBeenCalled();

    // The terminal result settles the turn (and clears the timer).
    rpc.onStdoutChunk(resultLine());
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
  it('writes a stream-json user envelope while a turn is pending', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    await rpc.steerTurn('second', { priority: 'next' });

    expect(stdin.writes).toHaveLength(2);
    expect(JSON.parse(stdin.writes[1] ?? '{}')).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
      },
      priority: 'next',
    });

    rpc.onStdoutChunk(resultLine('done'));
    await flushImmediate();
    await expect(turn).resolves.toMatchObject({ text: 'done', isError: false });
  });

  it('folds an immediate follow-up result from a steer into the pending turn', async () => {
    const stdin = new FakeStdin();
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
    });

    const turn = rpc.submitTurn('first');
    await rpc.steerTurn('second', { priority: 'next' });

    rpc.onStdoutChunk(
      [
        assistantLine('original answer'),
        resultLine('original result'),
        assistantLine('steered answer'),
        resultLine('steered result'),
      ].join(''),
    );
    await flushImmediate();

    await expect(turn).resolves.toMatchObject({
      text: 'steered result',
      isError: false,
    });
  });
});

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
