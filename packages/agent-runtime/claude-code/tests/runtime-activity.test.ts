import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { ClaudeCodeRuntime } from '../src/runtime.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
  ClaudeCodeSessionSpec,
  TurnOutcome,
  TurnSubmitOptions,
} from '../src/supervisor.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateCallbacks,
} from '@excitedjs/dreamux-types';

interface FakeSession extends ClaudeCodeSession {
  readonly prompts: string[];
  resolve(outcome?: TurnOutcome): void;
}

describe('ClaudeCodeRuntime activity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-claude-activity-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('waitIdle resolves after a steered channel turn without counting the steer', async () => {
    const sessions: FakeSession[] = [];
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: fakeFactory(sessions),
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();

    await expect(
      runtime.channelInput({ sourceId: 'msg-1', text: 'first' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await waitFor(() => sessions[0]?.prompts.length === 1);

    await expect(
      runtime.channelInput({ sourceId: 'msg-2', text: 'second' }),
    ).resolves.toMatchObject({ status: 'submitted' });

    let idle = false;
    void runtime.waitIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    sessions[0]!.resolve();
    await waitFor(() => idle);
  });
});

function fakeFactory(sessions: FakeSession[]): ClaudeCodeSessionFactory {
  return (spec: ClaudeCodeSessionSpec) => {
    let alive = false;
    let resolveTurn: ((outcome: TurnOutcome) => void) | null = null;
    const prompts: string[] = [];
    const session: FakeSession = {
      prompts,
      async start() {
        alive = true;
      },
      async stop() {
        alive = false;
      },
      isAlive: () => alive,
      setOnExit() {
        /* no-op */
      },
      submitTurn(prompt: string, _options?: TurnSubmitOptions) {
        prompts.push(prompt);
        return new Promise<TurnOutcome>((resolve) => {
          resolveTurn = resolve;
        });
      },
      async steerTurn(prompt: string, _options?: TurnSubmitOptions) {
        prompts.push(prompt);
      },
      resolve(outcome = okOutcome()) {
        resolveTurn?.(outcome);
        resolveTurn = null;
      },
    };
    void spec;
    sessions.push(session);
    return session;
  };
}

function okOutcome(): TurnOutcome {
  return {
    isError: false,
    text: 'done',
    sessionId: 'sess-1',
    subtype: 'success',
    errors: [],
  };
}

function state(): AgentRuntimeStateCallbacks {
  return {
    async setStatus() {
      /* no-op */
    },
    async setCheckpoint() {
      /* no-op */
    },
  };
}

function paths(root: string): AgentRuntimePathContext {
  return {
    dispatcherDir: (id) => join(root, 'state', id),
    logsDir: () => join(root, 'logs'),
    runtimeSocketDirs: () => [join(root, 'run')],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
