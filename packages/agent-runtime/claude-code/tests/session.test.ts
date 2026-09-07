/** Real OS pipes and supervisor around synthetic native protocol fixtures. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultClaudeCodeSession, type ClaudeCodeSession } from '../src/supervisor.js';
import type { ClaudeProtocolEvent } from '../src/types.js';
import type { RuntimeAdmission, RuntimeSubmission } from '@excitedjs/dreamux-types';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude-stream.mjs');
async function accepted(admission: Promise<RuntimeAdmission>): Promise<RuntimeSubmission> {
  const value = await admission;
  if (value.status !== 'submitted') throw new Error(`expected submission, got ${value.status}`);
  return value.submission;
}

describe('resident session over real pipes', () => {
  let dir: string;
  let events: ClaudeProtocolEvent[];
  let sessions: ClaudeCodeSession[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dreamux-cc-session-'));
    events = [];
    sessions = [];
  });
  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.stop()));
    await rm(dir, { recursive: true, force: true });
  });
  function makeSession(mode: 'echo' | 'stall', timeout = 5_000, onRemoteControlUrl?: (url: string) => void) {
    const session = createDefaultClaudeCodeSession({
      bin: process.execPath, args: [FIXTURE, mode], cwd: dir, env: process.env,
      stderrLogPath: join(dir, 'stderr.log'), sessionId: 'fake-sess-1', turnTimeoutMs: timeout,
      remoteControl: onRemoteControlUrl !== undefined, onRemoteControlUrl,
      onProtocolEvent: (event) => events.push(event),
    });
    sessions.push(session);
    return session;
  }

  it('returns admission and per-request answers, reusing one process for subsequent input', async () => {
    const session = makeSession('echo');
    await session.start();
    const a = await accepted(session.submit('hello', {}, 'A'));
    await expect(a.settled).resolves.toEqual({ kind: 'completion', completion: { status: 'completed', resultText: 'echo:hello' } });
    const b = await accepted(session.submit('again', {}, 'B'));
    await expect(b.settled).resolves.toEqual({ kind: 'completion', completion: { status: 'completed', resultText: 'echo:again' } });
    expect(session.isAlive()).toBe(true);
    expect(events.filter((event) => event.kind === 'command_lifecycle')).toEqual([
      { kind: 'command_lifecycle', commandUuid: 'A', state: 'started' },
      { kind: 'command_lifecycle', commandUuid: 'A', state: 'completed' },
      { kind: 'command_lifecycle', commandUuid: 'B', state: 'started' },
      { kind: 'command_lifecycle', commandUuid: 'B', state: 'completed' },
    ]);
    const resultIndex = events.findIndex((event) => event.kind === 'result');
    const assistantIndex = events.findIndex((event) => event.kind === 'stream' && event.line.kind === 'assistant');
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeLessThan(resultIndex);
  });

  it('keeps identical answers to separate inputs as distinct completions', async () => {
    const session = makeSession('echo');
    await session.start();
    const a = await accepted(session.submit('same'));
    const first = await a.settled;
    const b = await accepted(session.submit('same'));
    const second = await b.settled;
    expect(second).toEqual(first);
    if (first.kind !== 'completion' || second.kind !== 'completion') throw new Error('expected completions');
    expect(second.completion).not.toBe(first.completion);
  });

  it('admits concurrent input before either request has a result', async () => {
    const session = makeSession('stall');
    await session.start();
    const a = await accepted(session.submit('one'));
    const b = await accepted(session.submit('two'));
    expect(events.filter((event) => event.kind === 'result')).toEqual([]);
    await session.stop();
    await expect(a.settled).resolves.toEqual({ kind: 'stopped' });
    await expect(b.settled).resolves.toEqual({ kind: 'stopped' });
  });

  it('enables Remote Control independently of request settlement', async () => {
    let resolveUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => { resolveUrl = resolve; });
    const session = makeSession('echo', 5_000, resolveUrl);
    await session.start();
    await expect(url).resolves.toBe('https://example.invalid/session/fake');
    expect(events.filter((event) => event.kind === 'result')).toEqual([]);
    const request = await accepted(session.submit('after control'));
    await expect(request.settled).resolves.toMatchObject({ kind: 'completion', completion: { resultText: 'echo:after control' } });
  });

  it('fails silent requests, reports the timeout once and reaps the child', async () => {
    const session = makeSession('stall', 200);
    const failures: Error[] = [];
    session.setOnExit((error) => failures.push(error));
    await session.start();
    const request = await accepted(session.submit('stall'));
    await expect(request.settled).resolves.toMatchObject({ kind: 'failed', error: expect.objectContaining({ message: expect.stringContaining('no stream activity') }) });
    expect(failures).toHaveLength(1);
    expect(session.isAlive()).toBe(false);
    await expect(session.submit('after timeout')).resolves.toMatchObject({ status: 'stopped' });
    expect(events.filter((event) => event.kind === 'result')).toEqual([]);
  });
});
