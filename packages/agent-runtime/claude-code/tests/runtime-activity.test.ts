import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
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
  die(): void;
}

class RpcStdin {
  writable = true;
  readonly writes: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk);
    callback?.(null);
    return true;
  }
}

class DeferredRpcStdin extends RpcStdin {
  private callback: ((error?: Error | null) => void) | null = null;

  override write(
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.writes.push(chunk);
    if (this.writes.length === 1) callback?.(null);
    else this.callback = callback ?? null;
    return true;
  }

  finish(error?: Error): void {
    const callback = this.callback;
    this.callback = null;
    callback?.(error ?? null);
  }
}

interface RpcBackedSession extends ClaudeCodeSession {
  readonly stdin: RpcStdin;
  emit(line: Record<string, unknown>): void;
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

  it('folds a pre-init follow-up into the same RuntimeTurn after capability readiness', async () => {
    let session: RpcBackedSession | null = null;
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => {
          session = rpcBackedSession();
          return session;
        },
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'completion:first',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted turn');
    await waitFor(() => session?.stdin.writes.length === 1);
    const liveSession = session;
    if (liveSession === null) throw new Error('expected resident session');

    const followPromise = runtime.completionInput({
      text: 'second',
      sourceId: 'completion:second',
    });
    let followSettled = false;
    void followPromise.finally(() => {
      followSettled = true;
    });
    await flush();
    expect(followSettled).toBe(false);
    expect(liveSession.stdin.writes).toHaveLength(1);

    liveSession.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      capabilities: ['msg_lifecycle_v1'],
    });
    const follow = await followPromise;
    expect(follow.status).toBe('submitted');
    if (follow.status !== 'submitted') throw new Error('expected submitted steer');
    expect(follow.turn).toBe(initial.turn);
    expect(liveSession.stdin.writes).toHaveLength(2);
    expect(
      JSON.parse(liveSession.stdin.writes[1] ?? '{}'),
    ).toMatchObject({ priority: 'next' });

    completeRpcCommand(liveSession, 0, 'initial result');
    completeRpcCommand(liveSession, 1, 'final result');
    await expect(initial.turn.settled).resolves.toMatchObject({
      status: 'completed',
      resultText: 'final result',
    });
    await runtime.stop();
  });

  it('returns stopped and writes no queued pre-init steer after runtime stop', async () => {
    let session: RpcBackedSession | null = null;
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => {
          session = rpcBackedSession();
          return session;
        },
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'completion:first',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted turn');
    await waitFor(() => session?.stdin.writes.length === 1);
    const liveSession = session;
    if (liveSession === null) throw new Error('expected resident session');

    const follow = runtime.completionInput({
      text: 'second',
      sourceId: 'completion:second',
    });
    await flush();
    expect(liveSession.stdin.writes).toHaveLength(1);

    const stopping = runtime.stop();
    liveSession.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      capabilities: ['msg_lifecycle_v1'],
    });
    await flush();
    expect(liveSession.stdin.writes).toHaveLength(1);
    await stopping;

    await expect(follow).resolves.toEqual({ status: 'stopped' });
    await expect(initial.turn.settled).resolves.toEqual({ status: 'stopped' });
  });

  it('shares and releases a concurrent source reservation after proven unsupported steer', async () => {
    let session: RpcBackedSession | null = null;
    const runtime = rpcRuntime(root, (created) => {
      session = created;
    });
    await runtime.start();
    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted');
    await waitFor(() => session?.stdin.writes.length === 1);
    const liveSession = session;
    if (liveSession === null) throw new Error('expected resident session');

    const first = runtime.completionInput({ text: 'follow', sourceId: 'same' });
    const concurrent = runtime.completionInput({
      text: 'follow duplicate',
      sourceId: 'same',
    });
    liveSession.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      capabilities: [],
    });

    await expect(first).resolves.toMatchObject({ status: 'failed' });
    await expect(concurrent).resolves.toMatchObject({ status: 'failed' });
    await expect(runtime.completionInput({
      text: 'safe retry',
      sourceId: 'same',
    })).resolves.toMatchObject({ status: 'failed' });
    expect(liveSession.stdin.writes).toHaveLength(1);
    await runtime.stop();
  });

  it('commits one accepted concurrent source reservation and returns one RuntimeTurn', async () => {
    let session: RpcBackedSession | null = null;
    const runtime = rpcRuntime(root, (created) => {
      session = created;
    });
    await runtime.start();
    const initial = await runtime.channelInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted');
    await waitFor(() => session?.stdin.writes.length === 1);
    const liveSession = session;
    if (liveSession === null) throw new Error('expected resident session');

    const first = runtime.channelInput({ text: 'follow', sourceId: 'same' });
    const concurrent = runtime.channelInput({
      text: 'follow duplicate',
      sourceId: 'same',
    });
    liveSession.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      capabilities: ['msg_lifecycle_v1'],
    });
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult.status).toBe('submitted');
    expect(concurrentResult.status).toBe('submitted');
    if (
      firstResult.status !== 'submitted' ||
      concurrentResult.status !== 'submitted'
    ) {
      throw new Error('expected shared submitted admission');
    }
    expect(firstResult.turn).toBe(initial.turn);
    expect(concurrentResult.turn).toBe(initial.turn);
    expect(liveSession.stdin.writes).toHaveLength(2);
    await expect(runtime.channelInput({
      text: 'accepted retry',
      sourceId: 'same',
    })).resolves.toEqual({ status: 'duplicate' });

    completeRpcCommand(liveSession, 0, 'first result');
    completeRpcCommand(liveSession, 1, 'final result');
    await initial.turn.settled;
    await runtime.stop();
  });

  it('commits a post-write ambiguous source and never writes its retry', async () => {
    const stdin = new DeferredRpcStdin();
    let session: RpcBackedSession | null = null;
    const runtime = rpcRuntime(root, (created) => {
      session = created;
    }, stdin);
    await runtime.start();
    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted');
    await waitFor(() => stdin.writes.length === 1);
    const liveSession = session;
    if (liveSession === null) throw new Error('expected resident session');
    liveSession.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      capabilities: ['msg_lifecycle_v1'],
    });

    const admission = runtime.completionInput({
      text: 'ambiguous follow',
      sourceId: 'same',
    });
    await waitFor(() => stdin.writes.length === 2);
    stdin.finish(new Error('native callback lost'));
    await expect(admission).resolves.toMatchObject({ status: 'ambiguous' });
    await expect(runtime.completionInput({
      text: 'must not retry',
      sourceId: 'same',
    })).resolves.toEqual({ status: 'duplicate' });
    expect(stdin.writes).toHaveLength(2);
    await runtime.stop();
    await expect(initial.turn.settled).resolves.toEqual({ status: 'stopped' });
  });

  it('joins concurrent starts and creates one resident session', async () => {
    const sessions: ClaudeCodeSession[] = [];
    const started = deferred<void>();
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => {
          const session = inertSession(async () => started.promise);
          sessions.push(session);
          return session;
        },
        resolveBinPath: (bin) => bin,
      },
    );

    const first = runtime.start();
    const second = runtime.start();
    expect(second).toBe(first);
    await waitFor(() => sessions.length === 1);
    started.resolve(undefined);
    await first;
    expect(runtime.getStatus()).toBe('ready');
    await runtime.stop();
  });

  it('does not publish ready or leak a session when stop wins during start', async () => {
    const started = deferred<void>();
    const stop = vi.fn(async () => undefined);
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => inertSession(async () => started.promise, stop),
        resolveBinPath: (bin) => bin,
      },
    );

    const starting = runtime.start();
    await flush();
    const stopping = runtime.stop();
    started.resolve(undefined);
    await expect(starting).rejects.toThrow(/stopped/);
    await stopping;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('does not create a replacement session for queued work after stop', async () => {
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
    sessions[0]!.die();

    const admissionPromise = runtime.channelInput({
      sourceId: 'queued',
      text: 'go',
    });
    const stopping = runtime.stop();
    const admission = await admissionPromise;
    await stopping;

    expect(sessions).toHaveLength(1);
    expect(admission).toEqual({ status: 'stopped' });
  });

  it('does not submit a queued live steer after stop wins', async () => {
    const turnOutcome = deferred<TurnOutcome>();
    const firstSteer = deferred<void>();
    const submitPrompts: string[] = [];
    const steerPrompts: string[] = [];
    let alive = false;
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => ({
          async start() {
            alive = true;
          },
          async stop() {
            alive = false;
            firstSteer.resolve(undefined);
            turnOutcome.resolve(okOutcome());
          },
          isAlive: () => alive,
          setOnExit() {
            /* no-op */
          },
          submitTurn(prompt) {
            submitPrompts.push(prompt);
            return turnOutcome.promise;
          },
          async steerTurn(prompt) {
            steerPrompts.push(prompt);
            await firstSteer.promise;
          },
        }),
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();

    const initial = await runtime.channelInput({
      sourceId: 'initial',
      text: 'initial',
    });
    if (initial.status !== 'submitted') throw new Error('expected submitted');
    await waitFor(() => submitPrompts.length === 1);
    const first = runtime.channelInput({ sourceId: 'steer-1', text: 'steer one' });
    await waitFor(() => steerPrompts.length === 1);
    const second = runtime.channelInput({ sourceId: 'steer-2', text: 'steer two' });

    await runtime.stop();
    firstSteer.resolve(undefined);
    await Promise.all([first, second]);

    expect(steerPrompts).toEqual(['steer one']);
    await expect(initial.turn.settled).resolves.toEqual({ status: 'stopped' });
  });

  it('returns a rejected promise instead of throwing when start follows stop', async () => {
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => inertSession(async () => undefined),
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();
    await runtime.stop();

    let startPromise: Promise<void> | null = null;
    expect(() => {
      startPromise = runtime.start();
    }).not.toThrow();
    await expect(startPromise).rejects.toThrow(/stopped/u);
  });

  it('clears a failed active slot so the next input can create a fresh session', async () => {
    const sessions: Array<FakeSession & { startCalls: number }> = [];
    let factoryCalls = 0;
    const runtime = new ClaudeCodeRuntime(
      { runtime_id: 'flow' },
      {
        config: defaultDispatcherClaudeCodeConfig(),
        cwd: root,
        state: state(),
        paths: paths(root),
        mcpServers: [],
        sessionFactory: () => {
          const index = factoryCalls++;
          let alive = false;
          const prompts: string[] = [];
          const session: FakeSession & { startCalls: number } = {
            prompts,
            startCalls: 0,
            async start() {
              session.startCalls += 1;
              if (index === 1) throw new Error('replacement spawn failed');
              alive = true;
            },
            async stop() {
              alive = false;
            },
            isAlive: () => alive,
            setOnExit() {
              /* no-op */
            },
            async submitTurn(prompt) {
              prompts.push(prompt);
              return okOutcome();
            },
            async steerTurn(prompt) {
              prompts.push(prompt);
            },
            resolve() {
              /* turns resolve immediately */
            },
            die() {
              alive = false;
            },
          };
          sessions.push(session);
          return session;
        },
        resolveBinPath: (bin) => bin,
      },
    );
    await runtime.start();
    sessions[0]!.die();

    const failed = await runtime.channelInput({ sourceId: 'first', text: 'first' });
    if (failed.status !== 'submitted') throw new Error('expected submitted input');
    await expect(failed.turn.settled).resolves.toMatchObject({ status: 'failed' });

    const recovered = await runtime.channelInput({ sourceId: 'second', text: 'second' });
    if (recovered.status !== 'submitted') throw new Error('expected submitted input');
    await expect(recovered.turn.settled).resolves.toMatchObject({ status: 'completed' });
    expect(sessions).toHaveLength(3);
    expect(sessions[2]!.prompts).toEqual(['second']);
    await runtime.stop();
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
        resolveTurn?.({
          isError: true,
          text: '',
          sessionId: null,
          subtype: 'stopped',
          errors: ['stopped'],
          hasStructuredOutput: false,
        });
        resolveTurn = null;
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
      die() {
        alive = false;
      },
    };
    void spec;
    sessions.push(session);
    return session;
  };
}

function rpcBackedSession(stdin: RpcStdin = new RpcStdin()): RpcBackedSession {
  const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
    turnTimeoutMs: 5_000,
    reapOnTimeout: () => undefined,
  });
  let alive = false;
  return {
    stdin,
    async start() {
      alive = true;
    },
    async stop() {
      rpc.failPending(new Error('claude resident session stopped mid-turn'));
      alive = false;
    },
    isAlive: () => alive,
    setOnExit() {
      /* no-op */
    },
    submitTurn(prompt, options) {
      return rpc.submitTurn(prompt, options);
    },
    steerTurn(prompt, options) {
      return rpc.steerTurn(prompt, options);
    },
    emit(line) {
      rpc.onStdoutChunk(`${JSON.stringify(line)}\n`);
    },
  };
}

function rpcRuntime(
  root: string,
  onSession: (session: RpcBackedSession) => void,
  stdin: RpcStdin = new RpcStdin(),
): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime(
    { runtime_id: 'flow' },
    {
      config: defaultDispatcherClaudeCodeConfig(),
      cwd: root,
      state: state(),
      paths: paths(root),
      mcpServers: [],
      sessionFactory: () => {
        const session = rpcBackedSession(stdin);
        onSession(session);
        return session;
      },
      resolveBinPath: (bin) => bin,
    },
  );
}

function completeRpcCommand(
  session: RpcBackedSession,
  writeIndex: number,
  result: string,
): void {
  const envelope = JSON.parse(session.stdin.writes[writeIndex] ?? '{}') as {
    uuid?: unknown;
  };
  if (typeof envelope.uuid !== 'string') throw new Error('missing command uuid');
  session.emit({
    type: 'system',
    subtype: 'command_lifecycle',
    command_uuid: envelope.uuid,
    state: 'completed',
  });
  session.emit({
    type: 'result',
    subtype: 'success',
    result,
    session_id: 'session-1',
  });
}

function inertSession(
  start: () => Promise<void>,
  stop: () => Promise<void> = async () => undefined,
): ClaudeCodeSession {
  let alive = false;
  return {
    async start() {
      await start();
      alive = true;
    },
    async stop() {
      await stop();
      alive = false;
    },
    isAlive: () => alive,
    setOnExit() {
      /* no-op */
    },
    async submitTurn() {
      return okOutcome();
    },
    async steerTurn() {
      /* no-op */
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function okOutcome(): TurnOutcome {
  return {
    isError: false,
    text: 'done',
    sessionId: 'sess-1',
    subtype: 'success',
    errors: [],
    hasStructuredOutput: false,
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
    cacheDir: () => join(root, 'cache'),
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
