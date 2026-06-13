/**
 * Role-gated skill injection via `skills/extraRoots/set` (issue #209 slice 6).
 *
 * Drives a full CodexRuntime.start() against an in-memory fake app-server (no
 * live codex) and asserts the RPC timing, params, empty-skip, and fail-loud
 * behavior of the extra-roots application. The fake records every method in
 * order so the test can prove `skills/extraRoots/set` lands AFTER `initialize`
 * and BEFORE `thread/start`.
 */
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import type {
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
} from '@excitedjs/dreamux-types';

const SKILL_LAYOUT = 'skill-dir';

function skillSource(path: string): AgentRuntimeSkillSource {
  return { name: path.split('/').pop()!, path, layout: SKILL_LAYOUT, source: 'dreamux-core' };
}

class FakeClient {
  readonly methods: string[] = [];
  readonly extraRootsCalls: string[][] = [];
  failExtraRoots = false;

  onClose(): void {}
  onNotification(): void {}
  setServerRequestHandler(): void {}
  async ready(): Promise<void> {}
  close(): void {}
  notify(): void {}

  async request<R>(method: string, params: unknown): Promise<R> {
    this.methods.push(method);
    if (method === 'initialize') {
      return {
        userAgent: 'fake/0.137.0',
        codexHome: '/fake/home',
        platformFamily: 'unix',
        platformOs: 'Linux',
      } as R;
    }
    if (method === 'skills/extraRoots/set') {
      this.extraRootsCalls.push((params as { extraRoots: string[] }).extraRoots);
      if (this.failExtraRoots) {
        throw new Error('codex rejected skills/extraRoots/set');
      }
      return {} as R;
    }
    if (method === 'thread/start') {
      return { thread: { id: 'thread-fake' } } as R;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

class FakeProcess {
  onExit(): void {}
  async start(): Promise<void> {}
  async reap(): Promise<void> {}
}

const PATHS: AgentRuntimePathContext = {
  dispatcherDir: (id) => join('/fake/state', id),
  stdoutLogPath: (id) => join('/fake/logs', `${id}.out.log`),
  stderrLogPath: (id) => join('/fake/logs', `${id}.err.log`),
  completionSpillDir: (id) => join('/fake/cache', id, 'spill'),
};

function noopState(): AgentRuntimeStateCallbacks {
  return {
    async setStatus(): Promise<void> {},
    async setThreadId(): Promise<void> {},
  };
}

function buildRuntime(
  client: FakeClient,
  skillSources: AgentRuntimeSkillSource[],
): CodexRuntime {
  const identity: AgentRuntimeIdentity = { runtime_id: 'flow', checkpoint_id: null };
  return new CodexRuntime(identity, {
    cwd: '/fake/cwd',
    state: noopState(),
    paths: PATHS,
    allocateSocketPath: () => '/fake/run/flow.sock',
    skillSources,
    codexProcessFactory: () => new FakeProcess() as never,
    codexClientFactory: () => client as never,
  });
}

describe('codex skills/extraRoots/set injection', () => {
  it('sets the deduped parent roots after initialize and before thread/start', async () => {
    const client = new FakeClient();
    // Two skills sharing one parent dir → exactly one deduped extra root.
    const runtime = buildRuntime(client, [
      skillSource('/pkg/skills/dispatcher'),
      skillSource('/pkg/skills/team-dev-workflow'),
    ]);

    await runtime.start();
    await runtime.stop();

    expect(client.extraRootsCalls).toEqual([[dirname('/pkg/skills/dispatcher')]]);
    const initIdx = client.methods.indexOf('initialize');
    const setIdx = client.methods.indexOf('skills/extraRoots/set');
    const startIdx = client.methods.indexOf('thread/start');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(initIdx);
    expect(startIdx).toBeGreaterThan(setIdx);
  });

  it('skips the RPC entirely when no skill sources are supplied', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(client, []);

    await runtime.start();
    await runtime.stop();

    expect(client.methods).not.toContain('skills/extraRoots/set');
    expect(client.extraRootsCalls).toEqual([]);
  });

  it('fails the start loud when the app-server rejects the set, before thread/start', async () => {
    const client = new FakeClient();
    client.failExtraRoots = true;
    const runtime = buildRuntime(client, [skillSource('/pkg/skills/dispatcher')]);

    await expect(runtime.start()).rejects.toThrow(/extraRoots/);
    // The failure happens before any thread is started.
    expect(client.methods).not.toContain('thread/start');
  });
});
