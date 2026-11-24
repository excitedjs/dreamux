import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  agent,
  ndJsonStream,
  RequestError,
  type AgentConnection,
  type AgentRequestContext,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import type {
  AgentRuntimeCreateContext,
  AgentRuntimeEvent,
  AgentRuntimeStateUpdate,
  DreamuxLogger,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultAntigravityConfig,
  type AntigravityConfig,
} from '../src/config.js';
import { AcpRuntime } from '../src/acp/runtime.js';

const mock = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@excitedjs/dreamux-utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@excitedjs/dreamux-utils')>();
  return {
    ...actual,
    SupervisedChild: class {
      constructor(launch: unknown) {
        (mock.current as FakeAgy).launch = launch;
      }
      onExit(
        handler: (exit: {
          code: number | null;
          signal: NodeJS.Signals | null;
        }) => void,
      ): void {
        (mock.current as FakeAgy).onExit = handler;
      }
      onError(): void {}
      async start(): Promise<unknown> {
        return (mock.current as FakeAgy).child;
      }
      async stop(): Promise<void> {
        (mock.current as FakeAgy).close();
      }
    },
  };
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve,
    reject,
  };
}

const logger: DreamuxLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child: () => logger,
};

class FakeAgy {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly stderr = new PassThrough();
  readonly prompts: Array<{
    ctx: AgentRequestContext<PromptRequest>;
    result: ReturnType<typeof deferred<PromptResponse>>;
  }> = [];
  readonly writes: unknown[] = [];
  readonly configured: unknown[] = [];
  readonly held: Array<() => void> = [];
  holdPromptWrites = false;
  holdNew: ReturnType<typeof deferred<void>> | null = null;
  launch: unknown;
  onExit:
    | ((exit: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  sessionId = 'native-session';
  loadId: string | null = null;
  newCount = 0;
  setup: unknown;
  readonly connection: AgentConnection;
  readonly child: {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: null;
    signalCode: null;
  };

  constructor() {
    const app = agent()
      .onRequest('initialize', () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest('session/new', async ({ params }) => {
        this.newCount += 1;
        this.setup = params;
        await this.holdNew?.promise;
        return { sessionId: this.sessionId };
      })
      .onRequest('session/load', async ({ params, client }) => {
        this.setup = params;
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'replayed',
            content: { type: 'text', text: 'old' },
          },
        });
        return { sessionId: this.loadId ?? params.sessionId, _meta: {} };
      })
      .onRequest('session/prompt', (ctx) => {
        const result = deferred<PromptResponse>();
        this.prompts.push({ ctx, result });
        return result.promise;
      })
      .onRequest('session/set_config_option', ({ params }) => {
        this.configured.push(params);
        return { configOptions: [] };
      });
    this.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(this.output) as WritableStream<Uint8Array>,
        Readable.toWeb(this.input) as ReadableStream<Uint8Array>,
      ),
    );
    const stdin = new Writable({
      write: (bytes: Buffer, _encoding, done) => {
        const message = JSON.parse(bytes.toString()) as { method?: string };
        this.writes.push(message);
        this.input.write(bytes);
        if (message.method === 'session/prompt' && this.holdPromptWrites)
          this.held.push(() => done());
        else done();
      },
    });
    this.child = {
      stdin,
      stdout: this.output,
      stderr: this.stderr,
      exitCode: null,
      signalCode: null,
    };
  }

  release(): void {
    for (const callback of this.held.splice(0)) callback();
  }
  close(): void {
    this.release();
    this.connection.close();
    this.input.destroy();
    this.output.destroy();
    this.stderr.destroy();
    this.child.stdin.destroy();
  }
}

let root: string;
let peer: FakeAgy;
let runtime: AcpRuntime | null;
let events: AgentRuntimeEvent[];
let states: AgentRuntimeStateUpdate[];
let failState: string | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-acp-test-'));
  peer = new FakeAgy();
  mock.current = peer;
  events = [];
  states = [];
  failState = null;
  runtime = null;
});

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  peer.close();
  await rm(root, { recursive: true, force: true });
});

function create(
  sessionId: string | null = null,
  overrides: Partial<AntigravityConfig> = {},
  features: {
    prompt?: boolean;
    replace?: boolean;
    skillAddDir?: string | null;
  } = {},
): AcpRuntime {
  const config = {
    ...defaultAntigravityConfig(),
    transport: 'acp' as const,
    extra_env: { HOME: root },
    ...overrides,
  };
  const context: AgentRuntimeCreateContext<AntigravityConfig> = {
    identity: { runtimeId: 'runtime', sessionId },
    config,
    cwd: root,
    mcpServers: [
      {
        name: 'selected',
        command: 'example',
        args: ['--example'],
        env: { TEST_VALUE: 'public' },
      },
    ],
    skillSources: [],
    ...(features.prompt
      ? {
          systemPrompt: {
            ...(features.replace ? { replace: 'replacement-only text' } : {}),
            append: ['first fragment', 'second fragment'],
          },
        }
      : {}),
    disabledFeatures: [],
    paths: {
      cacheDir: () => root,
      logsDir: () => root,
      runtimeSocketDirs: () => [],
    },
    state: {
      async publish(update) {
        if (update.kind === failState) {
          const error = new Error('state lease revoked');
          error.name = 'AgentRuntimeStateLeaseRevokedError';
          throw error;
        }
        states.push(update);
      },
    },
    events: (event) => events.push(event),
    logger,
  };
  runtime = new AcpRuntime(context, {
    nativeLogPath: join(root, 'native.log'),
    skillAddDir: features.skillAddDir ?? null,
  });
  return runtime;
}

async function record(
  type: string,
  content: string,
  toolCalls?: unknown[],
): Promise<void> {
  const path = join(
    root,
    '.gemini',
    'antigravity-cli',
    'brain',
    peer.loadId ?? peer.sessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
  await mkdir(join(path, '..'), { recursive: true });
  await appendFile(
    path,
    `${JSON.stringify({ type, status: 'DONE', source: 'test', step_index: 0, created_at: '2026-01-01T00:00:00Z', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) })}\n`,
  );
}

async function input(text: string): Promise<void> {
  await record('USER_INPUT', `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n`);
}

async function submitted(
  promise: Promise<RuntimeAdmission>,
): Promise<Extract<RuntimeAdmission, { status: 'submitted' }>> {
  const result = await promise;
  expect(result.status).toBe('submitted');
  if (result.status !== 'submitted') throw new Error('not submitted');
  return result;
}

async function waitPrompts(count: number): Promise<void> {
  await vi.waitFor(() => expect(peer.prompts).toHaveLength(count));
}

describe('native ACP runtime', () => {
  it('publishes the native session and ready only after setup with exact selected MCP servers', async () => {
    const instance = create();
    await expect(instance.start()).resolves.toEqual({ continuity: 'fresh' });
    expect(states).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'session', sessionId: 'native-session' },
      { kind: 'status', status: 'ready' },
    ]);
    expect(peer.setup).toEqual({
      cwd: root,
      mcpServers: [
        {
          name: 'selected',
          command: 'example',
          args: ['--example'],
          env: [{ name: 'TEST_VALUE', value: 'public' }],
        },
      ],
    });
    expect(peer.launch).toMatchObject({
      kind: 'spawn',
      args: [
        'acp',
        '--stdio',
        '--dangerously-skip-permissions',
        '--log-file',
        join(root, 'native.log'),
      ],
    });
  });

  it('uses native prompt append when replacement and append coexist', async () => {
    const skillAddDir = join(root, 'cache-skills');
    const instance = create(
      null,
      {},
      { prompt: true, replace: true, skillAddDir },
    );
    await instance.start();
    expect(peer.launch).toMatchObject({
      args: [
        'acp',
        '--stdio',
        '--dangerously-skip-permissions',
        '--add-dir',
        skillAddDir,
        '--log-file',
        join(root, 'native.log'),
      ],
    });
    expect((peer.launch as { args: string[] }).args).not.toContain('--agent');
    expect(peer.setup).toMatchObject({
      _meta: {
        antigravity: {
          systemPrompt: { append: 'first fragment\n\nsecond fragment' },
        },
      },
    });
  });

  it('applies model and effort through native session options and passes configured args', async () => {
    const instance = create(null, {
      model: 'test-model',
      effort: 'high',
      extra_args: ['--public-flag'],
    });
    await instance.start();
    expect(peer.configured).toEqual([
      { sessionId: 'native-session', configId: 'model', value: 'test-model' },
      { sessionId: 'native-session', configId: 'thought_level', value: 'high' },
    ]);
    expect(peer.launch).toMatchObject({
      args: expect.arrayContaining(['--public-flag']),
    });
  });

  it('loads the exact prior ID without emitting replay, and rejects a different native ID', async () => {
    peer.loadId = 'previous';
    const instance = create('previous');
    await expect(instance.start()).resolves.toEqual({ continuity: 'resumed' });
    expect(events).toEqual([]);
    expect(peer.newCount).toBe(0);
    await instance.stop();
    peer.close();
    peer = new FakeAgy();
    peer.loadId = 'different';
    mock.current = peer;
    runtime = create('previous');
    await expect(runtime.start()).rejects.toThrow('different session');
    expect(peer.newCount).toBe(0);
  });

  it('admits at the direct write callback while its native result is still pending', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'FIRST' }));
    await waitPrompts(1);
    await input('FIRST');
    await record('PLANNER_RESPONSE', 'PUBLIC-RESULT');
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'PUBLIC-RESULT' },
    });
  });

  it('accepts a matching native terminal before the delayed stdio callback', async () => {
    const instance = create();
    await instance.start();
    peer.holdPromptWrites = true;
    const pending = instance.submit({ text: 'EARLY' });
    await waitPrompts(1);
    expect(peer.held).toHaveLength(1);
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    const admission = await submitted(pending);
    await input('EARLY');
    await record('PLANNER_RESPONSE', 'NATIVE-EARLY');
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'NATIVE-EARLY' },
    });
    peer.release();
  });

  it('accepts a matching native error response before the delayed stdio callback', async () => {
    const instance = create();
    await instance.start();
    peer.holdPromptWrites = true;
    const pending = instance.submit({ text: 'EARLY-ERROR' });
    await waitPrompts(1);
    peer.prompts[0]!.result.reject(
      new RequestError(-32603, 'native permission rejection'),
    );
    const admission = await submitted(pending);
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'failed',
      error: expect.objectContaining({ code: -32603 }),
    });
    expect(events.some((event) => event.kind === 'turn.result')).toBe(false);
    peer.release();
  });

  it.each([0, 1])(
    'folds duplicate inputs into one native response when request %s ends first',
    async (early) => {
      const instance = create();
      await instance.start();
      const a = await submitted(instance.submit({ text: 'DUPLICATE' }));
      const b = await submitted(instance.submit({ text: 'DUPLICATE' }));
      await waitPrompts(2);
      await input('DUPLICATE');
      await input('DUPLICATE');
      peer.prompts[early]!.result.resolve({ stopReason: 'end_turn' });
      await record('PLANNER_RESPONSE', 'SHARED');
      peer.prompts[1 - early]!.result.resolve({ stopReason: 'end_turn' });
      const [first, second] = await Promise.all([
        a.submission.settled,
        b.submission.settled,
      ]);
      expect(first).toEqual({
        kind: 'completion',
        completion: { status: 'completed', resultText: 'SHARED' },
      });
      expect(second).toEqual(first);
      if (first.kind === 'completion' && second.kind === 'completion')
        expect(first.completion).toBe(second.completion);
      expect(
        events.filter((event) => event.kind === 'turn.result'),
      ).toHaveLength(1);
    },
  );

  it('keeps separate groups separate when the next input follows a response', async () => {
    const instance = create();
    await instance.start();
    const a = await submitted(instance.submit({ text: 'ONE' }));
    const b = await submitted(instance.submit({ text: 'TWO' }));
    await waitPrompts(2);
    await input('ONE');
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await record('PLANNER_RESPONSE', 'ONE-RESULT');
    await input('TWO');
    await record('PLANNER_RESPONSE', 'TWO-RESULT');
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await expect(a.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'ONE-RESULT' },
    });
    await expect(b.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'TWO-RESULT' },
    });
  });

  it.each(['max_tokens', 'max_turn_requests', 'refusal'] as const)(
    'maps %s to a failed native completion',
    async (reason) => {
      const instance = create();
      await instance.start();
      const admission = await submitted(instance.submit({ text: 'FAIL' }));
      await waitPrompts(1);
      await input('FAIL');
      peer.prompts[0]!.result.resolve({ stopReason: reason });
      const result = await admission.submission.settled;
      expect(result.kind).toBe('completion');
      if (result.kind === 'completion')
        expect(result.completion).toMatchObject({
          status: 'failed',
          error: expect.objectContaining({
            message: expect.stringContaining(reason),
          }),
        });
    },
  );

  it('maps cancelled to stopped without inventing a native interruption ID', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'CANCEL' }));
    await waitPrompts(1);
    await input('CANCEL');
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    expect(
      events.some(
        (event) =>
          event.kind === 'turn.result' || event.kind === 'turn.interrupted',
      ),
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'turn.ended', status: 'interrupted' }),
    );
  });

  it('settles cancellation without a transcript input and accepts the next normal turn', async () => {
    const instance = create();
    await instance.start();
    const cancelled = await submitted(
      instance.submit({ text: 'CANCEL-BEFORE-INPUT' }),
    );
    await waitPrompts(1);
    const client = peer.prompts[0]!.ctx.client;
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'abandoned-tool',
        name: 'run_command',
        title: 'Abandoned',
        status: 'in_progress',
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'tool.call', id: 'abandoned-tool' }),
      ),
    );
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(cancelled.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    expect(events.filter((event) => event.kind === 'turn.ended')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
    expect(events.some((event) => event.kind === 'turn.result')).toBe(false);
    const next = await submitted(instance.submit({ text: 'NEXT-NORMAL' }));
    await waitPrompts(2);
    await input('NEXT-NORMAL');
    await record('PLANNER_RESPONSE', 'next answer');
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await expect(next.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'next answer' },
    });
  });

  it.each(['max_tokens', 'max_turn_requests', 'refusal'] as const)(
    'settles %s before any native input and keeps the session usable',
    async (reason) => {
      const instance = create();
      await instance.start();
      const rejected = await submitted(instance.submit({ text: 'NO-INPUT' }));
      await waitPrompts(1);
      peer.prompts[0]!.result.resolve({ stopReason: reason });
      const settled = await rejected.submission.settled;
      expect(settled.kind).toBe('completion');
      if (settled.kind !== 'completion') throw new Error('expected completion');
      expect(settled.completion).toMatchObject({
        status: 'failed',
        error: expect.objectContaining({
          message: expect.stringContaining(reason),
        }),
      });
      expect(Object.isFrozen(settled.completion)).toBe(true);
      expect(events).toContainEqual({
        kind: 'turn.result',
        completion: settled.completion,
      });
      const observed = events.find((event) => event.kind === 'turn.result');
      expect(observed?.kind === 'turn.result' && observed.completion).toBe(
        settled.completion,
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn.ended', status: 'failed' }),
      );
      const next = await submitted(instance.submit({ text: 'AFTER-FAILURE' }));
      await waitPrompts(2);
      await input('AFTER-FAILURE');
      await record('PLANNER_RESPONSE', 'recovered');
      peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
      await expect(next.submission.settled).resolves.toEqual({
        kind: 'completion',
        completion: { status: 'completed', resultText: 'recovered' },
      });
    },
  );

  it("clears a cancelled group's unfinished tool before the next turn", async () => {
    const instance = create();
    await instance.start();
    const cancelled = await submitted(
      instance.submit({ text: 'CANCEL-IN-GROUP' }),
    );
    await waitPrompts(1);
    await input('CANCEL-IN-GROUP');
    await record('PLANNER_RESPONSE', '', [{ name: 'run_command' }]);
    await peer.prompts[0]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'abandoned-group-tool',
        name: 'run_command',
        title: 'Abandoned',
        status: 'in_progress',
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'tool.call',
          id: 'abandoned-group-tool',
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(cancelled.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    const next = await submitted(instance.submit({ text: 'NEXT-AFTER-GROUP' }));
    await waitPrompts(2);
    await input('NEXT-AFTER-GROUP');
    await record('PLANNER_RESPONSE', 'next group answer');
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await expect(next.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'next group answer' },
    });
  });

  it("retains another in-flight group's running tool when one group is cancelled", async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'CANCEL-A' }));
    const second = await submitted(instance.submit({ text: 'RUNNING-B' }));
    await waitPrompts(2);
    await input('CANCEL-A');
    await record('PLANNER_RESPONSE', 'first partial');
    await input('RUNNING-B');
    await record('PLANNER_RESPONSE', 'second answer');
    await peer.prompts[1]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'running-b',
        name: 'run_command',
        title: 'Still running',
        status: 'in_progress',
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'tool.call', id: 'running-b' }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    let settled = false;
    void second.submission.settled.then(() => {
      settled = true;
    });
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    await peer.prompts[1]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'running-b',
        status: 'completed',
      },
    });
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'second answer' },
    });
  });

  it('preserves another in-flight tool when an ungrouped prompt is cancelled', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'UNGROUPED-A' }));
    const second = await submitted(instance.submit({ text: 'ACTIVE-B' }));
    await waitPrompts(2);
    await peer.prompts[1]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'active-b',
        name: 'run_command',
        title: 'Active',
        status: 'in_progress',
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'tool.call', id: 'active-b' }),
      ),
    );
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    await input('ACTIVE-B');
    await record('PLANNER_RESPONSE', 'B answer');
    let done = false;
    void second.submission.settled.then(() => {
      done = true;
    });
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(done).toBe(false);
    await peer.prompts[1]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'active-b',
        status: 'completed',
      },
    });
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'B answer' },
    });
  });

  it('answers permission callbacks immediately with an offered allow option', async () => {
    const instance = create();
    await instance.start();
    const result = await peer.connection.client.request(
      'session/request_permission',
      {
        sessionId: 'native-session',
        toolCall: { toolCallId: 'native-tool' },
        options: [
          { optionId: 'permit', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
        ],
      },
    );
    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'permit' },
    });
  });

  it('projects native identities and does not mistake context usage for cumulative tokens', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'ACTIVITY' }));
    await waitPrompts(1);
    const client = peer.prompts[0]!.ctx.client;
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'native-message',
        content: { type: 'text', text: 'visible' },
      },
    });
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'native-tool',
        title: 'Run public command',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'printf public' },
      },
    });
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-tool',
        status: 'completed',
      },
    });
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'compaction_update',
        compactionId: 'native-compaction',
        status: 'completed',
      },
    });
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: { sessionUpdate: 'usage_update', used: 123, size: 4096 },
    });
    await input('ACTIVITY');
    await record('PLANNER_RESPONSE', 'native result');
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await admission.submission.settled;
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'assistant.message',
        id: 'native-message',
        text: 'visible',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool.call',
        id: 'native-tool',
        toolName: 'run_command',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'context.compacted',
        id: 'native-compaction',
      }),
    );
    expect(events.some((event) => event.kind === 'token.usage')).toBe(false);
  });

  it('does not settle a tool-call planner record as final assistant text', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'TOOL' }));
    await waitPrompts(1);
    await peer.prompts[0]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'native-tool',
        name: 'run_command',
        title: 'Public probe',
        status: 'in_progress',
      },
    });
    await input('TOOL');
    await record('PLANNER_RESPONSE', '', [{ id: 'native-tool' }]);
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(events.some((event) => event.kind === 'turn.result')).toBe(false);
    await peer.prompts[0]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-tool',
        status: 'failed',
      },
    });
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: null },
    });
  });

  it('settles admitted work on transport loss without inventing a result', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'DISCONNECT' }));
    peer.close();
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'failed',
      error: expect.any(Error),
    });
    expect(events.some((event) => event.kind === 'turn.result')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'turn.ended', status: 'interrupted' }),
    );
  });

  it('fails all affected admissions if an already-recorded group receives a request error', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'BOUND-A' }));
    const second = await submitted(instance.submit({ text: 'BOUND-B' }));
    await waitPrompts(2);
    await input('BOUND-A');
    await input('BOUND-B');
    await new Promise((resolve) => setTimeout(resolve, 200));
    peer.prompts[1]!.result.reject(
      new RequestError(-32603, 'native request failed after input'),
    );
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'failed',
      error: expect.any(Error),
    });
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'failed',
      error: expect.any(Error),
    });
    expect(events.some((event) => event.kind === 'turn.result')).toBe(false);
  });

  it('keeps native message activities while distinct prompt groups overlap', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'MESSAGE-A' }));
    const second = await submitted(instance.submit({ text: 'MESSAGE-B' }));
    await waitPrompts(2);
    await input('MESSAGE-A');
    await record('PLANNER_RESPONSE', 'answer A');
    await input('MESSAGE-B');
    const client = peer.prompts[0]!.ctx.client;
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-A',
        content: { type: 'text', text: 'answer A' },
      },
    });
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-B',
        content: { type: 'text', text: 'answer B' },
      },
    });
    await record('PLANNER_RESPONSE', 'answer B');
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await first.submission.settled;
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await second.submission.settled;
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'assistant.message',
        id: 'message-A',
        text: 'answer A',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'assistant.message',
        id: 'message-B',
        text: 'answer B',
      }),
    );
  });

  it('does not discard a later group tool failure when the earlier group completes', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'TOOL-GROUP-A' }));
    const second = await submitted(instance.submit({ text: 'TOOL-GROUP-B' }));
    await waitPrompts(2);
    await input('TOOL-GROUP-A');
    await record('PLANNER_RESPONSE', 'answer A');
    await input('TOOL-GROUP-B');
    await record('PLANNER_RESPONSE', 'pre-tool B', [{ name: 'run_command' }]);
    const client = peer.prompts[1]!.ctx.client;
    await client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-B',
        name: 'run_command',
        title: 'B tool',
        status: 'failed',
      },
    });
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'answer A' },
    });
    peer.prompts[1]!.result.resolve({ stopReason: 'end_turn' });
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: null },
    });
  });

  it('answers interrupt once a cancelled group ends without waiting for a separate group', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'INTERRUPT-A' }));
    const second = await submitted(instance.submit({ text: 'INTERRUPT-B' }));
    await waitPrompts(2);
    await input('INTERRUPT-A');
    await record('PLANNER_RESPONSE', 'partial A');
    await input('INTERRUPT-B');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = instance.interrupt();
    peer.prompts[0]!.result.resolve({ stopReason: 'cancelled' });
    await expect(result).resolves.toEqual({ status: 'interrupted' });
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    await instance.stop();
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
  });

  it('settles a prompt rejected during a native permission request without waiting for its input record', async () => {
    const instance = create();
    await instance.start();
    const first = await submitted(instance.submit({ text: 'PERMISSION-A' }));
    const second = await submitted(instance.submit({ text: 'PERMISSION-B' }));
    await waitPrompts(2);
    peer.prompts[1]!.result.reject(
      new RequestError(
        -32603,
        'The running prompt is waiting for a permission answer',
      ),
    );
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'failed',
      error: expect.objectContaining({ code: -32603 }),
    });
    await input('PERMISSION-A');
    await peer.prompts[0]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'native-tool',
        name: 'run_command',
        title: 'Public probe',
        status: 'in_progress',
      },
    });
    await record('PLANNER_RESPONSE', 'pre-tool text', [
      { name: 'run_command' },
    ]);
    await peer.prompts[0]!.ctx.client.notify('session/update', {
      sessionId: 'native-session',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'native-tool',
        status: 'failed',
      },
    });
    peer.prompts[0]!.result.resolve({ stopReason: 'end_turn' });
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: null },
    });
    expect(events.filter((event) => event.kind === 'turn.result')).toHaveLength(
      1,
    );
  });

  it('stops a pending admitted submission and rejects later admissions', async () => {
    const instance = create();
    await instance.start();
    const admission = await submitted(instance.submit({ text: 'PENDING' }));
    await instance.stop();
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'stopped',
    });
    await expect(instance.submit({ text: 'LATE' })).resolves.toEqual({
      status: 'stopped',
    });
  });

  it('stops a child when stop races session creation', async () => {
    peer.holdNew = deferred<void>();
    const instance = create();
    const starting = instance.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(peer.newCount).toBe(1));
    await instance.stop();
    await rejected;
    await expect(instance.submit({ text: 'late' })).resolves.toEqual({
      status: 'stopped',
    });
  });

  it('fences and stops the child when the session state lease is revoked', async () => {
    failState = 'session';
    const instance = create();
    await expect(instance.start()).rejects.toThrow('state lease revoked');
    await expect(instance.submit({ text: 'late' })).resolves.toEqual({
      status: 'stopped',
    });
    await instance.stop();
  });
});
