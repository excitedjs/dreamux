/**
 * Opt-in live `builtin:claude-code` contract test (issue #110 PR6).
 *
 * Claude Code is not installed in CI by default, so this suite is OPT-IN: it
 * runs only when `DREAMUX_RUN_LIVE_CLAUDE_CODE=1`. That keeps the default test
 * run green without a live binary while never *silently* skipping the key
 * contract — the default path emits a loud `console.warn` saying exactly what is
 * gated and how to enable it.
 *
 * When opted in, the test FAILS LOUDLY if `claude` is missing on PATH (it does
 * not skip), then exercises two real turns over ONE resident stream-json process
 * and asserts the runtime captures a session id and reuses it across turns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  createClaudeCodeAgentRuntimeProvider,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from '../src/agent-runtime/builtin/claude-code/runtime.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const execFileAsync = promisify(execFile);

export const RUN_ENV = 'DREAMUX_RUN_LIVE_CLAUDE_CODE';

function claudeCodeProvider(
  options: Omit<ClaudeCodeAgentRuntimeProviderOptions, 'descriptor'> = {},
) {
  const registry = createBuiltinProviderRegistry();
  return createClaudeCodeAgentRuntimeProvider({
    ...options,
    descriptor: registry.resolve('builtin:claude-code'),
  });
}

async function claudeOnPath(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('claude-code live integration (opt-in)', () => {
  const runRequested = process.env[RUN_ENV] === '1';

  if (!runRequested) {
    console.warn(
      `[claude-code-live] SKIPPED. This contract is opt-in because Claude Code ` +
        `is not installed by default. Set ${RUN_ENV}=1 (with \`claude\` on PATH ` +
        `and valid auth) to run a real headless turn.`,
    );
    it.skip(`live integration skipped (set ${RUN_ENV}=1 to run)`, () => {
      /* loud skip — never a silent contract gap */
    });
    return;
  }

  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dreamux-cc-live-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('requires claude on PATH when opted in', async () => {
    const present = await claudeOnPath();
    expect(
      present,
      `claude binary not found on PATH. Install Claude Code, or unset ${RUN_ENV} to opt out (loud skip).`,
    ).toBe(true);
  });

  it('runs two real turns over one resident process and reuses the session', async () => {
    const dispatcher = testDispatcherConfig({
      id: 'live',
      runtime: {
        provider: 'builtin:claude-code',
        config: {
          bin: 'claude',
          model: null,
          // acceptEdits keeps the opt-in turn headless without fully bypassing
          // permissions on a contributor's machine.
          permission_mode: 'acceptEdits',
          extra_args: [],
          extra_env: {},
          turn_timeout_ms: 120_000,
        },
      },
    });
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('live');
    expect(row).not.toBeNull();

    const runtime = claudeCodeProvider().createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: home,
      mcpServers: [],
      log: () => {
        /* live test sink */
      },
    });

    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');

    const first = await runtime.channelInput({
      sourceId: 'live-1',
      text: 'Reply with the single word: pong',
    });
    expect(first.status).toBe('submitted');

    const deadline = Date.now() + 120_000;
    while (runtime.getThreadId() === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const sessionId = runtime.getThreadId();
    expect(sessionId).not.toBeNull();

    // Second turn over the SAME resident process: the runtime must stay ready
    // and keep the same session id (no re-spawn, no new session).
    const second = await runtime.channelInput({
      sourceId: 'live-2',
      text: 'Reply with the single word: ping',
    });
    expect(second.status).toBe('submitted');

    const deadline2 = Date.now() + 120_000;
    while (runtime.getStatus() !== 'ready' && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(runtime.getStatus()).toBe('ready');
    expect(runtime.getThreadId()).toBe(sessionId);

    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
  });
});
