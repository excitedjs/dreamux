import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCodeAgentRuntimeProvider } from '../src/agent-runtime/claude-code.js';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type ClaudeCodeSessionSpec,
  type TurnOutcome,
} from '../src/agent-runtime/claude-code-session.js';
import {
  claudeCodeMcpConfig,
  claudeCodeResidentArgs,
} from '../src/runtime/claude-code-args.js';
import { codexMcpServerArgs } from '../src/codex/mcp-config.js';
import { DispatcherStore } from '../src/runtime/dispatcher-store.js';
import { dispatcherClaudeCodeMcpConfigPath } from '../src/runtime/paths.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/runtime/config.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
} from '../src/agent-runtime/types.js';

const FEISHU_MCP: AgentRuntimeMcpServer = {
  name: 'feishu',
  command: '/pkg/bin/dreamux',
  args: ['feishu-mcp', '--dispatcher', 'flow', '--admin-socket', '/tmp/a.sock'],
};

function claudeDispatcher(id = 'flow') {
  return testDispatcherConfig({
    id,
    runtime: {
      provider: 'builtin:claude-code',
      config: {
        bin: 'claude',
        model: null,
        permission_mode: 'acceptEdits',
        extra_args: [],
        extra_env: {},
        turn_timeout_ms: 600_000,
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
    const session: FakeSession = {
      spec,
      prompts,
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
      async submitTurn(prompt) {
        prompts.push(prompt);
        const outcome = outcomes[Math.min(turnIndex, outcomes.length - 1)];
        turnIndex += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome as TurnOutcome;
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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
});

describe('builtin:claude-code provider', () => {
  it('exposes the claude-code ref and task-notification delivery shape', () => {
    const provider = createClaudeCodeAgentRuntimeProvider({ sessionFactory: fakeFleet().factory });
    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.delivery.teammateCompletion.map((s) => s.kind)).toEqual([
      'claudeCodeTaskNotification',
    ]);
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
    opts: { resumeSession?: string } = {},
  ): { runtime: AgentRuntime; store: DispatcherStore; fleet: FakeFleet } {
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    if (opts.resumeSession !== undefined) {
      void store.setThreadId('flow', opts.resumeSession);
    }
    const row = store.get('flow');
    expect(row).not.toBeNull();
    const runtime = createClaudeCodeAgentRuntimeProvider({
      sessionFactory: fleet.factory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      mcpServers: [FEISHU_MCP],
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

    const mcpPath = dispatcherClaudeCodeMcpConfigPath('flow');
    const written = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown;
    expect(written).toEqual({
      mcpServers: {
        feishu: { command: FEISHU_MCP.command, args: FEISHU_MCP.args },
      },
    });
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

    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'first turn',
    });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm2',
      sender_id: 'u',
      parsed_text: 'second turn',
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
    const first = await runtime.enqueueInbound(
      { source_chat_id: 'c', source_message_id: 'm1', sender_id: 'u', parsed_text: 'do it' },
      { onAccepted: (input) => void accepted.push(input.source_message_id ?? '') },
    );
    expect(first.status).toBe('submitted');
    expect(accepted).toEqual(['m1']);

    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.prompts[0]).toBe('do it');
    await waitFor(() => runtime.getThreadId() === 'session-abc');

    const dup = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'do it again',
    });
    expect(dup.status).toBe('duplicate');
    expect(fleet.sessions[0]?.prompts).toHaveLength(1);
  });

  it('delivers a TeamMate completion via the task-notification entry', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    const result = await runtime.deliverTeamMateCompletion!({
      taskId: 'task-7',
      teammateId: 'mate-1',
      status: 'completed',
      finalText: 'all done',
    });
    expect(result).toEqual({ status: 'accepted' });

    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    const prompt = fleet.sessions[0]?.prompts[0] ?? '';
    expect(prompt).toContain('<teammate_task_completion');
    expect(prompt).toContain('task_id="task-7"');
    expect(prompt).toContain('status="completed"');
    expect(prompt).toContain('all done');
  });

  it('stop() reaps the resident session and refuses further inbound', async () => {
    const fleet = fakeFleet();
    const { runtime } = makeRuntime(fleet);
    await runtime.start();
    expect(fleet.sessions[0]?.isAlive()).toBe(true);
    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
    expect(fleet.sessions[0]?.isAlive()).toBe(false);
    const after = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm9',
      sender_id: 'u',
      parsed_text: 'late',
    });
    expect(after.status).toBe('stopped');
    expect(fleet.sessions[0]?.prompts).toHaveLength(0);
  });

  it('drives the runtime to degraded + last_error when an inbound turn fails', async () => {
    const fleet = fakeFleet([new Error('turn boom')]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');

    const submit = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'go',
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
    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'go',
    });
    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('model overloaded');
  });

  it('recovers to ready after a failed turn is followed by a successful one', async () => {
    const fleet = fakeFleet([new Error('transient'), okOutcome('session-2')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'first',
    });
    await waitFor(() => runtime.getStatus() === 'degraded');

    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm2',
      sender_id: 'u',
      parsed_text: 'second',
    });
    await waitFor(() => runtime.getStatus() === 'ready');
  });

  it('degrades on an unexpected child exit and re-spawns (with --resume) on the next turn', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime, store } = makeRuntime(fleet);
    await runtime.start();

    // First turn establishes the session id.
    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'first',
    });
    await waitFor(() => runtime.getThreadId() === 'session-abc');

    // The resident child dies unexpectedly → degraded.
    fleet.sessions[0]?.triggerExit();
    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('exited');

    // Next turn re-spawns a fresh session that resumes the captured session id.
    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm2',
      sender_id: 'u',
      parsed_text: 'second',
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
      });
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    const row = store.get('flow');
    const runtime = createClaudeCodeAgentRuntimeProvider({
      sessionFactory: stallFactory,
    }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      mcpServers: [],
      log: () => {
        /* test sink */
      },
    });
    await runtime.start();

    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'go',
    });
    await waitFor(() => runtime.getStatus() === 'degraded', 5000);
    expect(store.get('flow')?.last_error).toMatch(/timed out/i);

    // Delivery must return a real `failed` result (so PR8 retry can act),
    // bounded by the same deadline — never an unresolved await.
    const delivery = await runtime.deliverTeamMateCompletion!({
      taskId: 'task-stall',
      teammateId: 'mate-1',
      status: 'completed',
      finalText: 'done',
    });
    expect(delivery.status).toBe('failed');

    await runtime.stop();
  });

  it('returns failed (not accepted) when a TeamMate completion turn fails', async () => {
    const fleet = fakeFleet([new Error('delivery boom')]);
    const { runtime } = makeRuntime(fleet);
    await runtime.start();

    const result = await runtime.deliverTeamMateCompletion!({
      taskId: 'task-9',
      teammateId: 'mate-1',
      status: 'completed',
      finalText: 'done',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toContain('delivery boom');
    }
    // A delivery failure is reported to the caller (PR8 retry) but does not by
    // itself degrade the whole runtime.
    expect(runtime.getStatus()).toBe('ready');
  });
});
