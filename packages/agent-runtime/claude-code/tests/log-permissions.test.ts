/** Real provider startup with a synthetic CLI, without model or account access. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { createClaudeCodeAgentRuntimeProvider } from '../src/provider.js';
import { createDefaultClaudeCodeSession } from '../src/supervisor.js';

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
  let bin: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(homedir(), 'cc-log-'));
    logs = join(dir, 'logs');
    await ensureOwnerOnlyDir(logs);
    const fixture = new URL('./fixtures/logging-claude.mjs', import.meta.url);
    const script = join(dir, 'fixture.mjs');
    await writeFile(
      script,
      `#!/usr/bin/env node\nimport(${JSON.stringify(fixture.href)});\n`,
      { mode: 0o700 },
    );
    bin = script;
    if (process.platform === 'win32') {
      bin = join(dir, 'fixture.cmd');
      // Use the supported npm Node shim path, preserving literal CLI arguments.
      await writeFile(
        bin,
        '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node.exe"\r\n"%_prog%" "%dp0%\\fixture.mjs" %*\r\n',
      );
    }
  });

  afterEach(async () => {
    await runtime?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['fresh', 'existing'])(
    'protects %s provider logs before child output and preserves appended content',
    async (kind) => {
      const providerDir = join(logs, 'claude-code');
      const stderr = join(providerDir, 'agent.stderr.log');
      if (kind === 'existing') {
        await ensureOwnerOnlyDir(providerDir);
        await writeFile(stderr, 'existing log\n');
        await ensureOwnerOnlyFile(stderr);
        await makeWorldReadable(stderr, 0o644);
        await makeWorldReadable(providerDir, 0o755);
      }
      const observation = join(dir, 'observed.json');
      for (let start = 0; start < 2; start++) {
        runtime = await createClaudeCodeAgentRuntimeProvider().createRuntime({
          identity: { runtimeId: 'agent', sessionId: null },
          config: {
            ...defaultDispatcherClaudeCodeConfig(),
            bin,
            turn_timeout_ms: 5_000,
            extra_env: {
              DREAMUX_TEST_LOG_OBSERVATION: observation,
              DREAMUX_TEST_LOG_PATHS: JSON.stringify([
                [providerDir, 0o700],
                [stderr, 0o600],
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
        await runtime.start();
        const admission = await runtime.submit({ text: 'permission check' });
        expect(admission.status).toBe('submitted');
        if (admission.status !== 'submitted')
          throw new Error('expected submission');
        await expect(admission.submission.settled).resolves.toMatchObject({
          kind: 'completion',
        });
        expect(JSON.parse(await readFile(observation, 'utf8'))).toEqual([]);
        await expectOwnerOnlyPermissions(providerDir, 0o700);
        await expectOwnerOnlyPermissions(stderr, 0o600);
        await runtime.stop();
        runtime = undefined;
      }
      expect(await readFile(stderr, 'utf8')).toBe(
        (kind === 'existing' ? 'existing log\n' : '') +
          'fixture stderr\n'.repeat(2),
      );
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'closes the append handle when a foreign-owner log is refused',
    async (context) => {
      if (!isWindowsAdministrator()) context.skip();
      const providerDir = join(logs, 'claude-code');
      await ensureOwnerOnlyDir(providerDir);
      const stderr = join(providerDir, 'foreign.stderr.log');
      await writeFile(stderr, 'existing log\n');
      const sid = currentWindowsUserSid();
      withWindowsRestorePrivilege(() =>
        setWindowsFixturePermissions(stderr, `O:SYD:P(A;;FA;;;${sid})`),
      );
      const session = createDefaultClaudeCodeSession({
        bin,
        args: [],
        cwd: dir,
        env: process.env,
        stderrLogPath: stderr,
        sessionId: 'fixture',
        turnTimeoutMs: 5_000,
        remoteControl: false,
        results: () => undefined,
      });
      try {
        const before = readWindowsPermissions(stderr);
        await expect(session.start()).rejects.toThrow(
          'owned by a different Windows user',
        );
        expect(readWindowsPermissions(stderr)).toEqual(before);
        // This native lock refuses any outstanding append/write descriptor.
        const release = holdWindowsReadLock(stderr);
        await release();
        expect(await readFile(stderr, 'utf8')).toBe('existing log\n');
      } finally {
        await session.stop();
        withWindowsRestorePrivilege(() =>
          setWindowsFixturePermissions(stderr, `O:${sid}D:P(A;;FA;;;${sid})`),
        );
      }
    },
  );
});
