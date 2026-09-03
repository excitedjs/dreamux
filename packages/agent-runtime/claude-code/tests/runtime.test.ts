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

import { createClaudeCodeAgentRuntimeProvider } from '../src/provider.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
  ClaudeCodeSessionSpec,
} from '../src/supervisor.js';
import type { ClaudeProtocolEvent, TurnSubmitOptions } from '../src/types.js';
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
} from '@excitedjs/dreamux-types';

// ─── Fake resident session ──────────────────────────────────────────────────

interface FakeSessionBehavior {
  /** Return an Error to make `start()` reject for this spec; null/undefined to succeed. */
  failStart?: (spec: ClaudeCodeSessionSpec) => Error | null | undefined;
  /** Never settle `submitTurn` until `stop()` rejects it — models a stalled turn. */
  stallSubmit?: boolean;
  /**
   * Keep `submitTurn` pending until the test calls `releaseSubmit()`.
   *
   * This is the resident execution window staying open, which is what lets a
   * test steer into it and drive more than one native `result` boundary through
   * the one window — the real multi-boundary shape.
   */
  holdSubmit?: boolean;
  /** Fully custom submitTurn behavior (overrides the default echo+result). */
  onSubmit?: (
    spec: ClaudeCodeSessionSpec,
    prompt: string,
    commandUuid: string | undefined,
  ) => void;
}

class FakeSession implements ClaudeCodeSession {
  alive = false;
  stopCalls = 0;
  onExitHandler: (() => void) | null = null;
  /** Every initial command written into this session, in order. */
  readonly submits: Array<{ prompt: string; commandUuid: string | undefined }> = [];
  /** Every live steer written into the open window, in order. */
  readonly steers: Array<{ prompt: string; commandUuid: string | undefined }> = [];
  private pendingSubmit: { reject: (error: Error) => void } | null = null;
  private heldSubmit: { resolve: () => void } | null = null;

  constructor(
    readonly spec: ClaudeCodeSessionSpec,
    private readonly behavior: FakeSessionBehavior,
  ) {}

  async start(): Promise<void> {
    const err = this.behavior.failStart?.(this.spec);
    if (err) throw err;
    this.alive = true;
  }

  async submitTurn(
    prompt: string,
    _options: TurnSubmitOptions = {},
    commandUuid?: string,
  ): Promise<void> {
    this.submits.push({ prompt, commandUuid });
    if (this.behavior.stallSubmit === true) {
      await new Promise<void>((_resolve, reject) => {
        this.pendingSubmit = { reject };
      });
      return;
    }
    if (this.behavior.holdSubmit === true) {
      await new Promise<void>((resolve, reject) => {
        this.heldSubmit = { resolve };
        this.pendingSubmit = { reject };
      });
      return;
    }
    if (this.behavior.onSubmit) {
      this.behavior.onSubmit(this.spec, prompt, commandUuid);
      return;
    }
    if (commandUuid !== undefined) {
      this.spec.onProtocolEvent?.({
        kind: 'command_lifecycle',
        commandUuid,
        state: 'started',
      });
    }
    this.spec.onProtocolEvent?.({
      kind: 'result',
      outcome: {
        isError: false,
        text: `echo:${prompt}`,
        sessionId: null,
        subtype: 'success',
        errors: [],
        hasStructuredOutput: false,
      },
    });
  }

  /** Kill the held resident window the way a lost child does. */
  failSubmit(error: Error): void {
    const pending = this.pendingSubmit;
    this.pendingSubmit = null;
    this.heldSubmit = null;
    pending?.reject(error);
  }

  /** Drain the held resident window, as the real RPC does once it settles. */
  releaseSubmit(): void {
    const held = this.heldSubmit;
    this.heldSubmit = null;
    this.pendingSubmit = null;
    held?.resolve();
  }

  async steerTurn(
    prompt: string,
    _options: TurnSubmitOptions = {},
    commandUuid?: string,
  ): Promise<void> {
    // Admission only: the caller decides what the CLI then does with it, which
    // is what a live steer's outcome actually depends on. End-to-end steering
    // against the real RPC is covered in session.test.ts.
    this.steers.push({ prompt, commandUuid });
  }

  isAlive(): boolean {
    return this.alive;
  }

  setOnExit(handler: () => void): void {
    this.onExitHandler = handler;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.alive = false;
    // A real resident child dies under stop(): anything still awaiting its
    // native completion must settle instead of hanging the caller forever.
    this.pendingSubmit?.reject(new Error('claude-code session stopped mid-turn'));
    this.pendingSubmit = null;
  }
}

/** Emits a `command_lifecycle` + `result` pair through a live spec, from a test. */
function fireDefaultResult(
  spec: ClaudeCodeSessionSpec,
  commandUuid: string,
  overrides: Partial<Extract<ClaudeProtocolEvent, { kind: 'result' }>['outcome']> = {},
): void {
  spec.onProtocolEvent?.({ kind: 'command_lifecycle', commandUuid, state: 'started' });
  spec.onProtocolEvent?.({
    kind: 'result',
    outcome: {
      isError: false,
      text: 'ok',
      sessionId: null,
      subtype: 'success',
      errors: [],
      hasStructuredOutput: false,
      ...overrides,
    },
  });
}

/** One line of live assistant text, as the parser hands it to the runtime. */
function fireAssistantText(spec: ClaudeCodeSessionSpec, text: string): void {
  spec.onProtocolEvent?.({
    kind: 'stream',
    line: {
      raw: {
        type: 'assistant',
        message: { id: 'msg-1', content: [{ type: 'text', text }] },
      },
    } as ClaudeProtocolEvent extends { kind: 'stream'; line: infer L } ? L : never,
  });
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

/**
 * A submission's `settled` promise resolves as soon as the completion is
 * computed — which can run a microtask ahead of the runtime's own internal
 * turn teardown (`ClaudeCodeRuntime.runActiveTurn`'s `finally` clearing
 * `activeTurn`). Yielding one macrotask after awaiting `settled` lets that
 * teardown finish before a test submits the next turn, so the second submit
 * takes the "start a new turn" path rather than racing into "steer the still-
 * registered active turn" — a distinction real Core call sites do not exercise
 * back-to-back in the same microtask the way an ultra-tight test loop would.
 */
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
    await first.submission.settled;
    await drain();
    const second = await runtime.submit({ text: 'second turn' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    await second.submission.settled;

    // AgentRuntimeSubmissionInput carries only `text` — there is no per-submit
    // schema field to change, and only one resident child ever spawned.
    expect(h.sessions).toHaveLength(1);
  });
});

// ─── submit(): prepared text only, no native rendering ──────────────────────

describe('ClaudeCodeRuntime submit contract', () => {
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
      completion: { status: 'completed', resultText: 'echo:hello', truncated: false },
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
    h.behavior.stallSubmit = true;
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
 * A native turn is one terminal `result`, not one Dreamux submission and not
 * one resident execution window: several submissions folded into one `result`
 * share its single end, while a steered submission that claude runs on its own
 * after answering the first gets a second `result` — and a second end — inside
 * the same window. The runtime is the only layer that can see those boundaries,
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

  it('reports two ends when a steered submission gets its own result in the same resident window', async () => {
    const h = new Harness();
    h.behavior.holdSubmit = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();

    const first = await runtime.submit({ text: 'one' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    const initialUuid = session.submits[0]!.commandUuid!;
    fireDefaultResult(session.spec, initialUuid, { text: 'first answer' });
    await expect(first.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'first answer' },
    });
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    // The window is still open, so this is a live steer rather than a new turn.
    const second = await runtime.submit({ text: 'two' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    expect(session.steers.map((steer) => steer.prompt)).toEqual(['two']);
    const steeredUuid = session.steers[0]!.commandUuid!;

    // claude did not fold it: the steered command starts and is answered by a
    // result of its own, which is a second native turn in the same window.
    fireDefaultResult(session.spec, steeredUuid, { text: 'second answer' });
    await expect(second.submission.settled).resolves.toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'second answer' },
    });

    expect(h.nativeEnds.map((end) => end.status)).toEqual([
      'completed',
      'completed',
    ]);

    // Draining the window afterwards is not another end: nothing was running.
    session.releaseSubmit();
    await drain();
    expect(h.nativeEnds).toHaveLength(2);
  });

  it('reports one end for one result that folded a steered submission into it', async () => {
    const h = new Harness();
    h.behavior.holdSubmit = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();

    const first = await runtime.submit({ text: 'one' });
    if (first.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    const initialUuid = session.submits[0]!.commandUuid!;
    session.spec.onProtocolEvent?.({
      kind: 'command_lifecycle',
      commandUuid: initialUuid,
      state: 'started',
    });

    const second = await runtime.submit({ text: 'two' });
    if (second.status !== 'submitted') throw new Error('expected submitted');
    const steeredUuid = session.steers[0]!.commandUuid!;
    session.spec.onProtocolEvent?.({
      kind: 'command_lifecycle',
      commandUuid: steeredUuid,
      state: 'started',
    });

    // One result answers both started commands: one native turn, one end.
    session.spec.onProtocolEvent?.({
      kind: 'result',
      outcome: {
        isError: false,
        text: 'one answer for both',
        sessionId: null,
        subtype: 'success',
        errors: [],
        hasStructuredOutput: false,
      },
    });
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

    session.releaseSubmit();
    await drain();
    expect(h.nativeEnds).toHaveLength(1);
  });

  it('reports interrupted, exactly once, when stop() ends a turn the runtime never saw finish', async () => {
    const h = new Harness();
    h.behavior.stallSubmit = true;
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

  it('reports failed when the runtime rejects with a still-open submission', async () => {
    const h = new Harness();
    h.behavior.onSubmit = () => {
      throw new Error('protocol connection lost');
    };
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'hello' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');

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
    // The CLI's legal sequence is started → result → completed: the command's
    // terminal lifecycle is what drains the window, and it arrives after the
    // result that already ended the native turn. It is push-back's drainage
    // signal, not claude reporting new work, so it opens nothing for the
    // teardown to then interrupt.
    const h = new Harness();
    h.behavior.onSubmit = (spec, _prompt, commandUuid) => {
      fireDefaultResult(spec, commandUuid!, { text: 'answered' });
      spec.onProtocolEvent?.({
        kind: 'command_lifecycle',
        commandUuid: commandUuid!,
        state: 'completed',
      });
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
    // The window's first result answered and settled the only submission; what
    // claude does next in the same window is a native turn of its own, and the
    // stop that tears it down ends it. Whether push-back had anything left to
    // settle says nothing about whether claude was working.
    const h = new Harness();
    h.behavior.holdSubmit = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'one' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    fireDefaultResult(session.spec, session.submits[0]!.commandUuid!);
    await admission.submission.settled;
    await drain();
    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed']);

    fireAssistantText(session.spec, 'still working on something else');
    await runtime.stop();
    await drain();

    expect(h.nativeEnds.map((end) => end.status)).toEqual(['completed', 'interrupted']);
  });

  it('reports failed for a native turn the run died on with nothing left to settle', async () => {
    const h = new Harness();
    h.behavior.holdSubmit = true;
    const runtime = await tracked(h.createRuntime());
    await runtime.start();
    const admission = await runtime.submit({ text: 'one' });
    if (admission.status !== 'submitted') throw new Error('expected submitted');
    await drain();
    const session = h.sessions[0]!;
    fireDefaultResult(session.spec, session.submits[0]!.commandUuid!);
    await admission.submission.settled;
    await drain();

    fireAssistantText(session.spec, 'working on the queued command');
    session.failSubmit(new Error('protocol connection lost'));
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
});
