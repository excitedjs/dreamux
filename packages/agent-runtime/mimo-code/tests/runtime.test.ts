import { describe, expect, it } from 'vitest';

import {
  createMimoCodeAgentRuntimeProvider,
  defaultMimoCodeConfig,
  type MimoClient,
  type MimoMessageInput,
  type MimoMessageResult,
  type MimoServerFactory,
  type MimoServerHandle,
} from '../src/index.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

describe('MiMo Code runtime', () => {
  it('starts and creates a checkpoint-backed MiMo session', async () => {
    const fake = new FakeMimoServerFactory();
    const state = new FakeState();
    const runtime = makeRuntime(fake, { state });

    await runtime.start();

    expect(fake.handles).toHaveLength(1);
    expect(fake.client.sessions).toHaveLength(1);
    expect(state.checkpoints).toEqual([{ id: 'session-1' }]);
    expect(runtime.getCheckpoint()).toEqual({ id: 'session-1' });
    expect(runtime.wasCheckpointResumed()).toBe(false);
    expect(runtime.getStatus()).toBe('ready');

    await runtime.stop();
    expect(fake.handles[0]?.stopped).toBe(true);
    expect(state.statuses.at(-1)?.status).toBe('stopped');
  });

  it('resumes from an existing checkpoint without creating a new session', async () => {
    const fake = new FakeMimoServerFactory();
    const state = new FakeState();
    const runtime = makeRuntime(fake, {
      state,
      checkpointId: 'existing-session',
    });

    await runtime.resume();

    expect(fake.client.sessions).toEqual([]);
    expect(runtime.getCheckpoint()).toEqual({ id: 'existing-session' });
    expect(runtime.wasCheckpointResumed()).toBe(true);
  });

  it('delivers completionInput as pure plain text and dedupes sourceId', async () => {
    const fake = new FakeMimoServerFactory();
    const settled: TurnSettledSignal[] = [];
    const runtime = makeRuntime(fake, { settled });
    await runtime.start();

    await expect(
      runtime.completionInput({
        text: '<completion><message>done</message></completion>',
        sourceId: 'completion-1',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      runtime.completionInput({ text: 'duplicate', sourceId: 'completion-1' }),
    ).resolves.toEqual({ status: 'duplicate' });
    await runtime.waitIdle?.();

    expect(fake.client.messages.map((message) => message.input.text)).toEqual([
      '<completion><message>done</message></completion>',
    ]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      status: 'completed',
      result: { text: 'echo:<completion><message>done</message></completion>' },
    });
    await expect(runtime.getLast()).resolves.toEqual({
      text: 'echo:<completion><message>done</message></completion>',
    });
  });

  it('renders channelInput through the channel envelope path', async () => {
    const fake = new FakeMimoServerFactory();
    const accepted: string[] = [];
    const runtime = makeRuntime(fake);
    await runtime.start();

    await expect(
      runtime.channelInput(
        {
          sourceId: 'msg-1',
          text: 'fallback',
          source: 'feishu',
          attrs: [['chat_id', 'chat-1']],
          body: 'hello',
        },
        {
          onAccepted: (input) => {
            accepted.push(input.sourceId);
          },
        },
      ),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      runtime.channelInput({
        sourceId: 'msg-1',
        text: 'duplicate',
      }),
    ).resolves.toEqual({ status: 'duplicate' });
    await runtime.waitIdle?.();

    expect(accepted).toEqual(['msg-1']);
    expect(fake.client.messages[0]?.input.text).toBe(
      '<channel source="feishu" chat_id="chat-1">\nhello\n</channel>',
    );
  });

  it('treats queued and MiMo-busy turns as busy until durable settlement', async () => {
    const fake = new FakeMimoServerFactory();
    fake.client.enqueueBusy();
    const settled: TurnSettledSignal[] = [];
    const runtime = makeRuntime(fake, { settled, turnTimeoutMs: 2_000 });
    await runtime.start();

    await runtime.completionInput({ text: 'first', sourceId: 'first' });
    let idle = false;
    void runtime.waitIdle?.().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    await waitFor(() => settled.length === 1);
    expect(idle).toBe(true);
    expect(fake.client.messages).toHaveLength(2);
    expect(fake.client.messages.map((message) => message.input.text)).toEqual([
      'first',
      'first',
    ]);
    expect(settled[0]?.status).toBe('completed');
  });

  it('fires onTurnSettled exactly once on failed turns', async () => {
    const fake = new FakeMimoServerFactory();
    fake.client.failNext = new Error('model failed');
    const settled: TurnSettledSignal[] = [];
    const runtime = makeRuntime(fake, { settled });
    await runtime.start();

    await runtime.completionInput({ text: 'will fail', sourceId: 'fail' });
    await runtime.waitIdle?.();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('failed');
    expect(runtime.getStatus()).toBe('degraded');
  });

  it('returns null for unsupported context snapshot', async () => {
    const fake = new FakeMimoServerFactory();
    const runtime = makeRuntime(fake);
    await expect(runtime.getContext()).resolves.toBeNull();
  });
});

function makeRuntime(
  fake: FakeMimoServerFactory,
  options: {
    state?: FakeState;
    settled?: TurnSettledSignal[];
    checkpointId?: string;
    turnTimeoutMs?: number;
  } = {},
): AgentRuntime {
  const provider = createMimoCodeAgentRuntimeProvider({
    serverFactory: fake.factory,
  });
  const state = options.state ?? new FakeState();
  const config = {
    ...defaultMimoCodeConfig(),
    turn_timeout_ms: options.turnTimeoutMs ?? 5_000,
  };
  const context: AgentRuntimeCreateContext = {
    identity: {
      runtime_id: 'runtime-1',
      checkpoint_id: options.checkpointId ?? null,
    },
    config,
    cwd: '/workspace',
    mcpServers: [{ name: 'tool', command: 'node', args: ['tool.mjs'] }],
    state,
    paths: {
      dispatcherDir: (id) => `/tmp/dreamux/${id}`,
      logsDir: () => '/tmp/dreamux/logs',
      runtimeSocketDirs: () => ['/tmp'],
    },
    onTurnSettled: (settled) => {
      options.settled?.push(settled);
    },
  };
  return provider.createRuntime(context);
}

class FakeState implements AgentRuntimeStateCallbacks {
  readonly statuses: Array<{ status: AgentRuntimeStatus; lastError: string | null }> =
    [];
  readonly checkpoints: Array<{ id: string }> = [];

  async setStatus(
    status: AgentRuntimeStatus,
    extras?: { last_error?: string | null },
  ): Promise<void> {
    this.statuses.push({ status, lastError: extras?.last_error ?? null });
  }

  async setCheckpoint(checkpoint: { id: string }): Promise<void> {
    this.checkpoints.push(checkpoint);
  }
}

class FakeMimoServerFactory {
  readonly client = new FakeMimoClient();
  readonly handles: FakeMimoServerHandle[] = [];
  readonly factory: MimoServerFactory = async (options) => {
    this.startOptions.push({
      mcpServers: options.mcpServers,
      systemPrompt: options.systemPrompt,
    });
    const handle = new FakeMimoServerHandle(this.client);
    this.handles.push(handle);
    return handle;
  };
  readonly startOptions: Array<{
    mcpServers: readonly AgentRuntimeMcpServer[];
    systemPrompt: string | null;
  }> = [];
}

class FakeMimoServerHandle implements MimoServerHandle {
  readonly homeDir = '/tmp/fake-mimo-home';
  readonly baseUrl = 'http://127.0.0.1:12345';
  readonly username = 'mimocode';
  readonly password = 'pw';
  stopped = false;

  constructor(readonly client: MimoClient) {}

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeMimoClient implements MimoClient {
  readonly sessions: unknown[] = [];
  readonly messages: Array<{ sessionId: string; input: MimoMessageInput }> = [];
  private nextBusy = 0;
  failNext: Error | null = null;

  async createSession(input: unknown): Promise<string> {
    this.sessions.push(input);
    return `session-${this.sessions.length}`;
  }

  enqueueBusy(): void {
    this.nextBusy += 1;
  }

  async sendMessage(
    sessionId: string,
    input: MimoMessageInput,
  ): Promise<MimoMessageResult> {
    this.messages.push({ sessionId, input });
    if (this.failNext !== null) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.nextBusy > 0) {
      this.nextBusy -= 1;
      const { MimoBusyError } = await import('../src/client.js');
      throw new MimoBusyError();
    }
    return { text: `echo:${input.text}` };
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 10);
    });
  }
  throw new Error('waitFor timed out');
}
