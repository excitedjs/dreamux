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
import { isUnsupportedRpcMethodError } from '../src/skill-roots.js';
import type {
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  DreamuxLogger,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

const SKILL_LAYOUT = 'skill-dir';

function skillSource(path: string): AgentRuntimeSkillSource {
  return { name: path.split('/').pop()!, path, layout: SKILL_LAYOUT, source: 'dreamux-core' };
}

class FakeClient {
  readonly methods: string[] = [];
  readonly extraRootsCalls: string[][] = [];
  private readonly handlers: Array<(notification: unknown) => void> = [];
  private nextTurnId = 1;
  failExtraRoots = false;
  /** When set, `skills/extraRoots/set` rejects with this error instead. */
  extraRootsError: Error | null = null;

  onClose(): void {}
  onNotification(handler: (notification: unknown) => void): void {
    this.handlers.push(handler);
  }
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
      if (this.extraRootsError !== null) {
        throw this.extraRootsError;
      }
      if (this.failExtraRoots) {
        throw new Error('codex rejected skills/extraRoots/set');
      }
      return {} as R;
    }
    if (method === 'thread/start') {
      return { thread: { id: 'thread-fake' } } as R;
    }
    if (method === 'turn/start') {
      const p = params as {
        threadId: string;
        input: Array<{ text: string }>;
      };
      const turnId = `turn-${this.nextTurnId++}`;
      const text = p.input[0]?.text ?? '';
      queueMicrotask(() => {
        this.emitCompleted(p.threadId, turnId, text === 'empty' ? null : text);
      });
      return { turn: { id: turnId } } as R;
    }
    throw new Error(`unexpected method ${method}`);
  }

  private emitCompleted(
    threadId: string,
    turnId: string,
    text: string | null,
  ): void {
    if (text !== null) {
      this.emit({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: { type: 'agentMessage', id: `item-${turnId}`, text },
        },
      });
    }
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: unknown): void {
    for (const handler of this.handlers) handler(notification);
  }
}

interface CapturedLog {
  level: 'info' | 'warn' | 'error' | 'debug' | 'trace';
  msg: string;
}

/** A DreamuxLogger that records every line so a test can assert the warning. */
function capturingLogger(sink: CapturedLog[]): DreamuxLogger {
  // Pino-shaped fields-first: the message is the 2nd arg (or the 1st when bare).
  const record =
    (level: CapturedLog['level']) =>
    (fields: Record<string, unknown> | string, msg?: string): void => {
      sink.push({ level, msg: typeof fields === 'string' ? fields : (msg ?? '') });
    };
  const logger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
    child: () => logger,
  };
  return logger as unknown as DreamuxLogger;
}

class FakeProcess {
  onExit(): void {}
  async start(): Promise<void> {}
  async reap(): Promise<void> {}
}

const PATHS: AgentRuntimePathContext = {
  dispatcherDir: (id) => join('/fake/state', id),
  logsDir: () => '/fake/logs',
  completionSpillDir: (id) => join('/fake/cache', id, 'spill'),
  runtimeSocketDirs: () => ['/fake/run/sockets'],
};

function noopState(): AgentRuntimeStateCallbacks {
  return {
    async setStatus(): Promise<void> {},
    async setCheckpoint(): Promise<void> {},
  };
}

function buildRuntime(
  client: FakeClient,
  skillSources: AgentRuntimeSkillSource[],
  logger?: DreamuxLogger,
  onTurnSettled?: (settled: TurnSettledSignal) => void,
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
    ...(onTurnSettled !== undefined ? { onTurnSettled } : {}),
    ...(logger !== undefined ? { logger } : {}),
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

  it('fails open (warns, continues) when the app-server does not implement the RPC', async () => {
    // A codex backend that predates `skills/extraRoots/set` answers with a serde
    // enum-deserialization failure of the request `method` field. That is a
    // capability/version gap, not a real failure — startup must continue
    // skill-blind instead of bricking the dispatcher (issue #209 slice 6 repair).
    const client = new FakeClient();
    client.extraRootsError = new Error(
      'Invalid request: unknown variant `skills/extraRoots/set`, expected one of `initialize`, `thread/start`, `skills/list`, `skills/config/write`, `memory/dream`',
    );
    const logs: CapturedLog[] = [];
    const runtime = buildRuntime(
      client,
      [skillSource('/pkg/skills/dispatcher')],
      capturingLogger(logs),
    );

    await expect(runtime.start()).resolves.toBeUndefined();
    await runtime.stop();

    // The RPC was attempted, then downgraded to a warning, and thread/start
    // still ran — the dispatcher comes up, just without the extra roots.
    expect(client.extraRootsCalls).toEqual([[dirname('/pkg/skills/dispatcher')]]);
    expect(client.methods).toContain('thread/start');
    const warn = logs.find((l) => l.level === 'warn');
    expect(warn?.msg).toMatch(/unsupported by this app-server; continuing skill-blind/);
    // No error was logged for a capability gap.
    expect(logs.some((l) => l.level === 'error')).toBe(false);
  });

  it('still fails loud for a real error from an existing RPC (not swallowed)', async () => {
    // The method exists but applying the roots genuinely failed (e.g. a bad
    // path / permission). This must NOT be mistaken for a capability gap.
    const client = new FakeClient();
    client.extraRootsError = new Error('failed to register extra root: permission denied');
    const runtime = buildRuntime(client, [skillSource('/pkg/skills/dispatcher')]);

    await expect(runtime.start()).rejects.toThrow(/permission denied/);
    expect(client.methods).not.toContain('thread/start');
  });

  it('does not reuse the prior successful result for a later empty successful turn', async () => {
    const client = new FakeClient();
    const settled: TurnSettledSignal[] = [];
    const runtime = buildRuntime(client, [], undefined, (s) => settled.push(s));

    await runtime.start();
    await expect(runtime.submitTurn({ sourceId: 'm1', text: 'first' })).resolves
      .toMatchObject({ status: 'submitted' });
    await waitFor(() => settled.length === 1);
    await expect(runtime.submitTurn({ sourceId: 'm2', text: 'empty' })).resolves
      .toMatchObject({ status: 'submitted' });
    await waitFor(() => settled.length === 2);
    await runtime.stop();

    expect(settled.map((s) => s.result?.text ?? null)).toEqual(['first', null]);
    await expect(runtime.getLast()).resolves.toEqual({ text: 'first' });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

describe('isUnsupportedRpcMethodError', () => {
  it('classifies capability/version-gap rejections as unsupported', () => {
    for (const msg of [
      'Invalid request: unknown variant `skills/extraRoots/set`, expected one of `initialize`',
      'Method not found',
      'unknown method skills/extraRoots/set',
      'no such method',
      'unsupported method: skills/extraRoots/set',
    ]) {
      expect(isUnsupportedRpcMethodError(new Error(msg))).toBe(true);
    }
  });

  it('does not classify real errors from an existing method as unsupported', () => {
    for (const msg of [
      'failed to register extra root: permission denied',
      'codex rejected skills/extraRoots/set',
      'invalid root path',
      'internal error',
    ]) {
      expect(isUnsupportedRpcMethodError(new Error(msg))).toBe(false);
    }
    // Non-Error inputs degrade to their string form, never throwing.
    expect(isUnsupportedRpcMethodError('method not found')).toBe(true);
    expect(isUnsupportedRpcMethodError(null)).toBe(false);
  });
});
