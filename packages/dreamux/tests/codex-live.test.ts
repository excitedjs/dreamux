/**
 * Auth-free installed Codex compatibility. Model execution is separately
 * opted into with DREAMUX_RUN_LIVE_MODEL_GATE=1 in the three model test files.
 */

import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
// Test-only internal coupling: raw process/WS/initialize/version probes have no
// public equivalent for the auth-free boundary; no model submission is involved.
import { CodexProcess } from '../../agent-runtime/codex/dist/supervisor.js';
import { CodexWsClient } from '../../agent-runtime/codex/dist/rpc.js';
import { performInitializeHandshake } from '../../agent-runtime/codex/dist/handshake.js';
import { codexVersionSatisfies } from '../../agent-runtime/codex/dist/version.js';
import type { ThreadStartResponse } from '../../agent-runtime/codex/dist/types.js';

const skipLiveCodex = process.env['DREAMUX_SKIP_LIVE_CODEX'] === '1';
if (skipLiveCodex)
  console.warn(
    '[codex-live] DREAMUX_SKIP_LIVE_CODEX=1 excludes installed-version and real protocol checks; Codex compatibility is not certified.',
  );

it.skipIf(skipLiveCodex)(
  'checks the installed version and initializes a real app-server thread without model auth',
  async () => {
    const bin = process.env['CODEX_HOST_CODEX_BIN']?.trim() || 'codex';
    const { stdout } = await promisify(execFile)(bin, ['--version']);
    expect(codexVersionSatisfies(stdout)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'dreamux-codex-protocol-'));
    const cwd = join(dir, 'cwd');
    const codexHome = join(dir, 'codex');
    const socketPath = join(dir, 'rpc.sock');
    const proc = new CodexProcess({
      binPath: bin,
      socketPath,
      cwd,
      stdoutLogPath: join(dir, 'stdout.log'),
      stderrLogPath: join(dir, 'stderr.log'),
      // No operator config, auth file or model credential environment enters
      // this process. Initialize/thread creation must work on hosted CI too.
      env: { PATH: process.env['PATH'], HOME: dir, CODEX_HOME: codexHome },
      readyTimeoutMs: 15_000,
    });
    let client: CodexWsClient | undefined;
    try {
      await Promise.all([mkdir(cwd), mkdir(codexHome)]);
      await proc.start();
      client = new CodexWsClient({ socketPath });
      await client.ready();
      const initialized = await performInitializeHandshake(client, {
        timeoutMs: 15_000,
      });
      expect(typeof initialized.userAgent).toBe('string');
      expect(initialized.userAgent.length).toBeGreaterThan(0);
      expect(initialized.platformOs).toBeDefined();
      const started = await client.request<ThreadStartResponse>(
        'thread/start',
        { cwd },
      );
      expect(typeof started.thread.id).toBe('string');
      expect(started.thread.id.length).toBeGreaterThan(0);
    } finally {
      client?.close();
      try {
        await proc.reap();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
  30_000,
);
