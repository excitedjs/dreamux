import { describe, expect, it } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import type { NotificationHandler } from '../src/rpc.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateCallbacks,
  RuntimeAdmission,
  RuntimeTurn,
} from '@excitedjs/dreamux-types';

describe('CodexRuntime portable output schema settlement', () => {
  it('joins concurrent starts and does not replace a ready process', async () => {
    const process = new DeferredProcess();
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => {
          processCount += 1;
          return process as never;
        },
        codexClientFactory: () => new RuntimeFakeClient() as never,
      },
    );

    const first = runtime.start();
    const second = runtime.start();
    expect(second).toBe(first);
    await waitFor(() => process.startCalls === 1);
    process.releaseStart();
    await first;
    await runtime.start();

    expect(processCount).toBe(1);
    expect(process.startCalls).toBe(1);
    await runtime.stop();
  });

  it('prevents a late process start from escaping after stop wins', async () => {
    const process = new DeferredProcess();
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => {
          processCount += 1;
          return process as never;
        },
        codexClientFactory: () => new RuntimeFakeClient() as never,
      },
    );

    const starting = runtime.start();
    const startFailure = expect(starting).rejects.toThrow(/stopping/);
    await waitFor(() => process.startCalls === 1);
    const stopping = runtime.stop();
    await stopping;
    expect(process.reapCalls).toBe(1);
    process.releaseStart();

    await startFailure;
    expect(process.reapCalls).toBe(1);
    expect(processCount).toBe(1);
    expect(runtime.getStatus()).toBe('stopped');
    await expect(runtime.start()).rejects.toThrow(/stopped/);
  });

  it('stops without waiting for a deferred pre-process doctor', async () => {
    const doctor = deferred<void>();
    let doctorCalls = 0;
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexHomeDoctor: async () => {
          doctorCalls += 1;
          await doctor.promise;
        },
        codexProcessFactory: () => {
          processCount += 1;
          return new FakeProcess() as never;
        },
        codexClientFactory: () => new RuntimeFakeClient() as never,
      },
    );

    const starting = runtime.start();
    void starting.catch(() => undefined);
    await waitFor(() => doctorCalls === 1);
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(processCount).toBe(0);

    doctor.resolve();
    await expect(starting).rejects.toThrow(/stopping/);
    expect(processCount).toBe(0);
  });

  it('closes transport and process before joining deferred client readiness', async () => {
    const process = new FakeProcess();
    const client = new DeferredReadyClient();
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => client as never,
      },
    );

    const starting = runtime.start();
    void starting.catch(() => undefined);
    await client.readyStarted;
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(client.closeCalls).toBe(1);
    expect(process.reapCalls).toBe(1);

    client.releaseReady();
    await expect(starting).rejects.toThrow(/stopping/);
  });

  it.each([
    ['initialize', undefined],
    ['skills/extraRoots/set', [{ name: 'shared', path: '/skills/shared', source: 'test' }]],
    ['thread/start', undefined],
  ] as const)(
    'stops before a deferred %s startup request resolves',
    async (blockedMethod, skillSources) => {
      const process = new FakeProcess();
      const client = new DeferredRequestClient(blockedMethod);
      const runtime = new CodexRuntime(
        { runtime_id: 'flow', checkpoint: null },
        {
          cwd: '/fake/cwd',
          state: noopState(),
          paths: PATHS,
          allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
          ...(skillSources === undefined ? {} : { skillSources }),
          codexProcessFactory: () => process as never,
          codexClientFactory: () => client as never,
        },
      );

      const starting = runtime.start();
      void starting.catch(() => undefined);
      await client.requestStarted;
      await expect(runtime.stop()).resolves.toBeUndefined();
      expect(client.closeCalls).toBe(1);
      expect(process.reapCalls).toBe(1);

      client.releaseRequest();
      await expect(starting).rejects.toThrow(/stopping/);
      expect(client.methods).not.toContain('turn/start');
    },
  );

  it('does not fall back to thread/start when stop rejects a deferred resume', async () => {
    const process = new FakeProcess();
    const client = new DeferredRequestClient('thread/resume', true);
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: { id: 'thread-existing', transcript_locator: '/fake/sessions/thread-existing.jsonl' } },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => client as never,
      },
    );

    const starting = runtime.start();
    void starting.catch(() => undefined);
    await client.requestStarted;
    await expect(runtime.stop()).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow(/stopping/);
    expect(client.methods).toEqual(['initialize', 'thread/resume']);
    expect(process.reapCalls).toBe(1);
  });

  it('does not publish a fresh association when checkpoint persistence fails', async () => {
    const process = new FakeProcess();
    const client = new DeferredRequestClient('never');
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: {
          async setStatus() {},
          async setCheckpoint() {
            throw new Error('checkpoint write failed');
          },
        },
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => client as never,
      },
    );

    await expect(runtime.start()).rejects.toThrow('checkpoint write failed');
    expect(runtime.getCheckpoint()).toBeNull();
    expect(client.methods).toEqual(['initialize', 'thread/start']);
    expect(process.reapCalls).toBe(1);
  });

  it('preserves the old association when resumed checkpoint persistence fails', async () => {
    const oldCheckpoint = {
      id: 'thread-existing',
      transcript_locator: '/fake/sessions/thread-existing.jsonl',
    };
    const process = new FakeProcess();
    const client = new DeferredRequestClient('never');
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: oldCheckpoint },
      {
        cwd: '/fake/cwd',
        state: {
          async setStatus() {},
          async setCheckpoint() {
            throw new Error('resume checkpoint write failed');
          },
        },
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => client as never,
      },
    );

    await expect(runtime.start()).rejects.toThrow(
      'resume checkpoint write failed',
    );
    expect(runtime.getCheckpoint()).toEqual(oldCheckpoint);
    expect(client.methods).toEqual(['initialize', 'thread/resume']);
    expect(process.reapCalls).toBe(1);
  });

  it('retries the final stopped state write without reaping twice', async () => {
    const process = new FakeProcess();
    let stoppedWrites = 0;
    const state: AgentRuntimeStateCallbacks = {
      async setCheckpoint() {},
      async setStatus(status) {
        if (status === 'stopped' && stoppedWrites++ === 0) {
          throw new Error('state unavailable');
        }
      },
    };
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state,
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => new RuntimeFakeClient() as never,
      },
    );
    await runtime.start();

    await expect(runtime.stop()).rejects.toThrow('state unavailable');
    expect(runtime.getStatus()).toBe('stopping');
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(process.reapCalls).toBe(1);
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('fences both input paths before the asynchronous stop write completes', async () => {
    let releaseStopping!: () => void;
    let announceStopping!: () => void;
    const stoppingWriteStarted = new Promise<void>((resolve) => {
      announceStopping = resolve;
    });
    const stoppingWrite = new Promise<void>((resolve) => {
      releaseStopping = resolve;
    });
    const state: AgentRuntimeStateCallbacks = {
      async setCheckpoint() {},
      async setStatus(status) {
        if (status === 'stopping') {
          announceStopping();
          await stoppingWrite;
        }
      },
    };
    const client = new RuntimeFakeClient();
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state,
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => new FakeProcess() as never,
        codexClientFactory: () => client as never,
      },
    );
    await runtime.start();

    const stopping = runtime.stop();
    await stoppingWriteStarted;
    await expect(runtime.channelInput({
      text: 'late channel input',
      sourceId: 'late-channel',
    })).resolves.toEqual({ status: 'stopped' });
    await expect(runtime.completionInput({
      text: 'late completion input',
    })).resolves.toEqual({ status: 'stopped' });
    expect(client.turnStartCount).toBe(0);

    releaseStopping();
    await stopping;
    await expect(runtime.channelInput({
      text: 'after stop',
      sourceId: 'after-stop',
    })).resolves.toEqual({ status: 'stopped' });
    expect(client.turnStartCount).toBe(0);
  });

  it('cleans up a failed start even when the degraded state write fails', async () => {
    const process = new FakeProcess();
    const client = new FailingReadyClient();
    const readyError = client.readyError;
    const stateError = new Error('degraded state unavailable');
    const state: AgentRuntimeStateCallbacks = {
      async setCheckpoint() {},
      async setStatus(status) {
        if (status === 'degraded') throw stateError;
      },
    };
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state,
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => process as never,
        codexClientFactory: () => client as never,
      },
    );

    const failure = await runtime.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      readyError,
      stateError,
    ]);
    expect(client.closeCalls).toBe(1);
    expect(process.reapCalls).toBe(1);
    await runtime.stop();
  });

  it('does not overwrite retained process authority after failed start cleanup', async () => {
    const process = new FailedStartProcess();
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => {
          processCount += 1;
          return process as never;
        },
        codexClientFactory: () => new RuntimeFakeClient() as never,
      },
    );

    await expect(runtime.start()).rejects.toThrow(/termination not proved/);
    expect(processCount).toBe(1);
    expect(process.reapCalls).toBe(1);
    await expect(runtime.start()).rejects.toThrow(/stopped/);
    expect(processCount).toBe(1);

    await runtime.stop();
    expect(process.reapCalls).toBe(2);
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('keeps prior Turn outcome independent when restoration fails', async () => {
    const client = new RuntimeFakeClient();
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => new FakeProcess() as never,
        codexClientFactory: () => client as never,
      },
    );

    await runtime.start();
    try {
      const plainTurn = requireSubmittedTurn(await runtime.completionInput({
        text: 'plain',
        sourceId: 'plain',
      }));
      const plainOutcome = await plainTurn.settled;

      const structuredTurn = requireSubmittedTurn(await runtime.completionInput({
        text: 'structured',
        sourceId: 'structured',
        outputSchema: {
          type: 'object',
          properties: {
            values: { type: 'array', items: { type: 'string' } },
          },
          required: ['values'],
          additionalProperties: false,
        },
      }));
      const structuredOutcome = await structuredTurn.settled;

      expect(plainOutcome).toEqual({
        status: 'completed',
        resultText: 'plain result',
        truncated: false,
      });
      expect(structuredOutcome).toMatchObject({
        status: 'failed',
        error: expect.objectContaining({
          message: expect.stringContaining('$.values: expected array'),
        }),
      });
    } finally {
      await runtime.stop();
    }
  });

  it('discards the old codec across websocket restart and drops late completion', async () => {
    const firstClient = new RuntimeFakeClient({ autoComplete: false });
    const secondClient = new RuntimeFakeClient();
    const clients = [firstClient, secondClient];
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => new FakeProcess() as never,
        codexClientFactory: () => {
          const client = clients.shift();
          if (client === undefined) throw new Error('no fake client');
          return client as never;
        },
        restartBackoffBaseMs: 0,
        restartBackoffMaxMs: 0,
      },
    );

    await runtime.start();
    try {
      const oldTurn = requireSubmittedTurn(await runtime.completionInput({
        text: 'old structured turn',
        outputSchema: {
          type: 'object',
          properties: { optional: { type: 'string' } },
          additionalProperties: false,
        },
      }));
      firstClient.emitClose(new Error('restart requested'));
      await waitFor(() => runtime.getStatus() === 'ready' && clients.length === 0);

      await expect(oldTurn.settled).resolves.toEqual({ status: 'stopped' });
      firstClient.emitCompleted('thread-1', 'turn-1', '{"optional":null}');
      await new Promise((resolve) => setImmediate(resolve));

      const newTurn = requireSubmittedTurn(
        await runtime.completionInput({ text: 'new plain turn' }),
      );
      await expect(newTurn.settled).resolves.toEqual({
        status: 'completed',
        resultText: 'plain result',
        truncated: false,
      });
    } finally {
      await runtime.stop();
    }
  });

  it('tears down a deferred replacement before joining restart startup', async () => {
    const firstClient = new RuntimeFakeClient({ autoComplete: false });
    const replacementClient = new DeferredReadyClient();
    const clients = [firstClient, replacementClient];
    const processes = [new FakeProcess(), new FakeProcess()];
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => {
          const process = processes[processCount++];
          if (process === undefined) throw new Error('unexpected replacement process');
          return process as never;
        },
        codexClientFactory: () => {
          const client = clients.shift();
          if (client === undefined) throw new Error('unexpected replacement client');
          return client as never;
        },
        restartBackoffBaseMs: 0,
        restartBackoffMaxMs: 0,
      },
    );

    await runtime.start();
    firstClient.emitClose(new Error('restart requested'));
    await replacementClient.readyStarted;

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(replacementClient.closeCalls).toBe(1);
    expect(processes.map((process) => process.reapCalls)).toEqual([1, 1]);
    expect(processCount).toBe(2);

    replacementClient.releaseReady();
    await new Promise((resolve) => setImmediate(resolve));
    expect(processCount).toBe(2);
    expect(runtime.getStatus()).toBe('stopped');
  });

  it('retries retained process termination after a background restart failure', async () => {
    const firstClient = new RuntimeFakeClient({ autoComplete: false });
    const failedClient = new FailingReadyClient();
    const recoveredClient = new RuntimeFakeClient();
    const clients = [firstClient, failedClient, recoveredClient];
    const firstProcess = new FakeProcess();
    const retainedProcess = new FailOnceReapProcess();
    const recoveredProcess = new FakeProcess();
    const processes = [firstProcess, retainedProcess, recoveredProcess];
    let processCount = 0;
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        validateTranscriptPath: async (path) => path,
        codexProcessFactory: () => {
          const process = processes[processCount];
          processCount += 1;
          if (process === undefined) throw new Error('no fake process');
          return process as never;
        },
        codexClientFactory: () => {
          const client = clients.shift();
          if (client === undefined) throw new Error('no fake client');
          return client as never;
        },
        restartBackoffBaseMs: 0,
        restartBackoffMaxMs: 0,
      },
    );

    await runtime.start();
    firstClient.emitClose(new Error('restart requested'));
    await waitFor(() => processCount === 3 && runtime.getStatus() === 'ready');

    expect(retainedProcess.reapCalls).toBe(2);
    expect(failedClient.closeCalls).toBe(1);
    await runtime.stop();
    expect(recoveredProcess.reapCalls).toBe(1);
  });
});

function requireSubmittedTurn(admission: RuntimeAdmission): RuntimeTurn {
  if (admission.status !== 'submitted') {
    throw new Error(`expected submitted admission, got ${admission.status}`);
  }
  return admission.turn;
}

class RuntimeFakeClient {
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers: Array<(reason: Error) => void> = [];
  private nextTurnId = 1;
  turnStartCount = 0;

  constructor(
    private readonly options: { autoComplete?: boolean } = {},
  ) {}

  onClose(handler: (reason: Error) => void): void {
    this.closeHandlers.push(handler);
  }
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }
  setServerRequestHandler(): void {}
  async ready(): Promise<void> {}
  close(): void {}
  notify(): void {}

  async request<R>(method: string, params: unknown): Promise<R> {
    if (method === 'initialize') {
      return {
        userAgent: 'fake/0.147.0',
        codexHome: '/fake/home',
        platformFamily: 'unix',
        platformOs: 'Linux',
      } as R;
    }
    if (method === 'thread/start') {
      return {
        thread: {
          id: 'thread-1',
          path: '/fake/sessions/thread-1.jsonl',
        },
      } as R;
    }
    if (method === 'thread/resume') {
      const threadId = (params as { threadId: string }).threadId;
      return {
        thread: {
          id: threadId,
          path: `/fake/sessions/${threadId}.jsonl`,
        },
      } as R;
    }
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);

    this.turnStartCount += 1;
    const turnId = `turn-${this.nextTurnId++}`;
    const input = params as {
      threadId: string;
      input: Array<{ text: string }>;
      outputSchema?: Record<string, unknown>;
    };
    const result = input.outputSchema === undefined
      ? 'plain result'
      : '{"values":{}}';
    if (this.options.autoComplete !== false) {
      queueMicrotask(() => this.emitCompleted(input.threadId, turnId, result));
    }
    return { turn: { id: turnId } } as R;
  }

  emitClose(reason: Error): void {
    for (const handler of this.closeHandlers) handler(reason);
  }

  emitCompleted(threadId: string, turnId: string, text: string): void {
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: 'agentMessage', id: `item-${turnId}`, text },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [] },
      },
    });
  }

  private emit(notification: Parameters<NotificationHandler>[0]): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class FailingReadyClient extends RuntimeFakeClient {
  readonly readyError = new Error('client ready failed');
  closeCalls = 0;

  override async ready(): Promise<void> {
    throw this.readyError;
  }

  override close(): void {
    this.closeCalls += 1;
  }
}

class DeferredReadyClient extends RuntimeFakeClient {
  readonly readyStarted: Promise<void>;
  closeCalls = 0;
  private announceReady!: () => void;
  private release!: () => void;

  constructor() {
    super();
    this.readyStarted = new Promise<void>((resolve) => {
      this.announceReady = resolve;
    });
  }

  override async ready(): Promise<void> {
    this.announceReady();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  override close(): void {
    this.closeCalls += 1;
  }

  releaseReady(): void {
    this.release();
  }
}

class DeferredRequestClient extends RuntimeFakeClient {
  readonly methods: string[] = [];
  readonly requestStarted: Promise<void>;
  closeCalls = 0;
  private announceRequest!: () => void;
  private release!: () => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly blockedMethod: string,
    private readonly rejectOnClose = false,
  ) {
    super();
    this.requestStarted = new Promise<void>((resolve) => {
      this.announceRequest = resolve;
    });
  }

  override request<R>(method: string, params: unknown): Promise<R> {
    this.methods.push(method);
    if (method !== this.blockedMethod) return super.request(method, params);
    this.announceRequest();
    return new Promise<R>((resolve, reject) => {
      this.reject = reject;
      this.release = () => {
        if (method === 'initialize') {
          resolve({
            userAgent: 'fake/0.147.0',
            codexHome: '/fake/home',
            platformFamily: 'unix',
            platformOs: 'Linux',
          } as R);
          return;
        }
        if (method === 'thread/start') {
          resolve({
            thread: {
              id: 'thread-1',
              path: '/fake/sessions/thread-1.jsonl',
            },
          } as R);
          return;
        }
        if (method === 'thread/resume') {
          resolve({
            thread: {
              id: 'thread-existing',
              path: '/fake/sessions/thread-existing.jsonl',
            },
          } as R);
          return;
        }
        resolve({} as R);
      };
    });
  }

  override close(): void {
    this.closeCalls += 1;
    if (this.rejectOnClose) this.reject(new Error('transport closed'));
  }

  releaseRequest(): void {
    this.release();
  }
}

class FakeProcess {
  reapCalls = 0;
  onExit(): void {}
  async start(): Promise<void> {}
  async reap(): Promise<void> {
    this.reapCalls += 1;
  }
}

class DeferredProcess extends FakeProcess {
  startCalls = 0;
  private release: (() => void) | null = null;

  override async start(): Promise<void> {
    this.startCalls += 1;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseStart(): void {
    this.release?.();
  }
}

class FailedStartProcess extends FakeProcess {
  override async start(): Promise<void> {
    throw new Error('spawn failed');
  }

  override async reap(): Promise<void> {
    this.reapCalls += 1;
    if (this.reapCalls === 1) throw new Error('termination not proved');
  }
}

class FailOnceReapProcess extends FakeProcess {
  override async reap(): Promise<void> {
    this.reapCalls += 1;
    if (this.reapCalls === 1) throw new Error('termination not proved');
  }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
