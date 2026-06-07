/**
 * Unit tests for TeamMate worker log retrieval (issue #126 PR5).
 *
 * These prove the read side of `get_task_logs` in isolation: provider_ref →
 * stream layout mapping, bounded tail with truncation, absent-file handling, and
 * the unsupported-provider case. HOME is redirected to a temp dir so the
 * paths.ts builders resolve under it, and log files are written via the same
 * builders the providers use — so the test exercises the real path contract, not
 * a hand-built path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
} from '../src/runtime/config.js';
import {
  dispatcherTeamMateWorkerClaudeStreamLogPath,
  dispatcherTeamMateWorkerErrorLogPath,
  dispatcherTeamMateWorkerEventsLogPath,
  dispatcherTeamMateWorkerLogPath,
  resetRuntimeConfig,
} from '../src/runtime/paths.js';
import {
  readTeamMateWorkerLogs,
  TEAMMATE_WORKER_LOG_MAX_BYTES_CAP,
} from '../src/teammate/worker-logs.js';

const DISPATCHER = 'logs';
const TASK = 'tmtsk_logs_one';

async function writeLog(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('TeamMate worker logs', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-teammate-logs-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the codex worker stdout + stderr streams', async () => {
    await writeLog(
      dispatcherTeamMateWorkerLogPath(DISPATCHER, TASK),
      'app-server protocol frames\n',
    );
    await writeLog(
      dispatcherTeamMateWorkerErrorLogPath(DISPATCHER, TASK),
      'worker stderr line\n',
    );
    await writeLog(
      dispatcherTeamMateWorkerEventsLogPath(DISPATCHER, TASK),
      '# Codex emitted 0 event(s)\n',
    );

    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CODEX_PROVIDER_REF,
    });

    expect(logs.logs_supported).toBe(true);
    expect(logs.streams.map((s) => s.stream)).toEqual([
      'stdout',
      'stderr',
      'events',
    ]);
    const stdout = logs.streams.find((s) => s.stream === 'stdout');
    expect(stdout).toMatchObject({
      available: true,
      truncated: false,
      text: 'app-server protocol frames\n',
    });
    const stderr = logs.streams.find((s) => s.stream === 'stderr');
    expect(stderr).toMatchObject({ available: true, text: 'worker stderr line\n' });
    // The events trace is the actionable diagnostic when stdout/stderr are empty.
    const events = logs.streams.find((s) => s.stream === 'events');
    expect(events).toMatchObject({ available: true, text: '# Codex emitted 0 event(s)\n' });
  });

  it('returns only the claude-code stderr stream', async () => {
    await writeLog(
      dispatcherTeamMateWorkerClaudeStreamLogPath(DISPATCHER, TASK),
      'claude resident-child stderr\n',
    );

    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
    });

    expect(logs.logs_supported).toBe(true);
    expect(logs.streams.map((s) => s.stream)).toEqual(['stderr']);
    expect(logs.streams[0]).toMatchObject({
      available: true,
      text: 'claude resident-child stderr\n',
    });
  });

  it('reports unavailable streams when the worker never wrote a log', async () => {
    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CODEX_PROVIDER_REF,
    });
    expect(logs.logs_supported).toBe(true);
    for (const stream of logs.streams) {
      expect(stream).toMatchObject({
        available: false,
        bytes: 0,
        truncated: false,
        text: '',
      });
    }
  });

  it('marks logs unsupported for a task with no provider', async () => {
    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: null,
    });
    expect(logs.logs_supported).toBe(false);
    expect(logs.streams).toEqual([]);
  });

  it('bounds the tail and flags truncation', async () => {
    const big = `${'A'.repeat(5_000)}TAIL_MARKER\n`;
    await writeLog(dispatcherTeamMateWorkerErrorLogPath(DISPATCHER, TASK), big);

    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CODEX_PROVIDER_REF,
      maxBytes: 32,
      stream: 'stderr',
    });
    expect(logs.streams).toHaveLength(1);
    const stderr = logs.streams[0]!;
    expect(stderr.truncated).toBe(true);
    expect(stderr.bytes).toBe(32);
    // The tail is what is kept: only the last 32 bytes, so the marker at the end
    // survives while the ~5 KB head is dropped.
    expect(stderr.text).toHaveLength(32);
    expect(stderr.text.endsWith('TAIL_MARKER\n')).toBe(true);
    expect(stderr.text.length).toBeLessThan(big.length);
  });

  it('caps an over-large max_bytes request', async () => {
    await writeLog(
      dispatcherTeamMateWorkerErrorLogPath(DISPATCHER, TASK),
      'short\n',
    );
    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CODEX_PROVIDER_REF,
      maxBytes: TEAMMATE_WORKER_LOG_MAX_BYTES_CAP * 10,
      stream: 'stderr',
    });
    // Smaller-than-cap file returns whole, untruncated regardless of the request.
    expect(logs.streams[0]).toMatchObject({ truncated: false, text: 'short\n' });
  });

  it('honors a single-stream filter for codex', async () => {
    await writeLog(
      dispatcherTeamMateWorkerLogPath(DISPATCHER, TASK),
      'stdout\n',
    );
    await writeLog(
      dispatcherTeamMateWorkerErrorLogPath(DISPATCHER, TASK),
      'stderr\n',
    );
    const logs = await readTeamMateWorkerLogs({
      dispatcherId: DISPATCHER,
      taskId: TASK,
      providerRef: BUILTIN_CODEX_PROVIDER_REF,
      stream: 'stdout',
    });
    expect(logs.streams.map((s) => s.stream)).toEqual(['stdout']);
  });
});
