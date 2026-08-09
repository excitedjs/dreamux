import { describe, expect, it } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import type { NotificationHandler } from '../src/rpc.js';
import type {
  AgentRuntimePathContext,
  AgentRuntimeStateCallbacks,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

describe('CodexRuntime portable output schema settlement', () => {
  it('preserves lastResult and emits failed settlement when restoration fails', async () => {
    const client = new RuntimeFakeClient();
    const settled: TurnSettledSignal[] = [];
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint_id: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        codexProcessFactory: () => new FakeProcess() as never,
        codexClientFactory: () => client as never,
        onTurnSettled: (signal) => settled.push(signal),
      },
    );

    await runtime.start();
    try {
      await expect(runtime.completionInput({
        text: 'plain',
        sourceId: 'plain',
      })).resolves.toMatchObject({ status: 'submitted' });
      await waitFor(() => settled.length === 1);
      expect(await runtime.getLast()).toEqual({ text: 'plain result' });

      await expect(runtime.completionInput({
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
      })).resolves.toMatchObject({ status: 'submitted' });
      await waitFor(() => settled.length === 2);

      expect(await runtime.getLast()).toEqual({ text: 'plain result' });
      expect(settled).toEqual([
        {
          turnId: 'turn-1',
          status: 'completed',
          result: { text: 'plain result' },
        },
        {
          turnId: 'turn-2',
          status: 'failed',
          result: { text: null },
          error: expect.objectContaining({
            message: expect.stringContaining('$.values: expected array'),
          }),
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it('discards the old codec across websocket restart and drops late completion', async () => {
    const firstClient = new RuntimeFakeClient({ autoComplete: false });
    const secondClient = new RuntimeFakeClient();
    const clients = [firstClient, secondClient];
    const settled: TurnSettledSignal[] = [];
    const runtime = new CodexRuntime(
      { runtime_id: 'flow', checkpoint_id: null },
      {
        cwd: '/fake/cwd',
        state: noopState(),
        paths: PATHS,
        allocateSocketPath: () => '/fake/run/flow.sock',
        codexProcessFactory: () => new FakeProcess() as never,
        codexClientFactory: () => {
          const client = clients.shift();
          if (client === undefined) throw new Error('no fake client');
          return client as never;
        },
        onTurnSettled: (signal) => settled.push(signal),
        restartBackoffBaseMs: 0,
        restartBackoffMaxMs: 0,
      },
    );

    await runtime.start();
    try {
      await runtime.completionInput({
        text: 'old structured turn',
        outputSchema: {
          type: 'object',
          properties: { optional: { type: 'string' } },
          additionalProperties: false,
        },
      });
      firstClient.emitClose(new Error('restart requested'));
      await waitFor(() => runtime.getStatus() === 'ready' && clients.length === 0);

      expect(settled).toEqual([
        { turnId: 'turn-1', status: 'stopped', result: { text: null } },
      ]);
      firstClient.emitCompleted('thread-1', 'turn-1', '{"optional":null}');
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toHaveLength(1);

      await runtime.completionInput({ text: 'new plain turn' });
      await waitFor(() => settled.length === 2);
      expect(settled[1]).toEqual({
        turnId: 'turn-1',
        status: 'completed',
        result: { text: 'plain result' },
      });
      expect(await runtime.getLast()).toEqual({ text: 'plain result' });
    } finally {
      await runtime.stop();
    }
  });
});

class RuntimeFakeClient {
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers: Array<(reason: Error) => void> = [];
  private nextTurnId = 1;

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
      return { thread: { id: 'thread-1' } } as R;
    }
    if (method === 'thread/resume') {
      return {
        thread: { id: (params as { threadId: string }).threadId },
      } as R;
    }
    if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);

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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
