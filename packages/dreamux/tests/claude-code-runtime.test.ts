import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClaudeCodeAgentRuntimeProvider,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from '../src/agent-runtime/builtin/claude-code/runtime.js';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type ClaudeCodeSessionSpec,
  type TurnOutcome,
  type TurnSubmitOptions,
} from '../src/agent-runtime/builtin/claude-code/supervisor.js';
import { claudeCodeMcpConfig } from '../src/agent-runtime/builtin/claude-code/mcp-config.js';
import { claudeCodeResidentArgs } from '../src/agent-runtime/builtin/claude-code/args.js';
import { codexMcpServerArgs } from '../src/agent-runtime/builtin/codex/mcp-config.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  defaultDispatcherCwd,
  dispatcherCompletionSpillDir,
  teamMateCompletionOutputPath,
} from '../src/platform/paths.js';
import { dispatcherClaudeCodeMcpConfigPath } from '../src/agent-runtime/builtin/claude-code/paths.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config/config.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { renderChannelInput } from '../src/agent-runtime/turn.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
} from '../src/agent-runtime/types.js';
import type { TurnSettledSignal } from '../src/agent-runtime/turn.js';

const FEISHU_MCP: AgentRuntimeMcpServer = {
  name: 'feishu',
  command: '/pkg/bin/dreamux',
  args: ['feishu-mcp', '--dispatcher', 'flow', '--admin-socket', '/tmp/a.sock'],
};

function claudeCodeProvider(
  options: Omit<ClaudeCodeAgentRuntimeProviderOptions, 'descriptor'> = {},
) {
  const registry = createBuiltinProviderRegistry();
  return createClaudeCodeAgentRuntimeProvider({
    ...options,
    descriptor: registry.resolve('builtin:claude-code'),
  });
}

function claudeDispatcher(
  id = 'flow',
  config: Partial<ReturnType<typeof defaultDispatcherClaudeCodeConfig>> = {},
) {
  return testDispatcherConfig({
    id,
    runtime: {
      provider: 'builtin:claude-code',
      config: {
        ...defaultDispatcherClaudeCodeConfig(),
        permission_mode: 'acceptEdits',
        ...config,
      },
    },
  });
}

function okOutcome(sessionId: string | null = 'session-abc'): TurnOutcome {
  return { isError: false, text: 'done', sessionId, subtype: 'success', errors: [] };
}

/** A fake resident session: records turns, plays a scripted outcome sequence. */
interface FakeSession extends ClaudeCodeSession {
  readonly spec: ClaudeCodeSessionSpec;
  readonly prompts: string[];
  /** Per-turn submit options captured alongside each prompt. */
  readonly submitOptions: Array<TurnSubmitOptions | undefined>;
  startCount(): number;
  /** Simulate an unexpected child exit (fires the registered onExit). */
  triggerExit(): void;
}

interface FakeFleet {
  factory: ClaudeCodeSessionFactory;
  sessions: FakeSession[];
}

/**
 * Build an injectable session factory. `outcomes` is a per-turn script shared
 * across all (re)spawned sessions; an `Error` entry makes that turn throw.
 * `startError` makes the *first* spawn fail (missing binary parity).
 */
function fakeFleet(
  outcomes: ReadonlyArray<Error | TurnOutcome> = [okOutcome()],
  opts: { startError?: Error } = {},
): FakeFleet {
  const sessions: FakeSession[] = [];
  let turnIndex = 0;
  let spawnIndex = 0;
  const factory: ClaudeCodeSessionFactory = (spec) => {
    const mySpawn = spawnIndex++;
    let alive = false;
    let starts = 0;
    let onExit: (() => void) | null = null;
    const prompts: string[] = [];
    const submitOptions: Array<TurnSubmitOptions | undefined> = [];
    const session: FakeSession = {
      spec,
      prompts,
      submitOptions,
      startCount: () => starts,
      async start() {
        starts += 1;
        if (opts.startError !== undefined && mySpawn === 0) throw opts.startError;
        alive = true;
      },
      isAlive: () => alive,
      setOnExit(handler) {
        onExit = handler;
      },
      async submitTurn(prompt, options) {
        prompts.push(prompt);
        submitOptions.push(options);
        const outcome = outcomes[Math.min(turnIndex, outcomes.length - 1)];
        turnIndex += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome as TurnOutcome;
      },
      async steerTurn(prompt, options) {
        prompts.push(prompt);
        submitOptions.push(options);
      },
      async stop() {
        alive = false;
      },
      triggerExit() {
        alive = false;
        onExit?.();
      },
    };
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

function controllableFleet(): FakeFleet & {
  resolveNext(outcome?: TurnOutcome): void;
  rejectNext(error: Error): void;
} {
  const sessions: FakeSession[] = [];
  let pendingResolve: ((outcome: TurnOutcome) => void) | null = null;
  let pendingReject: ((error: Error) => void) | null = null;
  const factory: ClaudeCodeSessionFactory = (spec) => {
    let alive = false;
    let starts = 0;
    let onExit: (() => void) | null = null;
    const prompts: string[] = [];
    const submitOptions: Array<TurnSubmitOptions | undefined> = [];
    const session: FakeSession = {
      spec,
      prompts,
      submitOptions,
      startCount: () => starts,
      async start() {
        starts += 1;
        alive = true;
      },
      isAlive: () => alive,
      setOnExit(handler) {
        onExit = handler;
      },
      async submitTurn(prompt, options) {
        prompts.push(prompt);
        submitOptions.push(options);
        return new Promise<TurnOutcome>((resolve, reject) => {
          pendingResolve = resolve;
          pendingReject = reject;
        });
      },
      async steerTurn(prompt, options) {
        prompts.push(prompt);
        submitOptions.push(options);
      },
      async stop() {
        alive = false;
      },
      triggerExit() {
        alive = false;
        onExit?.();
      },
    };
    sessions.push(session);
    return session;
  };
  return {
    factory,
    sessions,
    resolveNext(outcome = okOutcome()) {
      pendingResolve?.(outcome);
      pendingResolve = null;
      pendingReject = null;
    },
    rejectNext(error: Error) {
      pendingReject?.(error);
      pendingResolve = null;
      pendingReject = null;
    },
  };
}

// 10s, not 2s: loaded shared CI runners (macOS especially) can stall a forked
// worker past 2s and flake these purely-fake lifecycle tests (CI run
// 27259524760 failed, then passed on a same-commit rerun). The poll returns as
// soon as the predicate holds, so the ceiling costs nothing on the happy path.
// The test timeout must stay above the waitFor ceiling or vitest's 5s default
// would undercut it.
vi.setConfig({ testTimeout: 15_000 });

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

describe('claude-code pure translation (not Codex renamed)', () => {
  it('translates MCP descriptors into a Claude Code JSON config, not TOML CLI flags', () => {
    const cc = claudeCodeMcpConfig([FEISHU_MCP]);
    expect(cc).toEqual({
      mcpServers: {
        feishu: {
          command: '/pkg/bin/dreamux',
          args: ['feishu-mcp', '--dispatcher', 'flow', '--admin-socket', '/tmp/a.sock'],
        },
      },
    });
    // The Codex runtime turns the same descriptor into `-c mcp_servers.*` CLI
    // flags — a fundamentally different shape.
    const codex = codexMcpServerArgs([FEISHU_MCP]);
    expect(codex[0]).toBe('-c');
    expect(codex.some((a) => a.startsWith('mcp_servers.feishu.command='))).toBe(true);
    expect(Array.isArray(cc)).toBe(false);
  });

  it('builds resident stream-json launch args (no positional prompt), with resume', () => {
    const args = claudeCodeResidentArgs({
      config: { ...defaultDispatcherClaudeCodeConfig(), model: 'sonnet', permission_mode: 'acceptEdits' },
      mcpConfigPath: '/state/flow/claude-code/mcp.json',
      resumeSessionId: 'sess-1',
    });
    expect(args).toContain('--print');
    expect(
      args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2),
    ).toEqual(['--input-format', 'stream-json']);
    expect(
      args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ).toEqual(['--output-format', 'stream-json']);
    expect(args).toContain('--verbose');
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      '/state/flow/claude-code/mcp.json',
    ]);
    expect(args).toContain('--permission-mode');
    expect(args).toContain('--model');
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      'sess-1',
    ]);
    // The prompt is NOT a CLI arg under the resident transport — it is a stdin
    // `user` message line. Every arg is a flag or flag value.
    expect(args).not.toContain('hello there');
  });

  it('omits --resume when there is no session yet', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/x.json',
      resumeSessionId: null,
    });
    expect(args).not.toContain('--resume');
  });

  it('injects the dispatcher role prompt via --append-system-prompt (append mode)', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/x.json',
      resumeSessionId: null,
      systemPromptContent: 'You are a Dreamux dispatcher.',
    });
    // claude APPENDS the role prompt on top of its own system prompt — distinct
    // from codex, which REPLACES its base instructions.
    expect(
      args.slice(
        args.indexOf('--append-system-prompt'),
        args.indexOf('--append-system-prompt') + 2,
      ),
    ).toEqual(['--append-system-prompt', 'You are a Dreamux dispatcher.']);
  });

  it('omits --append-system-prompt when no role prompt is supplied (e.g. teammate)', () => {
    const undefinedArgs = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/x.json',
      resumeSessionId: null,
    });
    expect(undefinedArgs).not.toContain('--append-system-prompt');
    const emptyArgs = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/x.json',
      resumeSessionId: null,
      systemPromptContent: '',
    });
    expect(emptyArgs).not.toContain('--append-system-prompt');
  });
});

describe('builtin:claude-code provider', () => {
  it('exposes the claude-code ref and plain-turn delivery shape', () => {
    const provider = claudeCodeProvider({ sessionFactory: fakeFleet().factory });
    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities().steer.supported).toBe(true);
    expect(
      provider.getCapabilities().teammateCompletion.map((s) => s.kind),
    ).toEqual(['claudeCodePlainTurn']);
  });
});

describe('ClaudeCodeRuntime resident lifecycle (fake session)', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dreamux-cc-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function makeRuntime(
    fleet: FakeFleet,
    opts: {
      resumeSession?: string;
      onTurnSettled?: (settled: TurnSettledSignal) => void;
    } = {},
  ): { runtime: AgentRuntime; store: DispatcherStore; fleet: FakeFleet } {
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    if (opts.resumeSession !== undefined) {
      void store.setThreadId('flow', opts.resumeSession);
    }
    const row = store.get('flow');
    expect(row).not.toBeNull();
    const runtime = claudeCodeProvider({
      sessionFactory: fleet.factory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: defaultDispatcherCwd('flow'),
      mcpServers: [FEISHU_MCP],
      ...(opts.onTurnSettled !== undefined
        ? { onTurnSettled: opts.onTurnSettled }
        : {}),
      log: () => {
        /* test sink */
      },
    });
    return { runtime, store, fleet };
  }

  it('start() materializes the MCP config, spawns one resident session, and reports ready', async () => {
    const fleet = fakeFleet();
    const { runtime } = makeRuntime(fleet);
    expect(runtime.getStatus()).toBe('declared');
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');
    expect(runtime.providerRef).toBe('builtin:claude-code');

    // Exactly one resident child, started once, launched with stream-json args.
    expect(fleet.sessions).toHaveLength(1);
    expect(fleet.sessions[0]?.startCount()).toBe(1);
    expect(fleet.sessions[0]?.spec.args).toContain('--input-format');
    expect(fleet.sessions[0]?.spec.args).toContain('stream-json');
    expect(fleet.sessions[0]?.spec.remoteControl).toBe(false);

    const mcpPath = dispatcherClaudeCodeMcpConfigPath('flow');
    const written = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown;
    expect(written).toEqual({
      mcpServers: {
        feishu: { command: FEISHU_MCP.command, args: FEISHU_MCP.args },
      },
    });
  });

  it('threads agents[].config.remote_control into the resident session spec', async () => {
    const fleet = fakeFleet();
    const logs: string[] = [];
    const dispatcher = claudeDispatcher('flow', { remote_control: true });
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    const runtime = claudeCodeProvider({
      sessionFactory: fleet.factory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: defaultDispatcherCwd('flow'),
      mcpServers: [],
      log: (_level, msg) => {
        logs.push(msg);
      },
    });
    await runtime.start();

    expect(fleet.sessions[0]?.spec.remoteControl).toBe(true);
    expect(fleet.sessions[0]?.spec.args).not.toContain('--remote-control');
    fleet.sessions[0]?.spec.onRemoteControlUrl?.(
      'https://example.invalid/session/fake',
    );
    expect(logs).toContain(
      'claude-code remote control URL: https://example.invalid/session/fake',
    );
  });

  it('start() drives the runtime to degraded and throws when the child cannot spawn', async () => {
    const fleet = fakeFleet([okOutcome()], { startError: new Error('claude is missing') });
    const { runtime, store } = makeRuntime(fleet);
    await expect(runtime.start()).rejects.toThrow('claude is missing');
    expect(runtime.getStatus()).toBe('degraded');
    expect(store.get('flow')?.last_error).toContain('claude is missing');
  });

  it('runs MULTIPLE turns over ONE resident process', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    await runtime.channelInput({
      sourceId: 'm1',
      text: 'first turn',
    });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    await runtime.channelInput({
      sourceId: 'm2',
      text: 'second turn',
    });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 2);

    // Both turns ran on the SAME session — the resident-process invariant.
    expect(fleet.sessions).toHaveLength(1);
    expect(fleet.sessions[0]?.startCount()).toBe(1);
    expect(fleet.sessions[0]?.prompts).toEqual(['first turn', 'second turn']);
  });

  it('reports wasThreadResumed=false on a fresh dispatcher', async () => {
    const { runtime } = makeRuntime(fakeFleet());
    expect(runtime.wasThreadResumed()).toBe(false);
    expect(runtime.getThreadId()).toBeNull();
  });

  it('resumes a persisted session and threads --resume into the launch args', async () => {
    const fleet = fakeFleet([okOutcome('session-new')]);
    const { runtime } = makeRuntime(fleet, { resumeSession: 'session-prev' });
    expect(runtime.wasThreadResumed()).toBe(true);
    expect(runtime.getThreadId()).toBe('session-prev');
    await runtime.start();
    expect(
      fleet.sessions[0]?.spec.args.slice(
        fleet.sessions[0].spec.args.indexOf('--resume'),
        fleet.sessions[0].spec.args.indexOf('--resume') + 2,
      ),
    ).toEqual(['--resume', 'session-prev']);
  });

  it('submits an inbound turn (accept -> run), dedupes, and captures the session', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    const accepted: string[] = [];
    const first = await runtime.channelInput(
      { sourceId: 'm1', text: 'do it' },
      { onAccepted: (input) => void accepted.push(input.sourceId) },
    );
    expect(first.status).toBe('submitted');
    expect(accepted).toEqual(['m1']);

    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.prompts[0]).toBe('do it');
    await waitFor(() => runtime.getThreadId() === 'session-abc');

    const dup = await runtime.channelInput({
      sourceId: 'm1',
      text: 'do it again',
    });
    expect(dup.status).toBe('duplicate');
    expect(fleet.sessions[0]?.prompts).toHaveLength(1);
  });

  it('steers follow-up sends into the active channel turn and settles once', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = controllableFleet();
    const { runtime } = makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    expect(first.status).toBe('submitted');
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    const second = await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    const third = await runtime.channelInput({ sourceId: 'm3', text: 'third' });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fleet.sessions[0]?.prompts).toEqual(['first', 'second', 'third']);
    expect(fleet.sessions[0]?.submitOptions).toEqual([
      undefined,
      { priority: 'next' },
      { priority: 'next' },
    ]);

    fleet.resolveNext(okOutcome('session-abc'));
    await waitFor(() => settled.length === 1);
    expect(settled).toEqual([
      {
        turnId: first.status === 'submitted' ? first.turnId : 'unreachable',
        status: 'completed',
      },
    ]);
  });

  it('starts a fresh logical turn for a sequential send after the previous turn completed', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    await waitFor(() => settled.length === 1);
    const second = await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    await waitFor(() => settled.length === 2);

    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    if (first.status !== 'submitted' || second.status !== 'submitted') {
      throw new Error('expected submitted turns');
    }
    expect(first.turnId).not.toBe(second.turnId);
    expect(settled.map((s) => s.turnId)).toEqual([
      first.turnId,
      second.turnId,
    ]);
  });

  it('does not reuse logical turn ids across resumed runtime instances', async () => {
    const firstSettled: TurnSettledSignal[] = [];
    const firstRuntime = makeRuntime(fakeFleet([okOutcome('session-abc')]), {
      onTurnSettled: (s) => firstSettled.push(s),
    });
    await firstRuntime.runtime.start();
    const first = await firstRuntime.runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    await waitFor(() => firstSettled.length === 1);

    const secondSettled: TurnSettledSignal[] = [];
    const secondRuntime = makeRuntime(fakeFleet([okOutcome('session-abc')]), {
      resumeSession: 'session-abc',
      onTurnSettled: (s) => secondSettled.push(s),
    });
    await secondRuntime.runtime.start();
    const second = await secondRuntime.runtime.channelInput({
      sourceId: 'm2',
      text: 'second',
    });
    await waitFor(() => secondSettled.length === 1);

    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    if (first.status !== 'submitted' || second.status !== 'submitted') {
      throw new Error('expected submitted turns');
    }
    expect(first.turnId).not.toBe(second.turnId);
  });

  it('delivers a TeamMate completion as a plain status-varied user turn', async () => {
    const fleet = controllableFleet();
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    const deliveryPromise = runtime.completionInput!({
      source: 'reviewer',
      id: 'mate-1',
      status: 'completed',
      result: 'all done',
    });
    // The turn is queued but the session outcome is NOT resolved yet.
    // The delivery should return `accepted` immediately (submit-then-serialize),
    // decoupled from model thinking time.
    const result = await deliveryPromise;
    expect(result).toEqual({ status: 'accepted' });

    // The turn is still pending in the fleet. Resolve it so it cleans up.
    fleet.resolveNext(okOutcome('session-abc'));
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    const prompt = fleet.sessions[0]?.prompts[0] ?? '';
    // Plain English status line + inlined result — NOT claude-code's native
    // <task-notification> XML (which the model could mistake for a real task).
    expect(prompt).toContain('TeamMate reviewer has finished its task.');
    expect(prompt).toContain('Output below:');
    expect(prompt).toContain('all done');
    expect(prompt).not.toContain('<task-notification>');
    expect(prompt).not.toContain('<task-id>');
    expect(prompt).not.toContain('<teammate_session_completion');
    // Delivered as ordinary input, NOT a synthetic notification.
    expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
  });

  it('resolves completionInput with failed/unsupported for pre-submit failures', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();
    await runtime.stop();
    const stoppedResult = await runtime.completionInput!({
      source: 'reviewer',
      id: 'mate-stop',
      status: 'completed',
      result: 'done',
    });
    expect(stoppedResult.status).toBe('unsupported');
  });

  it('inlines a spill pointer when a completion overflows the budget', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    // No path context → the runtime falls back to the operator dispatcher's
    // cache spill dir under the (HOME-isolated) ~/.dreamux/cache/flow/spill.
    const spillPath = teamMateCompletionOutputPath(
      dispatcherCompletionSpillDir('flow'),
      'reviewer',
      'mate-big',
    );
    process.env['TASK_MAX_OUTPUT_LENGTH'] = '8';
    try {
      await runtime.completionInput!({
        source: 'reviewer',
        id: 'mate-big',
        status: 'completed',
        result: 'a result far longer than eight characters',
      });
      await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
      const prompt = fleet.sessions[0]?.prompts[0] ?? '';
      expect(prompt).toContain('TeamMate reviewer has finished its task.');
      expect(prompt).toContain(
        'The output is too long, so the full result was saved to a file:',
      );
      expect(prompt).toContain(spillPath);
      expect(prompt).not.toContain('far longer than eight');
      expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
    } finally {
      delete process.env['TASK_MAX_OUTPUT_LENGTH'];
      await rm(spillPath, { force: true });
    }
  });

  it('renders status-varied completion lines for failed and stopped', async () => {
    for (const [status, expected] of [
      ['failed', "TeamMate reviewer's task failed."],
      ['stopped', "TeamMate reviewer's task was stopped."],
    ] as const) {
      const fleet = fakeFleet([okOutcome('session-abc')]);
      const { runtime } = makeRuntime(fleet);
      await runtime.start();
      await runtime.completionInput!({
        source: 'reviewer',
        id: `mate-${status}`,
        status,
        result: 'r',
      });
      await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
      expect(fleet.sessions[0]?.prompts[0] ?? '').toContain(expected);
    }
  });

  it('does not mark a normal channel turn as synthetic', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    await runtime.channelInput({ sourceId: 'm1', text: 'hello' });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.submitOptions[0]).toBeUndefined();
  });

  it('wraps a structured channel input into the native <channel> block', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    const input = {
      sourceId: 'm1',
      source: 'feishu',
      text: 'fallback ignored',
      attrs: [
        ['chat_id', 'chat-1'],
        ['sender_id', 'sender-1'],
      ] as Array<[string, string]>,
      body: 'the message body',
    };
    await runtime.channelInput(input);
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    const prompt = fleet.sessions[0]?.prompts[0] ?? '';
    // Same envelope renderChannelInput produces — both runtimes share it, so
    // claude and codex render byte-identical channel blocks for one input.
    expect(prompt).toBe(renderChannelInput(input));
    expect(prompt).toBe(
      '<channel source="feishu" chat_id="chat-1" sender_id="sender-1">\nthe message body\n</channel>',
    );
  });

  it('stop() reaps the resident session and refuses further inbound', async () => {
    const fleet = fakeFleet();
    const { runtime } = makeRuntime(fleet);
    await runtime.start();
    expect(fleet.sessions[0]?.isAlive()).toBe(true);
    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
    expect(fleet.sessions[0]?.isAlive()).toBe(false);
    const after = await runtime.channelInput({
      sourceId: 'm9',
      text: 'late',
    });
    expect(after.status).toBe('stopped');
    expect(fleet.sessions[0]?.prompts).toHaveLength(0);
  });

  it('drives the runtime to degraded + last_error when an inbound turn fails', async () => {
    const fleet = fakeFleet([new Error('turn boom')]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');

    const submit = await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    expect(submit.status).toBe('submitted');

    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('turn boom');
  });

  it('surfaces an error result envelope as a degraded turn', async () => {
    const fleet = fakeFleet([
      { isError: true, text: '', sessionId: 'session-abc', subtype: 'error_during_execution', errors: ['model overloaded'] },
    ]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();
    await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('model overloaded');
  });

  it('recovers to ready after a failed turn is followed by a successful one', async () => {
    const fleet = fakeFleet([new Error('transient'), okOutcome('session-2')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    await runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    await waitFor(() => runtime.getStatus() === 'degraded');

    await runtime.channelInput({
      sourceId: 'm2',
      text: 'second',
    });
    await waitFor(() => runtime.getStatus() === 'ready');
  });

  it('degrades on an unexpected child exit and re-spawns (with --resume) on the next turn', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();

    // First turn establishes the session id.
    await runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    await waitFor(() => runtime.getThreadId() === 'session-abc');

    // The resident child dies unexpectedly → degraded.
    fleet.sessions[0]?.triggerExit();
    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('exited');

    // Next turn re-spawns a fresh session that resumes the captured session id.
    await runtime.channelInput({
      sourceId: 'm2',
      text: 'second',
    });
    await waitFor(() => fleet.sessions.length === 2);
    const respawn = fleet.sessions[1]!;
    expect(respawn.spec.args.slice(
      respawn.spec.args.indexOf('--resume'),
      respawn.spec.args.indexOf('--resume') + 2,
    )).toEqual(['--resume', 'session-abc']);
    await waitFor(() => runtime.getStatus() === 'ready');
  });

  it('a stalled child (alive, no result) degrades the runtime and fails delivery instead of wedging', async () => {
    // Real resident session against the stall fixture: the child stays alive but
    // never emits a terminal `result`. The per-turn deadline must fail the turn
    // so neither inbound nor TeamMate delivery hangs forever.
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'fake-claude-stream.mjs',
    );
    const stallFactory: ClaudeCodeSessionFactory = (spec) =>
      createDefaultClaudeCodeSession({
        ...spec,
        bin: process.execPath,
        args: [fixture, 'stall'],
        turnTimeoutMs: 250,
        remoteControl: spec.remoteControl,
      });
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    const runtime = claudeCodeProvider({
      sessionFactory: stallFactory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: defaultDispatcherCwd('flow'),
      mcpServers: [],
      log: () => {
        /* test sink */
      },
    });
    await runtime.start();

    await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    await waitFor(() => runtime.getStatus() === 'degraded', 5000);
    expect(store.get('flow')?.last_error).toMatch(/stalled|no stream activity/i);

    // Delivery must return `accepted` immediately since acceptance is now
    // decoupled from model outcome. The async turn failure degrades the runtime.
    const delivery = await runtime.completionInput!({
      source: 'teammate',
      id: 'mate-1',
      status: 'completed',
      result: 'done',
    });
    expect(delivery.status).toBe('accepted');

    await runtime.stop();
  });

  it('degrades the runtime when a TeamMate completion turn fails asynchronously', async () => {
    const fleet = fakeFleet([new Error('delivery boom')]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();

    const result = await runtime.completionInput!({
      source: 'teammate',
      id: 'mate-1',
      status: 'completed',
      result: 'done',
    });
    expect(result.status).toBe('accepted');

    // A delivery failure degrades the whole runtime just like a channel turn
    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('delivery boom');
  });

  it('fires onTurnSettled(completed) with the turn id when an inbound turn succeeds', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const submit = await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    expect(submit.status).toBe('submitted');

    await waitFor(() => settled.length === 1);
    expect(settled[0]?.status).toBe('completed');
    expect(settled[0]?.turnId).toBe(
      submit.status === 'submitted' ? submit.turnId : undefined,
    );
  });

  it('fires onTurnSettled(failed) with the error when an inbound turn fails', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([new Error('turn boom')]);
    const { runtime } = makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    await runtime.channelInput({ sourceId: 'm1', text: 'go' });

    await waitFor(() => settled.length === 1);
    expect(settled[0]?.status).toBe('failed');
    expect(settled[0]?.error?.message).toContain('turn boom');
  });

  it('fires onTurnSettled(stopped) for a turn cut short by stop()', async () => {
    const settled: TurnSettledSignal[] = [];
    // A turn whose submitTurn never settles on its own; stop() tears the session
    // down, which rejects the in-flight turn — it must settle as `stopped`.
    let releaseTurn: (() => void) | null = null;
    const blockingFactory: ClaudeCodeSessionFactory = (spec) => {
      let alive = false;
      const session: ClaudeCodeSession = {
        isAlive: () => alive,
        setOnExit: () => {
          /* not used */
        },
        async start() {
          alive = true;
        },
        async submitTurn() {
          return new Promise<TurnOutcome>((_resolve, reject) => {
            releaseTurn = () =>
              reject(new Error('claude resident session stopped mid-turn'));
          });
        },
        async steerTurn() {
          /* no-op: the turn is blocked until stop() */
        },
        async stop() {
          alive = false;
          releaseTurn?.();
        },
      };
      void spec;
      return session;
    };
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    const runtime = claudeCodeProvider({
      sessionFactory: blockingFactory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      cwd: defaultDispatcherCwd('flow'),
      mcpServers: [],
      onTurnSettled: (s) => settled.push(s),
      log: () => {
        /* test sink */
      },
    });
    await runtime.start();
    await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    await waitFor(() => releaseTurn !== null);

    await runtime.stop();
    await waitFor(() => settled.length === 1);
    expect(settled[0]?.status).toBe('stopped');
  });
});
