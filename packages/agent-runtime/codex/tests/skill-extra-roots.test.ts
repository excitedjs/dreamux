/**
 * Role-gated skill injection via `skills/extraRoots/set` (issue #209 slice 6).
 *
 * Drives a full CodexRuntime.start() against an in-memory fake app-server (no
 * live codex) and asserts the RPC timing, params, empty-skip, and fail-loud
 * behavior of the extra-roots application. The fake records every method in
 * order so the test can prove `skills/extraRoots/set` lands AFTER `initialize`
 * and BEFORE `thread/start`.
 */
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import { isUnsupportedRpcMethodError } from '../src/skill-roots.js';
import type {
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  AgentRuntimeStateCallbacks,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

function skillSource(path: string): AgentRuntimeSkillSource {
  return { name: path.split('/').pop()!, path, source: 'dreamux-core' };
}

class FakeClient {
  readonly methods: string[] = [];
  readonly extraRootsCalls: string[][] = [];
  readonly threadStartCalls: unknown[] = [];
  readonly threadResumeCalls: unknown[] = [];
  readonly turnStartCalls: unknown[] = [];
  threadResumeError: Error | null = null;
  private readonly handlers = new Set<(notification: unknown) => void>();
  private nextTurnId = 1;
  failExtraRoots = false;
  /** When set, `skills/extraRoots/set` rejects with this error instead. */
  extraRootsError: Error | null = null;

  onClose(): void {}
  onNotification(handler: (notification: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
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
      this.threadStartCalls.push(params);
      return {
        thread: {
          id: 'thread-fake',
          path: '/fake/sessions/thread-fake.jsonl',
        },
      } as R;
    }
    if (method === 'thread/resume') {
      this.threadResumeCalls.push(params);
      if (this.threadResumeError !== null) throw this.threadResumeError;
      const threadId = (params as { threadId: string }).threadId;
      return {
        thread: {
          id: threadId,
          path: `/fake/sessions/${threadId}.jsonl`,
        },
      } as R;
    }
    if (method === 'turn/start') {
      this.turnStartCalls.push(params);
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
  cacheDir: () => '/fake/cache',
  logsDir: () => '/fake/logs',
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
  _unusedSettlementHook?: undefined,
  systemPrompt?: AgentRuntimeSystemPrompt,
  checkpointId: string | null = null,
): CodexRuntime {
  const identity: AgentRuntimeIdentity = {
    runtime_id: 'flow',
    checkpoint:
      checkpointId === null
        ? null
        : {
            id: checkpointId,
            transcript_locator: `/fake/sessions/${checkpointId}.jsonl`,
          },
  };
  return new CodexRuntime(identity, {
    cwd: '/fake/cwd',
    state: noopState(),
    paths: PATHS,
    allocateSocketPath: () => '/fake/run/flow.sock',
    validateTranscriptPath: async (path) => path,
    skillSources,
    codexProcessFactory: () => new FakeProcess() as never,
    codexClientFactory: () => client as never,
    ...(systemPrompt?.replace !== undefined
      ? { systemPromptReplace: systemPrompt.replace }
      : {}),
    ...(systemPrompt?.replace === undefined && systemPrompt?.append !== undefined
      ? { systemPromptAppend: systemPrompt.append }
      : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
}

describe('codex skills/extraRoots/set injection', () => {
  it('sets the deduped skill roots after initialize and before thread/start', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(client, [
      skillSource('/pkg/skills/dispatcher'),
      skillSource('/pkg/skills/team-leader'),
      skillSource('/pkg/skills/dispatcher'),
    ]);

    await runtime.start();
    await runtime.stop();

    expect(client.extraRootsCalls).toEqual([
      [
        '/pkg/skills/dispatcher',
        '/pkg/skills/team-leader',
      ],
    ]);
    const initIdx = client.methods.indexOf('initialize');
    const setIdx = client.methods.indexOf('skills/extraRoots/set');
    const startIdx = client.methods.indexOf('thread/start');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(initIdx);
    expect(startIdx).toBeGreaterThan(setIdx);
  });

  it('rejects relative skill root paths instead of applying cwd-dependent roots', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(client, [
      { name: 'relative', path: 'relative/skills', source: 'test' },
    ]);

    await expect(runtime.start()).rejects.toThrow(/path must be absolute/);
    expect(client.extraRootsCalls).toEqual([]);
  });

  it('passes append-only systemPrompt as developerInstructions before first turn', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        append: [
          'Dreamux persistent identity guidance:\narchitecture reviewer',
          'Keep <review> & do not close </developer-reminder>.',
        ],
      },
    );

    await runtime.start();
    await runtime.channelInput({ sourceId: 'm1', text: 'first task' });
    await runtime.stop();

    const startIdx = client.methods.indexOf('thread/start');
    const turnIdx = client.methods.indexOf('turn/start');
    expect(turnIdx).toBeGreaterThan(startIdx);
    expect(client.methods).not.toContain('thread/inject_items');
    expect(client.threadStartCalls[0]).toEqual({
      developerInstructions:
        '<developer-reminder>\n' +
        'Dreamux persistent identity guidance:\narchitecture reviewer\n' +
        '</developer-reminder>\n\n' +
        '<developer-reminder>\n' +
        'Keep &lt;review&gt; &amp; do not close &lt;/developer-reminder&gt;.\n' +
        '</developer-reminder>',
    });
    const firstTurn = client.turnStartCalls[0] as {
      input: Array<{ text: string }>;
    };
    expect(firstTurn.input[0]?.text).toBe('first task');
    expect(firstTurn.input[0]?.text).not.toContain('architecture reviewer');
  });

  it('passes append-only systemPrompt as developerInstructions on resume', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        append: ['resume identity'],
      },
      'thread-existing',
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadStartCalls).toEqual([]);
    expect(client.threadResumeCalls).toEqual([
      {
        threadId: 'thread-existing',
        developerInstructions:
          '<developer-reminder>\nresume identity\n</developer-reminder>',
      },
    ]);
    expect(client.methods).not.toContain('thread/inject_items');
  });

  it('passes append-only systemPrompt as developerInstructions on resume fallback start', async () => {
    const client = new FakeClient();
    client.threadResumeError = new Error('resume unavailable');
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        append: ['fallback identity'],
      },
      'thread-existing',
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadResumeCalls).toEqual([
      {
        threadId: 'thread-existing',
        developerInstructions:
          '<developer-reminder>\nfallback identity\n</developer-reminder>',
      },
    ]);
    expect(client.threadStartCalls).toEqual([
      {
        developerInstructions:
          '<developer-reminder>\nfallback identity\n</developer-reminder>',
      },
    ]);
    expect(client.methods).not.toContain('thread/inject_items');
  });

  it('omits developerInstructions when append-only systemPrompt is empty after filtering', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        append: ['', ''],
      },
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadStartCalls[0]).toEqual({});
    expect(client.methods).not.toContain('thread/inject_items');
  });

  it('uses replacement baseInstructions without duplicate append injection', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        replace: 'complete dispatcher base instructions',
        append: ['dispatcher append guidance'],
      },
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadStartCalls[0]).toEqual({
      baseInstructions: 'complete dispatcher base instructions',
    });
    expect(client.methods).not.toContain('thread/inject_items');
  });

  it('passes replacement baseInstructions on resume without duplicate append injection', async () => {
    const client = new FakeClient();
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        replace: 'complete dispatcher base instructions',
        append: ['dispatcher append guidance'],
      },
      'thread-existing',
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadStartCalls).toEqual([]);
    expect(client.threadResumeCalls).toEqual([
      {
        threadId: 'thread-existing',
        baseInstructions: 'complete dispatcher base instructions',
      },
    ]);
    expect(client.methods).not.toContain('thread/inject_items');
  });

  it('passes replacement baseInstructions on resume fallback start', async () => {
    const client = new FakeClient();
    client.threadResumeError = new Error('resume unavailable');
    const runtime = buildRuntime(
      client,
      [],
      undefined,
      undefined,
      {
        replace: 'complete dispatcher base instructions',
        append: ['dispatcher append guidance'],
      },
      'thread-existing',
    );

    await runtime.start();
    await runtime.stop();

    expect(client.threadResumeCalls).toEqual([
      {
        threadId: 'thread-existing',
        baseInstructions: 'complete dispatcher base instructions',
      },
    ]);
    expect(client.threadStartCalls).toEqual([
      {
        baseInstructions: 'complete dispatcher base instructions',
      },
    ]);
    expect(client.methods).not.toContain('thread/inject_items');
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
    expect(client.extraRootsCalls).toEqual([['/pkg/skills/dispatcher']]);
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
    const runtime = buildRuntime(client, []);

    await runtime.start();
    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    if (first.status !== 'submitted') throw new Error('first Turn was not submitted');
    const firstOutcome = await first.turn.settled;
    const second = await runtime.channelInput({ sourceId: 'm2', text: 'empty' });
    if (second.status !== 'submitted') throw new Error('second Turn was not submitted');
    const secondOutcome = await second.turn.settled;
    await runtime.stop();

    expect(firstOutcome).toMatchObject({ status: 'completed', resultText: 'first' });
    expect(secondOutcome).toMatchObject({ status: 'completed', resultText: null });
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
