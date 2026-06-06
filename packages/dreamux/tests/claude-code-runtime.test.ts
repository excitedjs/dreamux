import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClaudeCodeAgentRuntimeProvider,
  parseClaudeCodeJsonResult,
  type ClaudeCodeTurnRequest,
  type ClaudeCodeTurnResult,
  type ClaudeCodeTurnRunner,
} from '../src/agent-runtime/claude-code.js';
import {
  claudeCodeMcpConfig,
  claudeCodeTurnArgs,
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
      },
    },
  });
}

interface RecordingRunner extends ClaudeCodeTurnRunner {
  readonly calls: ClaudeCodeTurnRequest[];
}

function recordingRunner(sessionId: string | null = 'session-abc'): RecordingRunner {
  const calls: ClaudeCodeTurnRequest[] = [];
  const result: ClaudeCodeTurnResult = { sessionId, result: 'done' };
  return {
    calls,
    async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
      calls.push(request);
      return result;
    },
  };
}

/** A runner whose turns always fail (e.g. missing binary / non-zero exit). */
function failingRunner(message = 'claude turn failed'): RecordingRunner {
  const calls: ClaudeCodeTurnRequest[] = [];
  return {
    calls,
    async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
      calls.push(request);
      throw new Error(message);
    },
  };
}

/** A runner that plays a scripted sequence of outcomes, one per turn. */
function scriptedRunner(
  outcomes: ReadonlyArray<Error | ClaudeCodeTurnResult>,
): RecordingRunner {
  const calls: ClaudeCodeTurnRequest[] = [];
  let index = 0;
  return {
    calls,
    async runTurn(request: ClaudeCodeTurnRequest): Promise<ClaudeCodeTurnResult> {
      calls.push(request);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome as ClaudeCodeTurnResult;
    },
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
    // flags — a fundamentally different shape. This is the proof the runtimes
    // are not the same code wearing two names.
    const codex = codexMcpServerArgs([FEISHU_MCP]);
    expect(codex[0]).toBe('-c');
    expect(codex.some((a) => a.startsWith('mcp_servers.feishu.command='))).toBe(true);
    expect(Array.isArray(cc)).toBe(false);
  });

  it('builds headless turn args with print/json/mcp-config and resume', () => {
    const args = claudeCodeTurnArgs({
      config: { ...defaultDispatcherClaudeCodeConfig(), model: 'sonnet', permission_mode: 'acceptEdits' },
      mcpConfigPath: '/state/flow/claude-code/mcp.json',
      prompt: 'hello there',
      resumeSessionId: 'sess-1',
    });
    expect(args).toContain('--print');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'json',
    ]);
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
    // Prompt is the trailing positional.
    expect(args[args.length - 1]).toBe('hello there');
  });

  it('omits --resume when there is no session yet', () => {
    const args = claudeCodeTurnArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/x.json',
      prompt: 'p',
      resumeSessionId: null,
    });
    expect(args).not.toContain('--resume');
  });

  it('parses the claude --output-format json envelope, falling back on non-JSON', () => {
    expect(parseClaudeCodeJsonResult('{"session_id":"s1","result":"hi"}')).toEqual({
      sessionId: 's1',
      result: 'hi',
    });
    expect(parseClaudeCodeJsonResult('not json')).toEqual({
      sessionId: null,
      result: 'not json',
    });
  });
});

describe('builtin:claude-code provider', () => {
  it('exposes the claude-code ref and task-notification delivery shape', () => {
    const provider = createClaudeCodeAgentRuntimeProvider({ turnRunner: recordingRunner() });
    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.delivery.teammateCompletion.map((s) => s.kind)).toEqual([
      'claudeCodeTaskNotification',
    ]);
  });
});

describe('ClaudeCodeRuntime lifecycle (fake turn runner)', () => {
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
    runner: ClaudeCodeTurnRunner,
    opts: { resumeSession?: string } = {},
  ): { runtime: AgentRuntime; store: DispatcherStore } {
    const dispatcher = claudeDispatcher('flow');
    const store = new DispatcherStore(testDreamuxConfig([dispatcher]));
    if (opts.resumeSession !== undefined) {
      // Simulate a previously persisted session id on the row.
      void store.setThreadId('flow', opts.resumeSession);
    }
    const row = store.get('flow');
    expect(row).not.toBeNull();
    const runtime = createClaudeCodeAgentRuntimeProvider({ turnRunner: runner }).createRuntime({
      row: row!,
      dispatcher,
      dispatchers: store,
      mcpServers: [FEISHU_MCP],
      log: () => {
        /* test sink */
      },
    });
    return { runtime, store };
  }

  it('start() materializes the MCP config file and reports ready', async () => {
    const { runtime } = makeRuntime(recordingRunner());
    expect(runtime.getStatus()).toBe('declared');
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');
    expect(runtime.providerRef).toBe('builtin:claude-code');

    const mcpPath = dispatcherClaudeCodeMcpConfigPath('flow');
    const written = JSON.parse(readFileSync(mcpPath, 'utf8')) as unknown;
    expect(written).toEqual({
      mcpServers: {
        feishu: { command: FEISHU_MCP.command, args: FEISHU_MCP.args },
      },
    });
  });

  it('reports wasThreadResumed=false on a fresh dispatcher', async () => {
    const { runtime } = makeRuntime(recordingRunner());
    expect(runtime.wasThreadResumed()).toBe(false);
    expect(runtime.getThreadId()).toBeNull();
  });

  it('resumes a persisted session and threads --resume into the turn', async () => {
    const runner = recordingRunner('session-new');
    const { runtime } = makeRuntime(runner, { resumeSession: 'session-prev' });
    expect(runtime.wasThreadResumed()).toBe(true);
    expect(runtime.getThreadId()).toBe('session-prev');
    await runtime.start();
    await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'hello',
    });
    await waitFor(() => runner.calls.length === 1);
    expect(runner.calls[0]?.args).toContain('--resume');
    expect(
      runner.calls[0]?.args.slice(
        runner.calls[0].args.indexOf('--resume'),
        runner.calls[0].args.indexOf('--resume') + 2,
      ),
    ).toEqual(['--resume', 'session-prev']);
  });

  it('submits an inbound turn (accept -> run), dedupes, and captures the session', async () => {
    const runner = recordingRunner('session-abc');
    const { runtime } = makeRuntime(runner);
    await runtime.start();

    const accepted: string[] = [];
    const first = await runtime.enqueueInbound(
      { source_chat_id: 'c', source_message_id: 'm1', sender_id: 'u', parsed_text: 'do it' },
      { onAccepted: (input) => void accepted.push(input.source_message_id ?? '') },
    );
    expect(first.status).toBe('submitted');
    expect(accepted).toEqual(['m1']);

    await waitFor(() => runner.calls.length === 1);
    expect(runner.calls[0]?.args[runner.calls[0].args.length - 1]).toBe('do it');
    await waitFor(() => runtime.getThreadId() === 'session-abc');

    // Duplicate message id is rejected without a second turn.
    const dup = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'do it again',
    });
    expect(dup.status).toBe('duplicate');
    expect(runner.calls).toHaveLength(1);
  });

  it('delivers a TeamMate completion via the task-notification entry', async () => {
    const runner = recordingRunner('session-abc');
    const { runtime } = makeRuntime(runner);
    await runtime.start();

    const result = await runtime.deliverTeamMateCompletion!({
      taskId: 'task-7',
      teammateId: 'mate-1',
      status: 'completed',
      finalText: 'all done',
    });
    expect(result).toEqual({ status: 'accepted' });

    await waitFor(() => runner.calls.length === 1);
    const prompt = runner.calls[0]?.args[runner.calls[0].args.length - 1] ?? '';
    expect(prompt).toContain('<teammate_task_completion');
    expect(prompt).toContain('task_id="task-7"');
    expect(prompt).toContain('status="completed"');
    expect(prompt).toContain('all done');
  });

  it('stop() halts the runtime and refuses further inbound', async () => {
    const runner = recordingRunner();
    const { runtime } = makeRuntime(runner);
    await runtime.start();
    await runtime.stop();
    expect(runtime.getStatus()).toBe('stopped');
    const after = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm9',
      sender_id: 'u',
      parsed_text: 'late',
    });
    expect(after.status).toBe('stopped');
    expect(runner.calls).toHaveLength(0);
  });

  it('drives the runtime to degraded + last_error when an inbound turn fails', async () => {
    const { runtime, store } = makeRuntime(failingRunner('claude is missing'));
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');

    // The message is accepted (channel can ack), but the turn failure is not
    // swallowed: it surfaces as durable degraded state + a persisted last_error.
    const submit = await runtime.enqueueInbound({
      source_chat_id: 'c',
      source_message_id: 'm1',
      sender_id: 'u',
      parsed_text: 'go',
    });
    expect(submit.status).toBe('submitted');

    await waitFor(() => runtime.getStatus() === 'degraded');
    expect(store.get('flow')?.last_error).toContain('claude is missing');
  });

  it('recovers to ready after a failed turn is followed by a successful one', async () => {
    const runner = scriptedRunner([
      new Error('transient'),
      { sessionId: 'session-2', result: 'ok' },
    ]);
    const { runtime } = makeRuntime(runner);
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

  it('returns failed (not accepted) when a TeamMate completion turn fails', async () => {
    const { runtime } = makeRuntime(failingRunner('delivery boom'));
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
