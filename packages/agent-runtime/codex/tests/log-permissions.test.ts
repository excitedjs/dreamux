/** Real provider startup with a synthetic CLI, without model or account access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime, DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  ensureOwnerOnlyDir,
  ensureOwnerOnlyFile,
} from '@excitedjs/dreamux-utils';
import {
  currentWindowsUserSid,
  expectOwnerOnlyPermissions,
  holdWindowsReadLock,
  isWindowsAdministrator,
  makeWorldReadable,
  readWindowsPermissions,
  setWindowsFixturePermissions,
  withWindowsRestorePrivilege,
} from '../../../../common/scripts/test-permissions.mjs';
import { defaultDispatcherCodexConfig } from '../src/config.js';
import { createCodexAgentRuntimeProvider } from '../src/provider.js';
import { CodexProcess } from '../src/supervisor.js';

const logger: DreamuxLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child: () => logger,
};

describe('provider log permissions', () => {
  let dir: string;
  let logs: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(homedir(), 'cx-log-'));
    logs = join(dir, 'logs');
    await ensureOwnerOnlyDir(logs);
    vi.stubEnv('CODEX_HOST_CODEX_BIN', '');
    const fixture = new URL(
      './fixtures/logging-app-server.mjs',
      import.meta.url,
    );
    // Node treats Codex's first CLI argument as its script in this disposable cwd.
    await writeFile(
      join(dir, 'app-server'),
      `import(${JSON.stringify(fixture.href)});`,
    );
  });

  afterEach(async () => {
    await runtime?.stop();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['fresh', 'existing'])(
    'protects %s provider logs before child output and preserves appended content',
    async (kind) => {
      const providerDir = join(logs, 'codex-app-server');
      const stderr = join(providerDir, 'agent.stderr.log');
      const stdout = join(providerDir, 'agent.log');
      const files = process.platform === 'win32' ? [stderr] : [stdout, stderr];
      if (kind === 'existing') {
        await ensureOwnerOnlyDir(providerDir);
        for (const file of files) {
          await writeFile(file, 'existing log\n');
          await ensureOwnerOnlyFile(file);
          await makeWorldReadable(file, 0o644);
        }
        await makeWorldReadable(providerDir, 0o755);
      }
      const observation = join(dir, 'observed.json');
      for (let start = 0; start < 2; start++) {
        runtime = await createCodexAgentRuntimeProvider().createRuntime({
          identity: { runtimeId: 'agent', sessionId: null },
          config: {
            ...defaultDispatcherCodexConfig(),
            bin: process.execPath,
            initialize_timeout_ms: 5_000,
            extra_env: {
              DREAMUX_TEST_LOG_OBSERVATION: observation,
              DREAMUX_TEST_LOG_PATHS: JSON.stringify([
                [providerDir, 0o700],
                ...files.map((file) => [file, 0o600]),
              ]),
            },
          },
          cwd: dir,
          logger,
          mcpServers: [],
          skillSources: [],
          disabledFeatures: [],
          paths: {
            logsDir: () => logs,
            cacheDir: () => dir,
            runtimeSocketDirs: () => [dir],
          },
          state: { publish: async () => undefined },
          results: () => undefined,
          activity: () => undefined,
        });
        await expect(runtime.start()).resolves.toEqual({ continuity: 'fresh' });
        expect(JSON.parse(await readFile(observation, 'utf8'))).toEqual([]);
        await expectOwnerOnlyPermissions(providerDir, 0o700);
        for (const file of files) await expectOwnerOnlyPermissions(file, 0o600);
        if (process.platform === 'win32')
          await expect(readFile(stdout)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        await runtime.stop();
        runtime = undefined;
      }
      for (const file of files) {
        const marker =
          file === stderr ? 'fixture stderr\n' : 'fixture stdout\n';
        expect(await readFile(file, 'utf8')).toBe(
          (kind === 'existing' ? 'existing log\n' : '') + marker.repeat(2),
        );
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'closes the append handle when a foreign-owner log is refused',
    async (context) => {
      if (!isWindowsAdministrator()) context.skip();
      const providerDir = join(logs, 'codex-app-server');
      await ensureOwnerOnlyDir(providerDir);
      const stderr = join(providerDir, 'foreign.stderr.log');
      await writeFile(stderr, 'existing log\n');
      const sid = currentWindowsUserSid();
      withWindowsRestorePrivilege(() =>
        setWindowsFixturePermissions(stderr, `O:SYD:P(A;;FA;;;${sid})`),
      );
      const child = new CodexProcess({
        binPath: process.execPath,
        cwd: dir,
        stdoutLogPath: join(providerDir, 'unused.log'),
        stderrLogPath: stderr,
      });
      try {
        const before = readWindowsPermissions(stderr);
        await expect(child.start()).rejects.toThrow(
          'owned by a different Windows user',
        );
        expect(readWindowsPermissions(stderr)).toEqual(before);
        // This native lock refuses any outstanding append/write descriptor.
        const release = holdWindowsReadLock(stderr);
        await release();
        expect(await readFile(stderr, 'utf8')).toBe('existing log\n');
      } finally {
        await child.reap();
        withWindowsRestorePrivilege(() =>
          setWindowsFixturePermissions(stderr, `O:${sid}D:P(A;;FA;;;${sid})`),
        );
      }
    },
  );
});
