/**
 * Behavioral coverage for the Codex `AgentRuntime` handle (start/submit/stop)
 * and the `AgentRuntimeProvider` facade that builds it, against a fake
 * app-server transport (see tests/helpers/codex-runtime-fakes.ts).
 *
 * Scope (Stage 9 coverage cell B, node codex-adapter):
 *   - replacement vs append system-prompt mapping onto Codex's
 *     baseInstructions/developerInstructions (fresh + resumed + resume-fallback)
 *   - start() continuity reporting and the durable-publish-before-resolve fence
 *   - the state sink's call-receipt ordering and lease-revocation error shape
 *   - stop() fencing input synchronously and converging a racing start
 *   - submit()/settlement (completed, failed, internal/protocol failure, stopped)
 *   - outputSchema bound once at create time and reapplied per native turn
 *   - MCP server list passthrough (exact, unmutated) into the rendered config
 *   - the provider's public surface staying the neutral AgentRuntimeProvider
 */
import { describe, expect, it } from 'vitest';

import { CodexRuntime } from '../src/runtime.js';
import {
  createCodexAgentRuntimeProvider,
  codexRuntimeArgsForMcpServers,
} from '../src/provider.js';
import { compileCodexOutputSchema } from '../src/output-schema-codec.js';
import { defaultDispatcherCodexConfig } from '../src/config.js';
import type { CodexRuntimeDeps } from '../src/runtime-deps.js';
import { CodexProcess, type CodexProcessOptions } from '../src/supervisor.js';
import { CodexWsClient } from '../src/rpc.js';
import {
  FakeCodexProcess,
  FakeCodexWsClient,
  FAKE_PATHS,
  RecordingStateSink,
  noopStateSink,
  waitFor,
} from './helpers/codex-runtime-fakes.js';
import type {
  AgentRuntimeCreateContext,
  AgentRuntimeIdentity,
  AgentRuntimeMcpServer,
  AgentRuntimeSessionRef,
  RuntimeAdmission,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';

function identity(
  session: AgentRuntimeSessionRef | null,
  runtimeId = 'agent-1',
): AgentRuntimeIdentity<AgentRuntimeSessionRef> {
  return { runtimeId, session };
}

function makeDeps(
  overrides: Partial<CodexRuntimeDeps> & {
    process?: FakeCodexProcess;
    client?: FakeCodexWsClient;
  } = {},
): { deps: CodexRuntimeDeps; process: FakeCodexProcess; client: FakeCodexWsClient } {
  const process = overrides.process ?? new FakeCodexProcess();
  const client = overrides.client ?? new FakeCodexWsClient();
  const deps: CodexRuntimeDeps = {
    cwd: '/fake/cwd',
    state: overrides.state ?? noopStateSink(),
    activitySink: overrides.activitySink ?? (() => undefined),
    codec: overrides.codec ?? null,
    paths: FAKE_PATHS,
    allocateSocketPath: () => '/fake/run/sockets/agent-1.sock',
    codexProcessFactory: () => process as unknown as CodexProcess,
    codexClientFactory: () => client as unknown as CodexWsClient,
    ...overrides,
  };
  return { deps, process, client };
}

function requireSubmitted(admission: RuntimeAdmission): RuntimeSubmission {
  if (admission.status !== 'submitted') {
    throw new Error(`expected submitted admission, got ${admission.status}: ${JSON.stringify(admission)}`);
  }
  return admission.submission;
}

describe('CodexRuntime start() continuity', () => {
  it('reports fresh continuity and calls thread/start when there is no prior session', async () => {
    const { deps, client } = makeDeps();
    const runtime = new CodexRuntime(identity(null), deps);

    const outcome = await runtime.start();

    expect(outcome).toEqual({ continuity: 'fresh' });
    expect(client.methods).toEqual(['initialize', 'thread/start']);
    await runtime.stop();
  });

  it('reports resumed continuity and calls thread/resume when a prior session exists', async () => {
    const { deps, client } = makeDeps();
    const runtime = new CodexRuntime(identity({ id: 'thread-existing' }), deps);

    const outcome = await runtime.start();

    expect(outcome).toEqual({ continuity: 'resumed' });
    expect(client.methods).toEqual(['initialize', 'thread/resume']);
    const resumeRequest = client.requests.find((r) => r.method === 'thread/resume');
    expect((resumeRequest?.params as { threadId: string }).threadId).toBe('thread-existing');
    await runtime.stop();
  });

  it('rejects loudly instead of silently starting fresh when a first-start resume fails', async () => {
    const client = new FakeCodexWsClient({
      failResumeWith: new Error('native session gone'),
    });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity({ id: 'thread-lost' }), deps);

    await expect(runtime.start()).rejects.toThrow(/could not restore session/);
    // Never a silent fallback to a fresh thread on the FIRST start.
    expect(client.methods).toEqual(['initialize', 'thread/resume']);
    expect(client.methods).not.toContain('thread/start');
  });
});

describe('CodexRuntime developerInstructions re-supply', () => {
  const append = ['TeamLeader identity fragment'];

  it('re-sends developerInstructions on a fresh thread/start', async () => {
    const { deps, client } = makeDeps({ systemPromptAppend: append });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const start = client.requests.find((r) => r.method === 'thread/start');
    expect(start?.params).toMatchObject({
      developerInstructions: expect.stringContaining('TeamLeader identity fragment'),
    });
    await runtime.stop();
  });

  it('re-sends developerInstructions on thread/resume — Codex does not persist them', async () => {
    const { deps, client } = makeDeps({ systemPromptAppend: append });
    const runtime = new CodexRuntime(identity({ id: 'thread-1' }), deps);
    await runtime.start();

    const resume = client.requests.find((r) => r.method === 'thread/resume');
    expect(resume?.params).toMatchObject({
      developerInstructions: expect.stringContaining('TeamLeader identity fragment'),
    });
    await runtime.stop();
  });

  it('uses baseInstructions for replace and never also sends developerInstructions', async () => {
    const { deps, client } = makeDeps({
      systemPromptReplace: 'complete replacement prompt',
      // A provider constructing deps by hand could (incorrectly) set both;
      // CodexRuntime's own threadInstructionParams() must still prefer
      // replace and drop append — this is the two-slot resolution this
      // package owns (see codexSystemPromptReplace/Append in provider.ts).
    });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const start = client.requests.find((r) => r.method === 'thread/start');
    expect(start?.params).toMatchObject({ baseInstructions: 'complete replacement prompt' });
    expect(start?.params).not.toHaveProperty('developerInstructions');
    await runtime.stop();
  });

  it('re-sends developerInstructions on the resume-fallback thread/start after a child crash', async () => {
    let clientCount = 0;
    const clients: FakeCodexWsClient[] = [];
    const client1 = new FakeCodexWsClient({ freshThreadId: 'thread-A' });
    const client2 = new FakeCodexWsClient({
      failResumeWith: new Error('resume rejected on restart'),
      freshThreadId: 'thread-B',
    });
    clients.push(client1, client2);
    const process1 = new FakeCodexProcess();
    const process2 = new FakeCodexProcess();
    const processes = [process1, process2];
    let processIndex = 0;

    const state = new RecordingStateSink<AgentRuntimeSessionRef>();
    const deps: CodexRuntimeDeps = {
      cwd: '/fake/cwd',
      state,
      activitySink: () => undefined,
      codec: null,
      paths: FAKE_PATHS,
      allocateSocketPath: () => '/fake/run/sockets/agent-1.sock',
      systemPromptAppend: append,
      restartBackoffBaseMs: 0,
      restartBackoffMaxMs: 0,
      codexProcessFactory: () => processes[processIndex++]! as unknown as CodexProcess,
      codexClientFactory: () => {
        const c = clients[clientCount++];
        if (c === undefined) throw new Error('no more fake clients scripted');
        return c as unknown as CodexWsClient;
      },
    };
    const runtime = new CodexRuntime(identity(null), deps);
    const outcome = await runtime.start();
    expect(outcome.continuity).toBe('fresh');
    expect(client1.methods).toEqual(['initialize', 'thread/start']);

    // Simulate the app-server child dying; the runtime restarts and, since a
    // thread id now exists, tries thread/resume first.
    process1.simulateExit({ code: null, signal: 'SIGKILL' });
    await waitFor(() => client2.methods.includes('thread/resume'));
    await waitFor(() => client2.methods.includes('thread/start'));

    const fallbackStart = client2.requests.find((r) => r.method === 'thread/start');
    expect(fallbackStart?.params).toMatchObject({
      developerInstructions: expect.stringContaining('TeamLeader identity fragment'),
    });
    // The loss must be published before the replacement session.
    const kinds = state.updates.map((u) => u.kind);
    expect(kinds).toContain('session_lost');
    expect(kinds.indexOf('session_lost')).toBeLessThan(
      kinds.lastIndexOf('session'),
    );

    await runtime.stop();
  });
});

describe('CodexRuntime state sink ordering and durability', () => {
  it('publishes status/session/status in call-receipt order for a fresh start', async () => {
    const state = new RecordingStateSink<AgentRuntimeSessionRef>();
    const { deps } = makeDeps({ state });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    expect(state.updates.map((u) => u.kind)).toEqual([
      'status',
      'session',
      'status',
    ]);
    expect(state.updates[0]).toMatchObject({ kind: 'status', status: 'starting' });
    expect(state.updates[2]).toMatchObject({ kind: 'status', status: 'ready' });
    await runtime.stop();
  });

  it('does not resolve start() until the ready publish durably lands', async () => {
    const state = new RecordingStateSink<AgentRuntimeSessionRef>();
    state.gateNext((u) => u.kind === 'status' && u.status === 'ready');
    const { deps } = makeDeps({ state });
    const runtime = new CodexRuntime(identity(null), deps);

    const starting = runtime.start();
    let resolved = false;
    void starting.then(() => {
      resolved = true;
    });

    // Give every microtask a chance to run; the gate is still held closed.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    state.releaseGate();
    await starting;
    expect(resolved).toBe(true);
  });

  it('rejects start() with the lease-revoked error shape when the state sink revokes the lease', async () => {
    const state = new RecordingStateSink<AgentRuntimeSessionRef>();
    const revoked = Object.assign(new Error('lease revoked'), {
      name: 'AgentRuntimeStateLeaseRevokedError',
    });
    // Revoke on the SESSION publish (after the native process/client already
    // exist), not the first 'starting' status publish — otherwise there is no
    // native child yet for the fence's teardown to reap, and this test would
    // be unable to observe the fence actually terminating anything.
    state.rejectWhen((u) => u.kind === 'session', revoked);
    const { deps, process } = makeDeps({ state });
    const runtime = new CodexRuntime(identity(null), deps);

    let caught: unknown;
    try {
      await runtime.start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Callers branch on error.name, never instanceof, per the declaration-only
    // AgentRuntimeStateLeaseRevokedError contract.
    expect((caught as Error).name).toBe('AgentRuntimeStateLeaseRevokedError');
    // A revoked lease is terminal: the native child must have been torn down.
    await waitFor(() => process.reapCalls >= 1);
  });
});

describe('CodexRuntime stop() semantics', () => {
  it('fences new input synchronously: submit() right after stop() reports stopped', async () => {
    const { deps } = makeDeps();
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const stopping = runtime.stop();
    // No await between stop() and submit(): stop() must have fenced input
    // synchronously within its own call, before any microtask runs.
    const admission = await runtime.submit({ text: 'too late' });
    expect(admission).toEqual({ status: 'stopped' });
    await stopping;
  });

  it('stops the runtime that appears later when stop races a still-pending start, and rolls back ownership', async () => {
    const process = new FakeCodexProcess({ deferStart: true });
    const { deps } = makeDeps({ process });
    const runtime = new CodexRuntime(identity(null), deps);

    const starting = runtime.start();
    const startFailure = expect(starting).rejects.toThrow(/stopping/);
    await waitFor(() => process.startCalls === 1);

    const stopping = runtime.stop();
    await stopping;
    expect(process.reapCalls).toBe(1);

    // Only now let the deferred native start "complete" — it must not escape
    // and leave a live process the runtime lost track of.
    process.release();
    await startFailure;
    expect(process.reapCalls).toBe(1);

    // A runtime that proved itself stopped must refuse a second start.
    await expect(runtime.start()).rejects.toThrow(/stopped/);
  });

  it('rolls back all partial ownership when the native process fails to start', async () => {
    const process = new FakeCodexProcess({ failStartWith: new Error('spawn failed') });
    const { deps } = makeDeps({ process });
    const runtime = new CodexRuntime(identity(null), deps);

    await expect(runtime.start()).rejects.toThrow('spawn failed');
    expect(process.reapCalls).toBeGreaterThanOrEqual(1);

    // The failed attempt must not have left an unterminated process behind —
    // a fresh start attempt must be able to create a brand new process.
    const retryProcess = new FakeCodexProcess();
    const retryClient = new FakeCodexWsClient();
    const { deps: retryDeps } = makeDeps({ process: retryProcess, client: retryClient });
    const retryRuntime = new CodexRuntime(identity(null), retryDeps);
    await expect(retryRuntime.start()).resolves.toMatchObject({ continuity: 'fresh' });
    await retryRuntime.stop();
  });

  it('converges an admission whose turn/start is still in flight when stop() lands', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    client.block('turn/start');
    const admitting = runtime.submit({ text: 'racing stop' });
    await waitFor(() => client.hasBlocked('turn/start'));

    const stopping = runtime.stop();
    // The real CodexWsClient rejects in-flight requests when its socket
    // closes (see stopRuntime, which closes the client before tearing down
    // the process); the fake mirrors that in close(). Both stop() and the
    // in-flight admission must resolve, not hang.
    await stopping;
    const admission = await admitting;
    expect(admission.status).not.toBe('submitted');
  });
});

describe('CodexRuntime submit() and settlement', () => {
  it('admits a second submit during an active turn without waiting for the first (non-blocking mid-turn submit)', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const first = requireSubmitted(await runtime.submit({ text: 'first' }));
    const second = requireSubmitted(await runtime.submit({ text: 'second' }));
    // Both admitted onto the wire without either settling first.
    expect(client.methods.filter((m) => m === 'turn/start')).toHaveLength(2);

    const threadId = (client.requests.find((r) => r.method === 'thread/start')!.params as never as { threadId?: string }).threadId
      ?? 'fresh-thread-1';
    client.emitCompleted(threadId, 'turn-1', 'first result');
    client.emitCompleted(threadId, 'turn-2', 'second result');

    const firstSettlement = await first.settled;
    const secondSettlement = await second.settled;
    expect(firstSettlement).toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'first result', truncated: false },
    });
    expect(secondSettlement).toMatchObject({
      kind: 'completion',
      completion: { status: 'completed', resultText: 'second result' },
    });
    await runtime.stop();
  });

  it('represents native folding faithfully: two submissions folded onto the SAME native turn settle with one shared completion', async () => {
    // Codex is allowed to fold a mid-turn submit into the already-active
    // native turn instead of opening a new one — both requests still cross
    // the wire (turn/start called twice, non-blocking admission), but the
    // native app-server answers both with the SAME turn id, and a single
    // turn/completed notification must settle both submissions identically.
    const client = new FakeCodexWsClient({
      autoComplete: false,
      scriptedTurnIds: ['turn-folded', 'turn-folded'],
    });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const first = requireSubmitted(await runtime.submit({ text: 'first' }));
    const second = requireSubmitted(await runtime.submit({ text: 'folded in' }));
    expect(client.methods.filter((m) => m === 'turn/start')).toHaveLength(2);

    client.emitCompleted('fresh-thread-1', 'turn-folded', 'shared result');

    const firstSettlement = await first.settled;
    const secondSettlement = await second.settled;
    expect(firstSettlement.kind).toBe('completion');
    expect(secondSettlement.kind).toBe('completion');
    if (firstSettlement.kind === 'completion' && secondSettlement.kind === 'completion') {
      // Same completion object, not merely equal values: both members of a
      // folded native turn share one settlement fact.
      expect(secondSettlement.completion).toBe(firstSettlement.completion);
      expect(firstSettlement.completion).toMatchObject({
        status: 'completed',
        resultText: 'shared result',
      });
    }
    await runtime.stop();
  });

  it('settles a failed native turn as a failed completion', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const submission = requireSubmitted(await runtime.submit({ text: 'do the thing' }));
    client.emitTurnFailed('fresh-thread-1', 'turn-1', 'model refused');

    const settlement = await submission.settled;
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion') {
      expect(settlement.completion.status).toBe('failed');
      if (settlement.completion.status === 'failed') {
        expect(settlement.completion.error.message).toContain('model refused');
      }
    }
    await runtime.stop();
  });

  it('settles every in-flight submission as failed on an internal (unscoped) protocol failure', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const submission = requireSubmitted(await runtime.submit({ text: 'work' }));
    client.emitUnscopedError('fresh-thread-1', 'codex daemon internal error');

    const settlement = await submission.settled;
    expect(settlement.kind).toBe('failed');
    if (settlement.kind === 'failed') {
      expect(settlement.error.message).toContain('codex daemon internal error');
    }
    await runtime.stop();
  });

  it('settles pending submissions as stopped when stop() is called mid-turn', async () => {
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const submission = requireSubmitted(await runtime.submit({ text: 'in flight' }));
    await runtime.stop();

    const settlement = await submission.settled;
    expect(settlement).toEqual({ kind: 'stopped' });
  });
});

describe('CodexRuntime outputSchema binding', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { values: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
    required: ['values'],
  } as const;

  it('binds the schema once at create time and reapplies the SAME wire schema to every native turn', async () => {
    const codec = compileCodexOutputSchema(schema as unknown as Record<string, unknown>);
    const client = new FakeCodexWsClient({ autoComplete: false });
    const { deps } = makeDeps({ client, codec });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    await runtime.submit({ text: 'first' });
    await runtime.submit({ text: 'second' });

    const turnStarts = client.requests.filter((r) => r.method === 'turn/start');
    expect(turnStarts).toHaveLength(2);
    for (const request of turnStarts) {
      expect((request.params as { outputSchema?: unknown }).outputSchema).toEqual(codec.wireSchema);
    }
    // AgentRuntimeSubmissionInput carries only `text` — there is structurally
    // no field a caller could use to vary the schema per submit.
    await runtime.stop();
  });

  it('restores the codec-encoded assistant text before it reaches settlement', async () => {
    const codec = compileCodexOutputSchema(schema as unknown as Record<string, unknown>);
    const client = new FakeCodexWsClient({ autoComplete: true });
    const { deps } = makeDeps({ client, codec });
    const runtime = new CodexRuntime(identity(null), deps);
    await runtime.start();

    const submission = requireSubmitted(await runtime.submit({ text: 'go' }));
    const settlement = await submission.settled;
    expect(settlement.kind).toBe('completion');
    if (settlement.kind === 'completion' && settlement.completion.status === 'completed') {
      expect(settlement.completion.resultText).toBe('{"values":{}}');
    }
    await runtime.stop();
  });
});

describe('MCP server list passthrough encoding', () => {
  it('renders exactly the Core-supplied MCP server list, unmutated, into the launched extra args', async () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'core.feishu', command: 'node', args: ['server.js'] },
      // A logical name with characters that would corrupt a naive TOML key
      // if it were sanitized instead of quoted: dots, quotes, unicode.
      { name: 'weird "name".with.dots 中文', command: 'node', args: [] },
    ];
    let capturedArgs: string[] | undefined;
    const process = new FakeCodexProcess();
    const client = new FakeCodexWsClient();
    const provider = createCodexAgentRuntimeProvider({
      codexProcessFactory: (opts: CodexProcessOptions) => {
        capturedArgs = opts.extraArgs;
        return process as unknown as CodexProcess;
      },
      codexClientFactory: () => client as unknown as CodexWsClient,
    });

    const context: AgentRuntimeCreateContext<ReturnType<typeof defaultDispatcherCodexConfig>, AgentRuntimeSessionRef> = {
      identity: identity(null),
      config: defaultDispatcherCodexConfig(),
      cwd: '/fake/cwd',
      mcpServers: servers,
      skillSources: [],
      disabledFeatures: [],
      paths: FAKE_PATHS,
      state: noopStateSink(),
    };
    const runtime = await provider.createRuntime(context);
    await runtime.start();

    expect(capturedArgs).toBeDefined();
    // The extraArgs also carry this provider's own approval_policy/sandbox_mode
    // overrides ahead of the MCP block; what this test owns is that the MCP
    // block itself is the exact same rendering the pure encoder would produce
    // from the exact same list — the provider never discovers, appends, or
    // mutates servers before handing them to the encoder.
    const expected = codexRuntimeArgsForMcpServers(servers);
    expect(capturedArgs!.slice(-expected.length)).toEqual(expected);
    const joined = capturedArgs!.join(' ');
    expect(joined).toContain('weird \\"name\\".with.dots 中文');
    await runtime.stop();
  });
});

describe('AgentRuntimeProvider public surface', () => {
  it('exposes exactly the neutral provider facade, no Codex-native surface', () => {
    const provider = createCodexAgentRuntimeProvider();
    expect(typeof provider.getCapabilities).toBe('function');
    expect(typeof provider.readRecentActivity).toBe('function');
    expect(typeof provider.createRuntime).toBe('function');
    // Optional neutral capabilities this provider declares.
    expect(provider.config).toBeDefined();
    expect(provider.onboard).toBeDefined();
    expect(provider.diagnostic).toBeDefined();
    // No provider-private surface (thread ids, native config, etc.) is exposed
    // on the facade itself — it holds only the documented neutral keys.
    const keys = new Set(Object.keys(provider));
    for (const key of keys) {
      expect([
        'getCapabilities',
        'diagnostic',
        'onboard',
        'config',
        'readRecentActivity',
        'createRuntime',
      ]).toContain(key);
    }
  });

  it('createRuntime() resolves to a handle typed as the neutral AgentRuntime interface', async () => {
    // TypeScript `private` is compile-time only, so a runtime reflection scan
    // of CodexRuntime's prototype would see its many private helpers too; the
    // real contract lives at the type level (every caller in this repo is
    // typechecked against `AgentRuntime`, never against `CodexRuntime`
    // itself). This assigns the created runtime to that exact interface type,
    // so this file fails to typecheck if the assignment ever needs a method
    // `AgentRuntime` does not declare.
    const provider = createCodexAgentRuntimeProvider();
    const { deps } = makeDeps();
    const runtimeHandle: import('@excitedjs/dreamux-types').AgentRuntime =
      new CodexRuntime(identity(null), deps);
    expect(typeof runtimeHandle.start).toBe('function');
    expect(typeof runtimeHandle.submit).toBe('function');
    expect(typeof runtimeHandle.stop).toBe('function');
    expect(typeof provider.createRuntime).toBe('function');
  });
});
