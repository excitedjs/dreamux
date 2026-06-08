/**
 * Resident-session contract tests (issue #120, P1 follow-up).
 *
 * These drive the REAL `createDefaultClaudeCodeSession` supervisor over real OS
 * pipes against a tiny fake `claude` stream-json child (no real `claude` binary
 * needed — see `fixtures/fake-claude-stream.mjs`). They cover the path the
 * adversarial review flagged: a child that stays alive but never emits a
 * terminal `result` must not pend forever — the per-turn deadline fails the turn
 * and reaps the child so follow-up work cannot wedge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
} from '../src/claude-code/supervisor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'fake-claude-stream.mjs');

describe('resident claude session (real child, fake stream-json protocol)', () => {
  let dir: string;
  let stderrLog: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-cc-session-'));
    stderrLog = join(dir, 'stderr.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(mode: 'echo' | 'stall', turnTimeoutMs: number): ClaudeCodeSession {
    return createDefaultClaudeCodeSession({
      bin: process.execPath,
      args: [FIXTURE, mode],
      cwd: dir,
      env: process.env,
      stderrLogPath: stderrLog,
      turnTimeoutMs,
    });
  }

  it('resolves turns from streamed results and serves them over one process', async () => {
    const session = makeSession('echo', 5_000);
    await session.start();

    const first = await session.submitTurn('hello');
    expect(first.text).toBe('echo:hello');
    expect(first.sessionId).toBe('fake-sess-1');
    expect(first.isError).toBe(false);

    // Second turn over the SAME resident child.
    const second = await session.submitTurn('again');
    expect(second.text).toBe('echo:again');
    expect(session.isAlive()).toBe(true);

    await session.stop();
    expect(session.isAlive()).toBe(false);
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

  it('fails the turn and reaps the child when the live child never emits a result', async () => {
    const session = makeSession('stall', 250);
    await session.start();
    expect(session.isAlive()).toBe(true);

    await expect(session.submitTurn('hangs forever')).rejects.toThrow(/timed out/i);

    // The deadline reaped the child, so the runtime re-spawns on the next turn
    // instead of reusing a child with half a turn's output buffered.
    expect(session.isAlive()).toBe(false);

    await session.stop(); // idempotent
    expect(session.isAlive()).toBe(false);
  });

  it('does not wedge follow-up work: a submit after a timeout fails fast, not forever', async () => {
    const session = makeSession('stall', 200);
    await session.start();
    await expect(session.submitTurn('first')).rejects.toThrow(/timed out/i);

    // A follow-up submit returns promptly (rejected) rather than hanging — the
    // property that keeps the serial queue and TeamMate delivery retry moving.
    const start = Date.now();
    await expect(session.submitTurn('second')).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
