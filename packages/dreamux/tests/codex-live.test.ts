/**
 * Auth-free installed Codex compatibility. Model execution is separately
 * opted into with DREAMUX_RUN_LIVE_MODEL_GATE=1 in the three model test files.
 */

import { it, expect } from 'vitest';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCommand } from '@excitedjs/dreamux-utils';
// Test-only internal coupling: raw process/RPC/initialize/version probes have no
// public equivalent for the auth-free boundary; no model submission is involved.
import { CodexProcess } from '../../agent-runtime/codex/dist/supervisor.js';
import { CodexRpcClient } from '../../agent-runtime/codex/dist/rpc.js';
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
    const version = await spawnCommand(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    version.stdout!.setEncoding('utf8');
    version.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
    });
    version.stderr!.resume();
    const [code] = await once(version, 'close');
    expect(code).toBe(0);
    expect(codexVersionSatisfies(stdout)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'dreamux-codex-protocol-'));
    const cwd = join(dir, 'cwd');
    const codexHome = join(dir, 'codex');
    const socketPath = join(dir, 'rpc.sock');
    const proc = new CodexProcess({
      binPath: bin,
      ...(process.platform === 'win32' ? {} : { socketPath }),
      cwd,
      stdoutLogPath: join(dir, 'stdout.log'),
      stderrLogPath: join(dir, 'stderr.log'),
      // No operator config, auth file or model credential environment enters
      // this process. Initialize/thread creation must work on hosted CI too.
      env: {
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
        ComSpec: process.env['ComSpec'],
        TEMP: process.env['TEMP'],
        TMP: process.env['TMP'],
        HOME: dir,
        USERPROFILE: dir,
        CODEX_HOME: codexHome,
      },
      readyTimeoutMs: 15_000,
    });
    let client: CodexRpcClient | undefined;
    try {
      await Promise.all([mkdir(cwd), mkdir(codexHome)]);
      await proc.start();
      client = new CodexRpcClient(proc.connectionOptions);
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
        // Windows can keep recently closed native files briefly busy after
        // every supervised process has exited.
        await rm(dir, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 3 : 0,
          retryDelay: 100,
        });
      }
    }
  },
  30_000,
);
