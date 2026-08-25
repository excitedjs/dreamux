/**
 * Resident-session contract tests (issue #120, migrated to the value-keyed turn
 * contract).
 *
 * These drive the REAL `createDefaultClaudeCodeSession` supervisor over real OS
 * pipes against a tiny fake `claude` stream-json child (no real `claude` binary
 * needed — see `fixtures/fake-claude-stream.mjs`). The fake only ever replays
 * native stream-json envelopes; every expectation below is derived from those
 * envelopes, never from an instruction handed to the fake.
 *
 * The seam under test changed: `submitTurn` no longer *returns* the turn
 * result. A native `result` envelope is now pushed out of the live stream as an
 * `onProtocolEvent({ kind: 'result', outcome })` BEFORE the submission settles,
 * alongside the live `stream` / `command_lifecycle` activity of the same native
 * window. `submitTurn` only resolves once the resident command group drained.
 *
 * Still covered from the original suite: a child that stays alive but never
 * emits a terminal `result` must not pend forever — the per-turn idle deadline
 * fails the turn and reaps the child so follow-up work cannot wedge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
} from '../src/supervisor.js';
import type { ClaudeProtocolEvent, TurnOutcome } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fake-claude-stream.mjs');

describe('resident claude session (real child, fake stream-json protocol)', () => {
  let dir: string;
  let stderrLog: string;
  /** Everything the live stream pushed, in arrival order. */
  let events: ClaudeProtocolEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-cc-session-'));
    stderrLog = join(dir, 'stderr.log');
    events = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timed out');
  }

  function makeSession(
    mode: 'echo' | 'stall',
    turnTimeoutMs: number,
    remoteControl = false,
    onRemoteControlUrl?: (url: string) => void,
  ): ClaudeCodeSession {
    return createDefaultClaudeCodeSession({
      bin: process.execPath,
      args: [FIXTURE, mode],
      cwd: dir,
      env: process.env,
      stderrLogPath: stderrLog,
      turnTimeoutMs,
      remoteControl,
      onRemoteControlUrl,
      onProtocolEvent: (event) => events.push(event),
    });
  }

  /** The native `result` envelopes observed on the live stream, in order. */
  function resultOutcomes(): TurnOutcome[] {
    return events
      .filter((event): event is Extract<ClaudeProtocolEvent, { kind: 'result' }> =>
        event.kind === 'result',
      )
      .map((event) => event.outcome);
  }

  /** Index of the first live `assistant` snapshot carrying `text`, or -1. */
  function assistantEventIndex(text: string): number {
    return events.findIndex(
      (event) =>
        event.kind === 'stream' &&
        event.line.kind === 'assistant' &&
        event.line.text === text,
    );
  }

  function resultEventIndex(text: string): number {
    return events.findIndex(
      (event) => event.kind === 'result' && event.outcome.text === text,
    );
  }

  it('pushes each native result out of the live stream (not out of submitTurn) and serves both turns over one process', async () => {
    const session = makeSession('echo', 5_000);
    await session.start();

    const firstUuid = 'cmd-first-0000-0000-000000000001';
    // The submission itself carries no value: the native `result` is delivered
    // live, so it is already on the sink when the submission settles.
    await expect(session.submitTurn('hello', {}, firstUuid)).resolves.toBeUndefined();

    const afterFirst = resultOutcomes();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.text).toBe('echo:hello');
    expect(afterFirst[0]!.sessionId).toBe('fake-sess-1');
    expect(afterFirst[0]!.isError).toBe(false);

    // Live activity of this native window is pushed BEFORE its terminal result,
    // in native order — never rebuilt afterwards.
    const assistantIdx = assistantEventIndex('echo:hello');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeLessThan(resultEventIndex('echo:hello'));

    // The lifecycle fact of this window names the exact submitted command uuid:
    // one stable, non-empty id shared by the submission and its native facts.
    const lifecycle = events.filter(
      (event): event is Extract<ClaudeProtocolEvent, { kind: 'command_lifecycle' }> =>
        event.kind === 'command_lifecycle',
    );
    expect(lifecycle.map((event) => event.commandUuid)).toContain(firstUuid);
    expect(
      lifecycle.find((event) => event.commandUuid === firstUuid)!.state,
    ).toBe('completed');

    // Second turn over the SAME resident child: a second native `user` message
    // produces a second native `result`, hence a second result event.
    await expect(session.submitTurn('again')).resolves.toBeUndefined();
    const afterSecond = resultOutcomes();
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]!.text).toBe('echo:again');
    expect(session.isAlive()).toBe(true);

    await session.stop();
    expect(session.isAlive()).toBe(false);
  });

  it('emits one result event per native result even when two queued turns produce byte-identical text', async () => {
    const session = makeSession('echo', 5_000);
    await session.start();

    // Two separate native `user` messages, each answered by its own native
    // `result`. Byte-identical result text must NOT collapse them.
    await session.submitTurn('same');
    await session.submitTurn('same');

    const outcomes = resultOutcomes();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.text).toBe('echo:same');
    expect(outcomes[1]!.text).toBe('echo:same');
    // Object identity is deliberately NOT asserted here: `TurnOutcome` is built
    // as a fresh literal per envelope (src/stream.ts `outcome()`), so a
    // reference comparison could never fail and would prove nothing. Completion
    // TOKEN identity is the real contract and is proven one layer up, against
    // src/runtime-submissions.ts, in tests/runtime-activity.test.ts.
    //
    // What IS falsifiable at this seam is that the two byte-identical answers
    // came from two SEPARATE native turns: each `result` must be preceded by
    // its own native line, so the two result events cannot be adjacent.
    const resultIndexes = events
      .map((event, index) => (event.kind === 'result' ? index : -1))
      .filter((index) => index >= 0);
    expect(resultIndexes).toHaveLength(2);
    expect(resultIndexes[1]! - resultIndexes[0]!).toBeGreaterThan(1);

    await session.stop();
  });

  it('enables Remote Control at resident child startup when configured', async () => {
    const urls: string[] = [];
    const session = makeSession('echo', 5_000, true, (url) => urls.push(url));
    await session.start();

    await waitFor(
      () =>
        existsSync(stderrLog) &&
        readFileSync(stderrLog, 'utf8').includes('remote-control-requested'),
    );
    await waitFor(() => urls.length === 1);
    expect(urls).toEqual(['https://example.invalid/session/fake']);

    // The control handshake is not a turn: it produces no result event, and a
    // later turn still reports its native result on the live stream.
    expect(resultOutcomes()).toHaveLength(0);

    await session.submitTurn('after rc');
    const outcomes = resultOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.text).toBe('echo:after rc');

    await session.stop();
  });

  it('rejects a concurrent submit rather than interleaving two turns', async () => {
    const session = makeSession('stall', 5_000);
    await session.start();
    const first = session.submitTurn('one'); // never completes (stall)
    await expect(session.submitTurn('two')).rejects.toThrow(/mid-turn/i);
    void first.catch(() => {
      /* abandoned when the session is stopped below */
    });
    await session.stop();
  });

  it('admits a live steer into the active resident window without opening a second turn', async () => {
    const session = makeSession('stall', 5_000);
    await session.start();
    const first = session.submitTurn('one'); // stall: no native `result` ever
    void first.catch(() => {
      /* abandoned when the session is stopped below */
    });

    // The steer is written into the SAME native window: the child echoes it as
    // live activity, and no native `result` is produced by either command.
    await expect(session.steerTurn('steered')).resolves.toBeUndefined();
    await waitFor(() => assistantEventIndex('echo:steered') >= 0);
    expect(resultOutcomes()).toHaveLength(0);

    // A steer is not a new submission: a real second submit is still refused.
    await expect(session.submitTurn('two')).rejects.toThrow(/mid-turn/i);

    await session.stop();
  });

  it('fails the turn and reaps the child when the live child never emits a result', async () => {
    const session = makeSession('stall', 250);
    await session.start();
    expect(session.isAlive()).toBe(true);

    await expect(session.submitTurn('hangs forever')).rejects.toThrow(
      /stalled|no stream activity/i,
    );
    // A stalled turn observed no native result, so nothing was ever pushed as a
    // completion: a failure creates no result event.
    expect(resultOutcomes()).toHaveLength(0);

    // The deadline reaped the child, so the runtime re-spawns on the next turn
    // instead of reusing a child with half a turn's output buffered.
    expect(session.isAlive()).toBe(false);

    await session.stop(); // idempotent
    expect(session.isAlive()).toBe(false);
  });

  it('does not wedge follow-up work: a submit after a timeout fails fast, not forever', async () => {
    const session = makeSession('stall', 200);
    await session.start();
    await expect(session.submitTurn('first')).rejects.toThrow(
      /stalled|no stream activity/i,
    );

    // A follow-up submit returns promptly (rejected) rather than hanging — the
    // property that keeps the serial queue and TeamMate delivery retry moving.
    const start = Date.now();
    await expect(session.submitTurn('second')).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(resultOutcomes()).toHaveLength(0);
  });
});
