/**
 * `ClaudeCodeRuntime` lifecycle tests, driven through the public
 * `createClaudeCodeAgentRuntimeProvider()` seam with a FAKE resident-session
 * factory (no real `claude` binary, no filesystem beyond what the fakes need —
 * `skillSources` stays empty so `materializeClaudeSkillAddDir` short-circuits
 * before touching disk).
 *
 * This is the adapter-boundary proof that:
 *  - Claude Code can only ever APPEND to its system prompt: Core's `replace`
 *    is silently dropped by the provider, never threaded through to argv;
 *  - the append fragments (and their order) are re-supplied on every spawn,
 *    fresh or `--resume`;
 *  - recovery from a non-null create-context session is continuous — a resume
 *    failure rejects `start()` loudly rather than silently becoming fresh, and
 *    `continuity` is reported correctly before any submit is admitted;
 *  - the exact Core-supplied MCP server list reaches `--mcp-config`, unchanged;
 *  - a create-time `outputSchema` is bound once, at the one spawn that serves
 *    every subsequent submit — there is no per-submit schema surface at all;
 *  - `submit()` accepts only prepared text and forwards it verbatim, with no
 *    runtime-owned rendering or native syntax injected around it;
 *  - the leased state sink sees durable writes in the documented order, and a
 *    revoked-lease rejection (by `error.name`) fences the runtime so a later
 *    submit is refused rather than silently accepted;
 *  - `stop()` converges even when a turn is stalled mid-flight, settling the
 *    stalled submission as `stopped`; a failed `start()` rolls back the
 *    partially-created session.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';

import { createClaudeCodeAgentRuntimeProvider } from '../src/provider.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
  ClaudeCodeSessionSpec,
} from '../src/supervisor.js';
import type { TurnOutcome, TurnSubmitOptions } from '../src/types.js';
import { STATE_LEASE_REVOKED_ERROR_NAME } from '@excitedjs/dreamux-utils';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeSystemPrompt,
  JsonSchema,
  RuntimeActivity,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

// ─── Fake resident session ──────────────────────────────────────────────────

interface FakeSessionBehavior {
  failStart?: (spec: ClaudeCodeSessionSpec) => Error | null | undefined;
  /** Acknowledged input with no reply until the test supplies native frames. */
  holdResult?: boolean;
  acknowledgeWrite?: (callback: (error?: Error | null) => void) => void;
  onSubmit?: (session: FakeSession, prompt: string, commandUuid: string) => void;
}

/** Fake transport and process lifecycle around the actual request owner. */
class FakeSession implements ClaudeCodeSession {
  alive = false;
  stopCalls = 0;
  onExitHandler: ((error: Error) => void) | null = null;
  readonly submits: Array<{ prompt: string; commandUuid: string }> = [];
  /** Every control request written to stdin, in order (interrupt included). */
  readonly controlRequests: Array<{ request_id: string }> = [];
  interruptCalls = 0;
  private readonly rpc: ClaudeCodeStreamRpc;

  constructor(
    readonly spec: ClaudeCodeSessionSpec,
    private readonly behavior: FakeSessionBehavior,
  ) {
    this.rpc = new ClaudeCodeStreamRpc(new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
        if (frame['type'] === 'control_request') {
          this.controlRequests.push(frame as { request_id: string });
          callback();
          return;
        }
        const message = frame as unknown as {
          uuid: string; message: { content: Array<{ text: string }> };
        };
        const prompt = message.message.content[0]!.text;
        this.submits.push({ prompt, commandUuid: message.uuid });
        if (this.behavior.acknowledgeWrite) this.behavior.acknowledgeWrite(callback);
        else callback();
        if (this.behavior.holdResult) return;
        if (this.behavior.onSubmit) this.behavior.onSubmit(this, prompt, message.uuid);
        else fireDefaultResult(this, message.uuid, { text: `echo:${prompt}` });
      },
    }), {
      sessionId: spec.sessionId,
      outputSchemaEnabled: spec.outputSchemaEnabled,
      turnTimeoutMs: spec.turnTimeoutMs,
      reapOnTimeout: (error) => this.fail(error),
      onProtocolEvent: spec.onProtocolEvent,
    });
  }

  async start(): Promise<void> {
    const error = this.behavior.failStart?.(this.spec);
    if (error) throw error;
    this.alive = true;
  }

  submit(prompt: string, options?: TurnSubmitOptions, commandUuid?: string): Promise<RuntimeAdmission> {
    return this.rpc.submit(prompt, options, commandUuid);
  }

  interrupt(reason: string): Promise<boolean> {
    this.interruptCalls += 1;
    return this.rpc.interrupt(reason);
  }

  emit(event: Record<string, unknown>): void {
    this.rpc.onStdoutChunk(`${JSON.stringify(event)}\n`);
  }

  fail(error: Error): void {
    this.alive = false;
    this.rpc.fail(error);
    this.onExitHandler?.(error);
  }

  isAlive(): boolean { return this.alive; }
  setOnExit(handler: (error: Error) => void): void { this.onExitHandler = handler; }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.alive = false;
    this.rpc.stop();
  }
}

function fireDefaultResult(
  session: FakeSession,
  commandUuid: string,
  overrides: Partial<TurnOutcome> = {},
): void {
  session.emit({ type: 'command_lifecycle', command_uuid: commandUuid, state: 'started' });
  session.emit({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1'] });
  session.emit({
    type: 'result',
    user_message_uuid: commandUuid,
    subtype: overrides.isError ? 'error_during_execution' : 'success',
    result: overrides.text ?? 'ok',
    session_id: overrides.sessionId,
    errors: overrides.errors ?? [],
    ...(session.spec.outputSchemaEnabled ? { structured_output: { ok: true } } : {}),
  });
  session.emit({ type: 'command_lifecycle', command_uuid: commandUuid, state: 'completed' });
}

function fireAssistantText(session: FakeSession, text: string): void {
  session.emit({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text }] } });
}

class Harness {
  readonly sessions: FakeSession[] = [];
  readonly stateCalls: AgentRuntimeStateUpdate[] = [];
  /** Every native turn end this runtime reported, in order. */
  readonly nativeEnds: Array<Extract<RuntimeActivity, { kind: 'turn.ended' }>> = [];
  behavior: FakeSessionBehavior = {};
  /** Set per test to make the leased state sink reject a specific update kind. */
  rejectStateKind: AgentRuntimeStateUpdate['kind'] | null = null;
  rejectStateWith: (() => Error) | null = null;

  readonly sessionFactory: ClaudeCodeSessionFactory = (spec) => {
    const session = new FakeSession(spec, this.behavior);
    this.sessions.push(session);
    return session;
  };

  readonly paths: AgentRuntimePathContext = {
    cacheDir: () => '/tmp/dreamux-claude-code-test/cache',
    logsDir: () => '/tmp/dreamux-claude-code-test/logs',
    runtimeSocketDirs: () => ['/tmp/dreamux-claude-code-test/sockets'],
  };

  readonly state: AgentRuntimeStateSink = {
    publish: async (update) => {
      this.stateCalls.push(update);
      if (this.rejectStateKind !== null && update.kind === this.rejectStateKind) {
        throw (this.rejectStateWith ?? (() => new Error('state publish failed')))();
      }
    },
  };

  context(overrides: {
    sessionId?: string | null;
    systemPrompt?: AgentRuntimeSystemPrompt;
    mcpServers?: readonly AgentRuntimeMcpServer[];
    outputSchema?: JsonSchema;
    generateSessionId?: () => string;
  } = {}): AgentRuntimeCreateContext<
    ReturnType<typeof defaultDispatcherClaudeCodeConfig>
  > {
    return {
      identity: {
        runtimeId: 'dispatcher-under-test',
        sessionId: overrides.sessionId ?? null,
      },
      config: defaultDispatcherClaudeCodeConfig(),
      cwd: '/tmp/dreamux-claude-code-test/cwd',
      ...(overrides.systemPrompt !== undefined
        ? { systemPrompt: overrides.systemPrompt }
        : {}),
      mcpServers: overrides.mcpServers ?? [],
      skillSources: [],
      disabledFeatures: [],
      ...(overrides.outputSchema !== undefined
        ? { outputSchema: overrides.outputSchema }
        : {}),
      paths: this.paths,
      state: this.state,
      activity: (activity) => {
        if (activity.kind === 'turn.ended') this.nativeEnds.push(activity);
      },
    };
  }

  async createRuntime(overrides: Parameters<Harness['context']>[0] = {}): Promise<AgentRuntime> {
    const provider = createClaudeCodeAgentRuntimeProvider({
      sessionFactory: this.sessionFactory,
      resolveBinPath: (bin) => bin,
      ...(overrides.generateSessionId !== undefined
        ? { generateSessionId: overrides.generateSessionId }
        : {}),
    });
    return provider.createRuntime(this.context(overrides));
  }
}

const runtimesToStop: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimesToStop.splice(0).map((runtime) => runtime.stop()));
});

/** Let detached state writes and exit cleanup finish before inspecting them. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function tracked(runtime: Promise<AgentRuntime>): Promise<AgentRuntime> {
  const resolved = await runtime;
  runtimesToStop.push(resolved);
  return resolved;
}

// ─── System prompt: append-only, ordered, re-supplied on every spawn ───────

describe('ClaudeCodeRuntime system prompt', () => {
  it('drops Core-supplied `replace` and threads only `append`, in order, into --append-system-prompt on a fresh spawn', async () => {
    const h = new Harness();
    const runtime = await tracked(
      h.createRuntime({
        systemPrompt: {
          replace: 'a full replacement base prompt Claude Code cannot use',
          append: ['operation-owned Workflow fragment', 'persisted TeamMate identity'],
        },
        generateSessionId: () => 'fresh-native-id',
      }),
    );
    await runtime.start();
    expect(h.sessions).toHaveLength(1);
    const args = h.sessions[0]!.spec.args;
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    const content = args[i + 1]!;
    expect(content).not.toContain('a full replacement base prompt');
    expect(content.indexOf('operation-owned Workflow fragment')).toBeLessThan(
      content.indexOf('persisted TeamMate identity'),
    );
    // Never a second, competing prompt-shaping flag.
    expect(args.filter((arg) => /system-prompt/i.test(arg))).toEqual([
      '--append-system-prompt',
    ]);
  });

  it('re-supplies the identical append content, in the identical order, on a --resume spawn', async () => {
    const h = new Harness();
    const runtime = await tracked(
      h.createRuntime({
        sessionId: 'existing-native-session',
        systemPrompt: {
          append: ['operation-owned Workflow fragment', 'persisted TeamMate identity'],
        },
      }),
    );
    await runtime.start();
    const args = h.sessions[0]!.spec.args;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('existing-native-session');
    const content = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(content.indexOf('operation-owned Workflow fragment')).toBeLessThan(
      content.indexOf('persisted TeamMate identity'),
    );
  });
});

// ─── Resume / session continuity ────────────────────────────────────────────

describe('ClaudeCodeRuntime resume/session continuity', () => {
  it('reports resumed continuity for a non-null create-context session, before any submit is admitted', async () => {
    const h = new Harness();
    const runtime = await tracked(
      h.createRuntime({ sessionId: 'existing-native-session' }),
    );
    const outcome = await runtime.start();
    expect(outcome.continuity).toBe('resumed');
  });

  it('reports fresh continuity for a null create-context session', async () => {
    const h = new Harness();
    const runtime = await tracked(
      h.createRuntime({ sessionId: null, generateSessionId: () => 'fresh-native-id' }),
    );
    const outcome = await runtime.start();
    expect(outcome.continuity).toBe('fresh');
    const args = h.sessions[0]!.spec.args;
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
  });

  it('fails start() loudly on a failed resume rather than silently starting a fresh session', async () => {
    const h = new Harness();
    h.behavior.failStart = (spec) =>
      spec.args.includes('--resume') ? new Error('native resume rejected') : null;
    const runtime = await tracked(
      h.createRuntime({ sessionId: 'existing-native-session' }),
    );
    await expect(runtime.start()).rejects.toThrow(/native resume rejected/);
    // No fallback fresh spawn was attempted: exactly the one failed attempt.
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.spec.args).toContain('--resume');
  });
});

// ─── MCP composition ─────────────────────────────────────────────────────────

describe('ClaudeCodeRuntime MCP composition', () => {
  it('launches exactly the Core-supplied MCP server list, unchanged, as native --mcp-config JSON', async () => {
    const h = new Harness();
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'dreamux-core', command: 'node', args: ['server.js'] },
    ];
    const runtime = await tracked(h.createRuntime({ mcpServers: servers }));
    await runtime.start();
    const args = h.sessions[0]!.spec.args;
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[i + 1]!)).toEqual({
      mcpServers: { 'dreamux-core': { command: 'node', args: ['server.js'] } },
    });
  });

  it('launches an empty mcpServers document when Core supplies no servers (never invents one)', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime({ mcpServers: [] }));
    await runtime.start();
    const args = h.sessions[0]!.spec.args;
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: {},
    });
  });
});

// ─── Structured output ───────────────────────────────────────────────────────

describe('ClaudeCodeRuntime structured output', () => {
  it('binds the schema once, at spawn, and reuses the same resident session for every later submit', async () => {
    const h = new Harness();
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const runtime = await tracked(h.createRuntime({ outputSchema: schema }));
    await runtime.start();
    const args = h.sessions[0]!.spec.args;
    const i = args.indexOf('--json-schema');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[i + 1]!)).toEqual(schema);

    const first = await runtime.submit({ text: 'first turn' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await expect(first.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: '{"ok":true}' },
    });
    const second = await runtime.submit({ text: 'second turn' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    await expect(second.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: '{"ok":true}' },
    });

    // AgentRuntimeSubmissionInput carries only `text` — there is no per-submit
    // schema field to change, and only one resident child ever spawned.
    expect(h.sessions).toHaveLength(1);
  });
});

// ─── submit(): prepared text only, no native rendering ──────────────────────

describe('ClaudeCodeRuntime submit contract', () => {
  it('answers idle when no resident session has reached a live child', async () => {
    const h = new Harness();
    h.behavior.failStart = () => new Error('spawn failed');
    const runtime = await tracked(h.createRuntime());
    const startFailure = expect(runtime.start()).rejects.toThrow('spawn failed');
    const admissionPromise = runtime.submit({ text: 'racing spawn' });

    // Interrupt must neither await the spawn it did not initiate nor inherit
    // its failure: with no live session there is nothing to interrupt.
    await expect(runtime.interrupt()).resolves.toEqual({ status: 'idle' });

    await admissionPromise;
    await startFailure;
  });

  it('interrupts only outstanding work and starts no session to do it', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());

    await expect(runtime.interrupt()).resolves.toEqual({ status: 'idle' });
    expect(h.sessions).toHaveLength(0);

    await runtime.start();
    // A live session with nothing outstanding is still idle: `/stop` says no
    // turn is running rather than interrupting the agent's background work.
    await expect(runtime.interrupt()).resolves.toEqual({ status: 'idle' });

    const admission = await runtime.submit({ text: 'keep working' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    const session = h.sessions[0]!;
    const interrupted = runtime.interrupt();
    await drain();
    session.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: session.controlRequests.at(-1)!.request_id,
      },
    });
    await expect(interrupted).resolves.toEqual({ status: 'interrupted' });
    expect(session.interruptCalls).toBe(2);

    await runtime.stop();
    await expect(admission.submission.settled).resolves.toEqual({ kind: 'stopped' });
  });

  it('forwards submitted text to the native turn verbatim, with no wrapping or native syntax injected', async () => {
    const h = new Harness();
    let capturedPrompt: string | null = null;
    h.behavior.onSubmit = (spec, prompt, commandUuid) => {
      capturedPrompt = prompt;
      fireDefaultResult(spec, commandUuid!, { text: 'reply' });
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const raw = 'plain text with <tool_call> looking bytes & "quotes"';
    const admission = await runtime.submit({ text: raw });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await admission.submission.settled;
    expect(capturedPrompt).toBe(raw);
  });
});

// ─── Settlement ───────────────────────────────────────────────────────────

describe('ClaudeCodeRuntime settlement', () => {
  it('settles a completed turn with the native result text', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await expect(admission.submission.settled).resolves.toEqual({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'echo:hello' },
    });
  });

  it('settles a failed turn when the native result carries an error', async () => {
    const h = new Harness();
    h.behavior.onSubmit = (spec, _prompt, commandUuid) => {
      fireDefaultResult(spec, commandUuid!, { isError: true, errors: ['native failure'], text: '' });
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    const settlement = await admission.submission.settled;
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion') {
      expect(settlement.completion.status).toBe('failed');
    }
  });

  it('settles a stalled turn as stopped when stop() is called before the native result arrives', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hangs' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await runtime.stop();
    await expect(admission.submission.settled).resolves.toEqual({ kind: 'stopped' });
  });
});

// ─── Native turn end ────────────────────────────────────────────────────────

/**
 * The provider-neutral fact Core turns into `teammate.native_turn.ended`.
 *
 * Each terminal `result` reports one native end. Several folded submissions
 * share its single end, while a steered submission that claude runs on its own
 * after answering the first gets a second `result` — and a second end — inside
 * the same session. The runtime is the only layer that can see those boundaries,
 * which is why the fact is emitted here rather than derived from settlements
 * upstream.
 */
describe('ClaudeCodeRuntime native turn end', () => {
  it('reports one completed end per native turn, not one per submission', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();

    const first = await runtime.submit({ text: 'one' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await first.submission.settled;
    await drain();
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    // A second turn is a second native turn, so a second end — the count
    // tracks native turns, and nothing else.
    const second = await runtime.submit({ text: 'two' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    await second.submission.settled;
    await drain();
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'completed']);
  });

  it('reports two ends when a steered submission gets its own result in the same resident session', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();

    const first = await runtime.submit({ text: 'one' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    const initialUuid = session.submits[0]!.commandUuid!;
    fireDefaultResult(session, initialUuid, { text: 'first answer' });
    await expect(first.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'first answer' },
    });
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    // A later input uses the same resident session after the first result.
    const second = await runtime.submit({ text: 'two' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    expect(session.submits.map((input) => input.prompt)).toEqual(['one', 'two']);
    const steeredUuid = session.submits[1]!.commandUuid!;

    // claude did not fold it: the steered command starts and is answered by a
    // result of its own, which is a second native turn in the same session.
    fireDefaultResult(session, steeredUuid, { text: 'second answer' });
    await expect(second.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'second answer' },
    });

    expect(h.nativeEnds.map((end) => end.status)).toEqual([
      'completed',
      'completed',
    ]);

    // Later microtasks do not fabricate another native end.
    await drain();
    expect(h.nativeEnds).toHaveLength(2);
  });

  it('reports one end for one result that folded a steered submission into it', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();

    const first = await runtime.submit({ text: 'one' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    const initialUuid = session.submits[0]!.commandUuid!;
    session.emit({
      type: 'command_lifecycle',
      command_uuid: initialUuid,
      state: 'started',
    });

    const second = await runtime.submit({ text: 'two' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    const steeredUuid = session.submits[1]!.commandUuid!;
    session.emit({
      type: 'command_lifecycle',
      command_uuid: steeredUuid,
      state: 'started',
    });

    // One result answers both started commands: one native turn, one end.
    session.emit({ type: 'result', subtype: 'success', result: 'one answer for both' });
    const [s1, s2] = await Promise.all([
      first.submission.settled,
      second.submission.settled,
    ]);
    expect(s1).toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'one answer for both' },
    });
    expect(s2).toEqual(s1);

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    await drain();
    expect(h.nativeEnds).toHaveLength(1);
  });

  it('reports interrupted, exactly once, when stop() ends a turn the runtime never saw finish', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hangs' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');

    await runtime.stop();
    await expect(admission.submission.settled).resolves.toEqual({ kind: 'stopped' });
    // A second stop() is idempotent and must not re-report the same end.
    await runtime.stop();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['interrupted']);
  });

  it('reports failed when transport is lost with an unanswered request', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');

    h.sessions[0]!.fail(new Error('protocol connection lost'));
    await expect(admission.submission.settled).resolves.toMatchObject({
      kind: 'failed',
      error: expect.objectContaining({ message: 'protocol connection lost' }),
    });
    await drain();
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['failed']);
  });

  it('reports failed when the native result carries an error', async () => {
    const h = new Harness();
    h.behavior.onSubmit = (spec, _prompt, commandUuid) => {
      fireDefaultResult(spec, commandUuid!, {
        isError: true,
        errors: ['native failure'],
        text: '',
      });
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await admission.submission.settled;
    await drain();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['failed']);
  });

  it('reports one end for the real lifecycle order, where `completed` follows the result', async () => {
    // A completed lifecycle frame after its result is not a second native end.
    const h = new Harness();
    h.behavior.onSubmit = (spec, _prompt, commandUuid) => {
      fireDefaultResult(spec, commandUuid!, { text: 'answered' });
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await admission.submission.settled;
    await drain();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);
  });

  it('reports the end of a native turn that has no submission left to settle', async () => {
    // The first result answered and settled the only submission; what
    // claude does next in the same session is a native turn of its own, and the
    // stop that tears it down ends it. Whether push-back had anything left to
    // settle says nothing about whether claude was working.
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'one' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    fireDefaultResult(session, session.submits[0]!.commandUuid!);
    await admission.submission.settled;
    await drain();
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    fireAssistantText(session, 'still working on something else');
    await runtime.stop();
    await drain();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'interrupted']);
  });

  it('reports failed for a native turn the run died on with nothing left to settle', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'one' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    fireDefaultResult(session, session.submits[0]!.commandUuid!);
    await admission.submission.settled;
    await drain();

    fireAssistantText(session, 'working on the queued command');
    session.fail(new Error('protocol connection lost'));
    await drain();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'failed']);
    expect(h.nativeEnds.at(-1)!.reason).toBe('protocol connection lost');
  });

  it('carries only a status and a timestamp: no submission, turn id, or presentation', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await admission.submission.settled;
    await drain();

    expect(h.nativeEnds).toHaveLength(1);
    expect(Object.keys(h.nativeEnds[0]!).sort()).toEqual([
      'kind', 'occurredAt', 'reason', 'status',
    ]);
    expect(Object.isFrozen(h.nativeEnds[0])).toBe(true);
  });
});

describe('ClaudeCodeRuntime admission and stop convergence', () => {
  it('does not report another native end when stop joins cleanup of an exited child', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    h.sessions[0]!.fail(new Error('child exited'));
    await runtime.stop();
    expect(h.nativeEnds.map((event) => event.status)).toEqual(['failed']);
  });

  it('stops input before native write when teardown wins the session await', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = runtime.submit({ text: 'not written' });
    await runtime.stop();
    await expect(admission).resolves.toEqual({ status: 'stopped' });
    expect(h.sessions[0]!.submits).toEqual([]);
  });

  it('converges both an unconfirmed write and unwritten concurrent input before stop returns', async () => {
    const h = new Harness();
    h.behavior.holdResult = true;
    let acknowledge!: (error?: Error | null) => void;
    let notifyWrite!: () => void;
    const written = new Promise<void>((resolve) => { notifyWrite = resolve; });
    h.behavior.acknowledgeWrite = (callback) => {
      acknowledge = callback;
      notifyWrite();
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const a = runtime.submit({ text: 'A' });
    const b = runtime.submit({ text: 'B' });
    await written;
    const settled: string[] = [];
    void a.then(() => settled.push('A'));
    void b.then(() => settled.push('B'));
    await runtime.stop();
    expect(settled).toEqual(['A', 'B']);
    await expect(a).resolves.toMatchObject({ status: 'ambiguous' });
    await expect(b).resolves.toEqual({ status: 'stopped' });
    acknowledge();
    await expect(runtime.submit({ text: 'late' })).resolves.toEqual({ status: 'stopped' });
    expect(h.sessions[0]!.submits.map((input) => input.prompt)).toEqual(['A']);
    expect(h.nativeEnds.map((event) => event.status)).toEqual(['interrupted']);
  });

  it('does not mark an early child exit ready, and resumes the same identity for subsequent input', async () => {
    const h = new Harness();
    h.behavior.onSubmit = (session) => session.fail(new Error('exit before write acknowledgement'));
    const runtime = await tracked(h.createRuntime({ sessionId: 'existing-native-session' }));
    await runtime.start();
    await expect(runtime.submit({ text: 'uncertain' })).resolves.toMatchObject({ status: 'ambiguous' });
    await drain();
    expect(h.stateCalls.at(-1)).toMatchObject({ kind: 'status', status: 'degraded' });
    expect(h.nativeEnds.map((event) => event.status)).toEqual(['failed']);
    h.behavior.onSubmit = undefined;
    const next = await runtime.submit({ text: 'next input' });
    if (next.status !== 'submitted') throw new Error('expected submitted');
    await expect(next.submission.settled).resolves.toMatchObject({
      kind: 'completion', completion: { status: 'completed', resultText: 'echo:next input' },
    });
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.spec.sessionId).toBe('existing-native-session');
    expect(h.sessions[1]!.spec.args).toContain('--resume');
    expect(h.stateCalls.at(-1)).toMatchObject({ kind: 'status', status: 'ready' });
  });

  it('waits for admission awaiting durable session publication and prevents its later write', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    h.sessions[0]!.fail(new Error('restart required'));
    await drain();
    let releasePublish!: () => void;
    const publication = new Promise<void>((resolve) => { releasePublish = resolve; });
    let notifyPublish!: () => void;
    const publishing = new Promise<void>((resolve) => { notifyPublish = resolve; });
    const publish = h.state.publish;
    h.state.publish = async (update) => {
      if (update.kind === 'session') {
        notifyPublish();
        await publication;
      }
      await publish(update);
    };
    const admission = runtime.submit({ text: 'waiting for persistence' });
    await publishing;
    let stopReturned = false;
    const stopping = runtime.stop().then(() => { stopReturned = true; });
    await drain();
    expect(stopReturned).toBe(false);
    expect(h.sessions[1]!.isAlive()).toBe(false);
    releasePublish();
    await stopping;
    await expect(admission).resolves.toEqual({ status: 'stopped' });
    expect(h.sessions[1]!.submits).toEqual([]);
    expect(h.stateCalls.at(-1)).toMatchObject({ kind: 'status', status: 'stopped' });
  });
});

// ─── Leased state sink ───────────────────────────────────────────────────────

describe('ClaudeCodeRuntime leased state sink', () => {
  it('publishes status/session facts in the documented order: starting, session, ready', async () => {
    const h = new Harness();
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    expect(h.stateCalls.map((update) => update.kind)).toEqual([
      'status',
      'session',
      'status',
    ]);
    expect(h.stateCalls[0]).toMatchObject({ kind: 'status', status: 'starting' });
    expect(h.stateCalls[2]).toMatchObject({ kind: 'status', status: 'ready' });
  });

  it('fences the runtime when the state sink rejects a publish by the revoked-lease error name, refusing later submits', async () => {
    const h = new Harness();
    h.rejectStateKind = 'session';
    h.rejectStateWith = () => {
      const error = new Error('lease revoked by a newer generation');
      error.name = STATE_LEASE_REVOKED_ERROR_NAME;
      return error;
    };
    const runtime = await tracked(h.createRuntime());
    await expect(runtime.start()).rejects.toThrow(/lease revoked/);
    // The fenced runtime tore its native session down rather than leaving it
    // running unobserved.
    expect(h.sessions[0]!.alive).toBe(false);
    await expect(runtime.submit({ text: 'too late' })).resolves.toEqual({
      status: 'stopped',
    });
  });

  it('surfaces an ordinary (non-lease) publish failure as a loud start() rejection too', async () => {
    const h = new Harness();
    h.rejectStateKind = 'status';
    h.rejectStateWith = () => new Error('durable write failed');
    const runtime = await tracked(h.createRuntime());
    await expect(runtime.start()).rejects.toThrow(/durable write failed/);
  });
});

// ─── Failed-start rollback ───────────────────────────────────────────────────

describe('ClaudeCodeRuntime failed-start rollback', () => {
  it('tears down the partially-created session when the native spawn fails', async () => {
    const h = new Harness();
    h.behavior.failStart = () => new Error('spawn exploded');
    const runtime = await tracked(h.createRuntime());
    await expect(runtime.start()).rejects.toThrow(/spawn exploded/);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.stopCalls).toBeGreaterThanOrEqual(1);
    // The failed start is durably recorded as degraded, not left implicit.
    expect(
      h.stateCalls.some(
        (update) => update.kind === 'status' && update.status === 'degraded',
      ),
    ).toBe(true);
  });

  it('reports no end when the stop that follows a failed start finds no child', async () => {
    // Core stops a runtime whose start failed before it revokes the generation,
    // so an end reported here would reach the card ahead of Core's own failed
    // end carrying the start error. With no child there is nothing to end.
    const h = new Harness();
    h.behavior.failStart = () => new Error('spawn exploded');
    const runtime = await tracked(h.createRuntime());
    await expect(runtime.start()).rejects.toThrow(/spawn exploded/);
    await runtime.stop();
    expect(h.nativeEnds).toEqual([]);
  });
});
