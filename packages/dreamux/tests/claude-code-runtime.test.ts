import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClaudeCodeAgentRuntimeProvider,
  defaultDispatcherClaudeCodeConfig,
  type ClaudeCodeAgentRuntimeProviderOptions,
} from '@excitedjs/agent-runtime-claude-code';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeCodeSessionFactory,
  type ClaudeCodeSessionSpec,
  type TurnOutcome,
  type TurnSubmitOptions,
} from '@excitedjs/agent-runtime-claude-code';
import { claudeCodeMcpConfig } from '@excitedjs/agent-runtime-claude-code';
import { claudeCodeResidentArgs } from '@excitedjs/agent-runtime-claude-code';
import { dispatcherClaudeCodeConfig } from '@excitedjs/agent-runtime-claude-code';
import { codexMcpServerArgs } from '@excitedjs/agent-runtime-codex';
import {
  cacheRoot,
  defaultDispatcherCwd,
} from '../src/platform/paths.js';
import { hostRuntimePaths } from '../src/agent-runtime/host-paths.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { ensureDispatcherIdentity } from '../src/service/dispatcher-service/identity.js';
import { AgentRuntimeStateStore } from '../src/service/agent-entity/runtime-state.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import {
  renderChannelInput,
} from '@excitedjs/dreamux-utils';
import { testDispatcherConfig } from './helpers/config.js';
import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemPrompt,
  DreamuxLogger,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

const noopLogger: DreamuxLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

const FEISHU_MCP: AgentRuntimeMcpServer = {
  name: 'feishu',
  command: '/pkg/bin/dreamux',
  args: ['channel-mcp', '--provider', 'builtin:feishu', '--channel-id', 'primary', '--dispatcher', 'flow', '--admin-socket', '/tmp/a.sock'],
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

function fleetFromFactory(factory: ClaudeCodeSessionFactory): FakeFleet {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    factory: (spec) => {
      const session = factory(spec) as FakeSession;
      sessions.push(session);
      return session;
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
          args: ['channel-mcp', '--provider', 'builtin:feishu', '--channel-id', 'primary', '--dispatcher', 'flow', '--admin-socket', '/tmp/a.sock'],
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
    const mcpConfigJson = JSON.stringify({
      mcpServers: {
        feishu: {
          command: FEISHU_MCP.command,
          args: FEISHU_MCP.args,
        },
      },
    });
    const args = claudeCodeResidentArgs({
      config: { ...defaultDispatcherClaudeCodeConfig(), model: 'sonnet', permission_mode: 'acceptEdits' },
      mcpConfigJson,
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
      mcpConfigJson,
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
      mcpConfigJson: '{}',
      resumeSessionId: null,
    });
    expect(args).not.toContain('--resume');
  });

  it('injects the dispatcher role prompt via --append-system-prompt (append mode)', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigJson: '{}',
      resumeSessionId: null,
      systemPromptAppend: ['You are a Dreamux dispatcher.'],
    });
    // claude APPENDS the role prompt on top of its own system prompt — distinct
    // from codex, which REPLACES its base instructions.
    expect(
      args.slice(
        args.indexOf('--append-system-prompt'),
        args.indexOf('--append-system-prompt') + 2,
      ),
    ).toEqual([
      '--append-system-prompt',
      '<system-reminder>\nYou are a Dreamux dispatcher.\n</system-reminder>',
    ]);
  });

  it('omits --append-system-prompt when no role prompt is supplied (e.g. teammate)', () => {
    const undefinedArgs = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigJson: '{}',
      resumeSessionId: null,
    });
    expect(undefinedArgs).not.toContain('--append-system-prompt');
    const emptyArgs = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigJson: '{}',
      resumeSessionId: null,
      systemPromptAppend: [],
    });
    expect(emptyArgs).not.toContain('--append-system-prompt');
  });
});

describe('builtin:claude-code provider', () => {
  it('exposes the claude-code ref and resume support', () => {
    const provider = claudeCodeProvider({ sessionFactory: fakeFleet().factory });
    expect(provider.ref).toBe('builtin:claude-code');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities()).toEqual({ resume: { supported: true } });
  });
});

describe('ClaudeCodeRuntime resident lifecycle (fake session)', () => {
  let home: string;
  let previousHome: string | undefined;
  let runtimes: AgentRuntime[];

  beforeEach(() => {
    runtimes = [];
    home = mkdtempSync(join(tmpdir(), 'dreamux-cc-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function makeRuntime(
    fleet: FakeFleet,
    opts: {
      resumeSession?: string;
      onTurnSettled?: (settled: TurnSettledSignal) => void;
      systemPrompt?: AgentRuntimeSystemPrompt;
      skillSources?: AgentRuntimeSkillSource[];
      disableFeatures?: readonly string[];
      config?: Partial<ReturnType<typeof defaultDispatcherClaudeCodeConfig>>;
      logger?: Parameters<ReturnType<typeof claudeCodeProvider>['createRuntime']>[0]['logger'];
    } = {},
  ): Promise<{
    runtime: AgentRuntime;
    state: AgentRuntimeStateStore;
    store: { get(id: string): { last_error: string | null } | null };
    fleet: FakeFleet;
  }> {
    const dispatcher = claudeDispatcher('flow', opts.config ?? {});
    const identities = new AgentIdentityStore(noopLogger);
    const cwd = defaultDispatcherCwd('flow');
    let identity = await ensureDispatcherIdentity(identities, {
      dispatcherId: 'flow',
      agentRuntime: dispatcher.agentRuntime,
      sourceCwd: cwd,
      cwd,
      runtimeCwd: cwd,
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: cwd,
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
    });
    if (opts.resumeSession !== undefined) {
      identity = await identities.update(identity, {
        sessionId: opts.resumeSession,
      });
    }
    const state = new AgentRuntimeStateStore(identities, identity);
    const runtime = claudeCodeProvider({
      sessionFactory: fleet.factory,
    }).createRuntime({
      identity: { runtime_id: 'flow', checkpoint_id: identity.session_id },
      config: dispatcherClaudeCodeConfig(dispatcher),
      cwd,
      mcpServers: [FEISHU_MCP],
      state,
      paths: hostRuntimePaths,
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.skillSources !== undefined
        ? { skillSources: opts.skillSources }
        : {}),
      ...(opts.disableFeatures !== undefined
        ? { disableFeatures: opts.disableFeatures }
        : {}),
      ...(opts.onTurnSettled !== undefined
        ? { onTurnSettled: opts.onTurnSettled }
        : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    runtimes.push(runtime);
    return {
      runtime,
      state,
      store: {
        get: (id: string) =>
          id === 'flow' ? { last_error: state.current().last_error } : null,
      },
      fleet,
    };
  }

  it('materializes neutral skillSources into a runtime-owned Claude add-dir', async () => {
    const fleet = fakeFleet();
    const skillRoot = join(home, 'team-skills');
    const skillDir = join(skillRoot, 'team-workflow');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: team-workflow\n---\n');
    const { runtime } = await makeRuntime(fleet, {
      skillSources: [{ name: 'team-skills', path: skillRoot, source: 'ext' }],
    });
    await runtime.start();
    const args = fleet.sessions[0]?.spec.args ?? [];
    const addDir = args[args.indexOf('--add-dir') + 1]!;
    expect(addDir).toContain(join(cacheRoot(), 'claude-code', 'skills'));
    expect(
      readlinkSync(
        join(
          addDir,
          '.claude',
          'skills',
          'team-workflow',
        ),
      ),
    ).toBe(skillDir);
  });

  it('rejects relative skill source roots instead of materializing cwd-dependent links', async () => {
    const fleet = fakeFleet();
    await expect(makeRuntime(fleet, {
      skillSources: [{ name: 'relative', path: 'relative/skills', source: 'test' }],
    })).rejects.toThrow(/path must be absolute/);
    expect(fleet.sessions).toEqual([]);
  });

  it('removes stale materialized skill links before rebuilding add-dir roots', async () => {
    const fleet = fakeFleet();
    const staleSource = join(home, 'stale-source');
    const currentSource = join(home, 'current-source');
    const currentSkill = join(currentSource, 'current');
    mkdirSync(staleSource, { recursive: true });
    mkdirSync(currentSkill, { recursive: true });
    writeFileSync(join(currentSkill, 'SKILL.md'), '---\nname: current\n---\n');
    const skillsRoot = join(cacheRoot(), 'claude-code', 'skills', 'stale-key', '.claude', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    symlinkSync(staleSource, join(skillsRoot, 'stale'), 'dir');

    const { runtime } = await makeRuntime(fleet, {
      skillSources: [
        { name: 'current', path: currentSource, source: 'test' },
      ],
    });
    await runtime.start();

    expect(existsSync(join(skillsRoot, 'stale'))).toBe(true);
    const args = fleet.sessions[0]?.spec.args ?? [];
    const addDir = args[args.indexOf('--add-dir') + 1]!;
    expect(readlinkSync(join(addDir, '.claude', 'skills', 'current'))).toBe(currentSkill);
  });

  it('emits no --add-dir when no neutral skill sources are supplied', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();
    expect(fleet.sessions[0]?.spec.args).not.toContain('--add-dir');
  });

  it('forwards systemPrompt.append to resident launch', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        append: ['Reviewer role.'],
      },
    });
    await runtime.start();

    const args = fleet.sessions[0]?.spec.args ?? [];
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      '<system-reminder>\n' +
        'Reviewer role.\n' +
        '</system-reminder>',
    );
  });

  it('wraps each systemPrompt.append item in its own system-reminder block', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        append: ['Default TeamLeader identity.', 'Architecture review rules.'],
      },
    });
    await runtime.start();

    const args = fleet.sessions[0]?.spec.args ?? [];
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      '<system-reminder>\n' +
        'Default TeamLeader identity.\n' +
        '</system-reminder>\n\n' +
        '<system-reminder>\n' +
        'Architecture review rules.\n' +
        '</system-reminder>',
    );
  });

  it('escapes each systemPrompt.append item inside its system-reminder block', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        append: [
          'Use <danger> & never close </system-reminder>',
          '',
        ],
      },
    });
    await runtime.start();

    const args = fleet.sessions[0]?.spec.args ?? [];
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      '<system-reminder>\n' +
        'Use &lt;danger&gt; &amp; never close &lt;/system-reminder&gt;\n' +
        '</system-reminder>',
    );
  });

  it('falls through to append when replace and append are both supplied', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        replace: 'Complete replacement prompt for replace-native runtimes.',
        append: ['Focused append prompt for Claude Code.'],
      },
    });
    await runtime.start();

    const args = fleet.sessions[0]?.spec.args ?? [];
    const i = args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(
      '<system-reminder>\nFocused append prompt for Claude Code.\n</system-reminder>',
    );
    expect(args[i + 1]).not.toContain('Complete replacement prompt');
  });

  it('ignores replace-only prompt because Claude Code has no replacement support', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        replace: 'Complete replacement prompt for replace-native runtimes.',
      },
    });
    await runtime.start();

    expect(fleet.sessions[0]?.spec.args).not.toContain('--append-system-prompt');
  });

  it('omits append prompt when all append items are empty strings', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      systemPrompt: {
        append: ['', ''],
      },
    });
    await runtime.start();

    expect(fleet.sessions[0]?.spec.args).not.toContain('--append-system-prompt');
  });

  it('forwards disableFeatures into Claude Code resident args', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet, {
      disableFeatures: ['userInterrupt', 'cron'],
    });
    await runtime.start();

    const args = fleet.sessions[0]?.spec.args ?? [];
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('AskUserQuestion,CronCreate,CronDelete,CronList');
  });

  it('start() passes the MCP config inline, spawns one resident session, and reports ready', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet);
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
    const args = fleet.sessions[0]?.spec.args ?? [];
    const mcpConfig = args[args.indexOf('--mcp-config') + 1]!;
    expect(JSON.parse(mcpConfig) as unknown).toEqual({
      mcpServers: {
        feishu: { command: FEISHU_MCP.command, args: FEISHU_MCP.args },
      },
    });
    expect(existsSync(join(cacheRoot(), 'claude-code', 'mcp'))).toBe(false);
  });

  it('threads agents[].config.remote_control into the resident session spec', async () => {
    const fleet = fakeFleet();
    const logs: string[] = [];
    // Pino-shaped fields-first: the message is the 2nd arg (or the 1st when
    // called bare). Capture whichever carries the message string. Typed to the
    // DreamuxLogFn overloads (fields+optional-message, or bare message).
    const pushLog = (fields: Record<string, unknown> | string, msg?: string): void =>
      void logs.push(typeof fields === 'string' ? fields : (msg ?? ''));
    const { runtime } = await makeRuntime(fleet, {
      config: { remote_control: true },
      logger: {
        error: pushLog,
        warn: pushLog,
        info: pushLog,
        debug: pushLog,
        trace: pushLog,
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
    const { runtime, store } = await makeRuntime(fleet);
    await expect(runtime.start()).rejects.toThrow('claude is missing');
    expect(runtime.getStatus()).toBe('degraded');
    await waitFor(() =>
      store.get('flow')?.last_error?.includes('claude is missing') ?? false,
    );
    expect(store.get('flow')?.last_error).toContain('claude is missing');
  });

  it('runs MULTIPLE turns over ONE resident process', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
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
    const { runtime } = await makeRuntime(fakeFleet());
    expect(runtime.wasCheckpointResumed()).toBe(false);
    expect((runtime.getCheckpoint()?.id ?? null)).toBeNull();
  });

  it('resumes a persisted session and threads --resume into the launch args', async () => {
    const fleet = fakeFleet([okOutcome('session-new')]);
    const { runtime } = await makeRuntime(fleet, { resumeSession: 'session-prev' });
    expect(runtime.wasCheckpointResumed()).toBe(true);
    expect((runtime.getCheckpoint()?.id ?? null)).toBe('session-prev');
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
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'do it' });
    expect(first.status).toBe('submitted');

    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.prompts[0]).toBe('do it');
    await waitFor(() => (runtime.getCheckpoint()?.id ?? null) === 'session-abc');

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
    const { runtime } = await makeRuntime(fleet, {
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
        result: { text: 'done' },
      },
    ]);
  });

  it('folds Dreamux-owned completionInput sends into the active logical turn', async () => {
    // PR #282 E2E regression: spawn a TeamMate turn that does `sleep 30`, then
    // `send` two follow-ups (S30_B, S30_C) while the first is in-flight. Before
    // the fix each `send` (which routes through `completionInput`) created its
    // own logical turn + its own completion, so B/C produced "收到 S30_B" /
    // "收到 S30_C" instead of folding into the active turn. The runtime must
    // treat `completionInput` the same way it already treated `channelInput`:
    // same active steerable slot, same turnId, one settled signal.
    const settled: TurnSettledSignal[] = [];
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const first = await runtime.completionInput({
      text: 'sleep 30; echo CLAUDE_SLEEP30_BURST_FINAL tokens=S30_A,S30_B,S30_C',
      sourceId: 'send:mate-1:first',
    });
    expect(first.status).toBe('submitted');
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    const second = await runtime.completionInput({
      text: 'S30_B',
      sourceId: 'send:mate-1:second',
    });
    const third = await runtime.completionInput({
      text: 'S30_C',
      sourceId: 'send:mate-1:third',
    });
    // Both follow-ups fold into the active logical turn and return its id.
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // The first prompt is the original send; S30_B and S30_C are steered in
    // with `priority: 'next'` (the Codex-aligned active-slot semantics).
    expect(fleet.sessions[0]?.prompts).toEqual([
      'sleep 30; echo CLAUDE_SLEEP30_BURST_FINAL tokens=S30_A,S30_B,S30_C',
      'S30_B',
      'S30_C',
    ]);
    expect(fleet.sessions[0]?.submitOptions).toEqual([
      { isSynthetic: false },
      { priority: 'next' },
      { priority: 'next' },
    ]);

    // A single logical turn settles.
    fleet.resolveNext(okOutcome('session-abc'));
    await waitFor(() => settled.length === 1);
    if (first.status !== 'submitted') {
      throw new Error('expected first submitted');
    }
    expect(settled).toEqual([
      {
        turnId: first.turnId,
        status: 'completed',
        result: { text: 'done' },
      },
    ]);
  });

  it('folds a channel inbound into an active completionInput turn', async () => {
    // The active slot is shared, not channel-only: a Dreamux-owned send that
    // started the turn must also accept channel-XML inbound as a steer. When
    // the steer arrives before the resident child has picked up the initial
    // submit, it lands in `pendingSteers` and is prepended to the full prompt
    // at turn-start (same path the existing channel-folding test uses for the
    // pre-session window).
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const first = await runtime.completionInput({
      text: 'first send',
      sourceId: 'send:mate-1:first',
    });
    expect(first.status).toBe('submitted');

    const second = await runtime.channelInput({
      sourceId: 'm-inbound',
      text: 'inbound follow-up',
      body: 'inbound follow-up',
      source: 'feishu',
      attrs: [
        ['chat_id', 'oc:chat-1'],
        ['message_id', 'om:msg-2'],
      ],
    });
    // Channel inbound folds into the active turn and returns the same id.
    expect(second).toEqual(first);

    await waitFor(() => settled.length === 1);
    // The single submitted prompt carries both the original plain text and the
    // channel-rendered inbound (the steer was pending and got joined).
    const fullPrompt = fleet.sessions[0]?.prompts[0] ?? '';
    expect(fullPrompt).toContain('first send');
    expect(fullPrompt).toContain('<channel source="feishu"');
    expect(fullPrompt).toContain('inbound follow-up');
    // The initial completionInput turn is a real user turn, not synthetic.
    expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
    if (first.status !== 'submitted') {
      throw new Error('expected first submitted');
    }
    expect(settled[0]?.turnId).toBe(first.turnId);
  });

  it('starts a fresh logical turn for completionInput after the prior turn settled', async () => {
    // Preserves the existing "sequential turns get distinct ids" invariant for
    // the plain-text path (the channel path already has this test).
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    const first = await runtime.completionInput({
      text: 'first',
      sourceId: 'send:mate-1:first',
    });
    await waitFor(() => settled.length === 1);
    const second = await runtime.completionInput({
      text: 'second',
      sourceId: 'send:mate-1:second',
    });
    await waitFor(() => settled.length === 2);

    expect(first.status).toBe('submitted');
    expect(second.status).toBe('submitted');
    if (first.status !== 'submitted' || second.status !== 'submitted') {
      throw new Error('expected submitted turns');
    }
    expect(first.turnId).not.toBe(second.turnId);
    expect(settled.map((s) => s.turnId)).toEqual([first.turnId, second.turnId]);
  });

  it('does not reuse the prior successful result for a later empty successful turn', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([
      okOutcome('session-abc'),
      { ...okOutcome('session-abc'), text: '' },
    ]);
    const { runtime } = await makeRuntime(fleet, {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();

    await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    await waitFor(() => settled.length === 1);
    await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    await waitFor(() => settled.length === 2);

    expect(settled.map((s) => s.result?.text ?? null)).toEqual(['done', null]);
    expect(await runtime.getLast()).toEqual({ text: 'done' });
  });

  it('starts a fresh logical turn for a sequential send after the previous turn completed', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet, {
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
    const firstRuntime = await makeRuntime(fakeFleet([okOutcome('session-abc')]), {
      onTurnSettled: (s) => firstSettled.push(s),
    });
    await firstRuntime.runtime.start();
    const first = await firstRuntime.runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    await waitFor(() => firstSettled.length === 1);

    const secondSettled: TurnSettledSignal[] = [];
    const secondRuntime = await makeRuntime(fakeFleet([okOutcome('session-abc')]), {
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

  it('delivers completionInput as a plain user turn', async () => {
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const deliveryPromise = runtime.completionInput({
      text: 'TeamMate reviewer has finished its task. Output below:\n\nall done',
      sourceId: 'completion:mate-1',
    });
    // The turn is queued but the session outcome is NOT resolved yet.
    // The delivery should return submitted immediately (submit-then-serialize),
    // decoupled from model thinking time.
    const result = await deliveryPromise;
    expect(result).toMatchObject({ status: 'submitted' });
    if (result.status !== 'submitted') {
      throw new Error('expected submitted completionInput result');
    }
    expect(result.turnId).toMatch(/^claude-turn-\d+-1$/u);

    // The turn is still pending in the fleet. Resolve it so it cleans up.
    fleet.resolveNext(okOutcome('session-abc'));
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    const prompt = fleet.sessions[0]?.prompts[0] ?? '';
    expect(prompt).toBe('TeamMate reviewer has finished its task. Output below:\n\nall done');
    expect(prompt).not.toContain('<task-notification>');
    expect(prompt).not.toContain('<task-id>');
    expect(prompt).not.toContain('<teammate_session_completion');
    // Delivered as ordinary input, NOT a synthetic notification.
    expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
  });

  it('accepts completionInput with outputSchema (one-shot schema turn)', async () => {
    const { runtime } = await makeRuntime(fakeFleet());
    await runtime.start();

    const result = await runtime.completionInput({
      text: 'return structured output',
      sourceId: 'completion:schema',
      outputSchema: { type: 'object' },
    });

    // outputSchema is now supported via a one-shot `claude --print --json-schema`
    // spawn (not the resident session), so the turn is accepted as submitted.
    expect(result).toMatchObject({ status: 'submitted' });
  });

  it('returns stopped for completionInput after stop', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();
    await runtime.stop();
    const stoppedResult = await runtime.completionInput({
      text: 'late',
      sourceId: 'completion:mate-stop',
    });
    expect(stoppedResult.status).toBe('stopped');
  });

  it('dedupes repeated completionInput sourceIds', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();
    await expect(
      runtime.completionInput({ text: 'done once', sourceId: 'completion:mate-1' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    await expect(
      runtime.completionInput({ text: 'done once', sourceId: 'completion:mate-1' }),
    ).resolves.toEqual({ status: 'duplicate' });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
  });

  it('does not mark a normal channel turn as synthetic', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    await runtime.channelInput({ sourceId: 'm1', text: 'hello' });
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.submitOptions[0]).toBeUndefined();
  });

  it('wraps a structured channel input into the native <channel> block', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
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
    const { runtime } = await makeRuntime(fleet);
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
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();
    expect(runtime.getStatus()).toBe('ready');

    const submit = await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    expect(submit.status).toBe('submitted');

    await waitFor(() =>
      runtime.getStatus() === 'degraded' &&
      (store.get('flow')?.last_error?.includes('turn boom') ?? false),
    );
    expect(store.get('flow')?.last_error).toContain('turn boom');
  });

  it('surfaces an error result envelope as a degraded turn', async () => {
    const fleet = fakeFleet([
      { isError: true, text: '', sessionId: 'session-abc', subtype: 'error_during_execution', errors: ['model overloaded'] },
    ]);
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();
    await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    await waitFor(() =>
      runtime.getStatus() === 'degraded' &&
      (store.get('flow')?.last_error?.includes('model overloaded') ?? false),
    );
    expect(store.get('flow')?.last_error).toContain('model overloaded');
  });

  it('recovers to ready after a failed turn is followed by a successful one', async () => {
    const fleet = fakeFleet([new Error('transient'), okOutcome('session-2')]);
    const { runtime } = await makeRuntime(fleet);
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
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();

    // First turn establishes the session id.
    await runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    await waitFor(() => (runtime.getCheckpoint()?.id ?? null) === 'session-abc');

    // The resident child dies unexpectedly → degraded.
    fleet.sessions[0]?.triggerExit();
    await waitFor(() =>
      runtime.getStatus() === 'degraded' &&
      (store.get('flow')?.last_error?.includes('exited') ?? false),
    );
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
    const { runtime, store } = await makeRuntime(fleetFromFactory(stallFactory));
    await runtime.start();

    await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    await waitFor(
      () => (
        runtime.getStatus() === 'degraded' &&
        /stalled|no stream activity/i.test(store.get('flow')?.last_error ?? '')
      ),
      5000,
    );
    expect(store.get('flow')?.last_error).toMatch(/stalled|no stream activity/i);

    // Delivery must return submitted immediately since acceptance is now
    // decoupled from model outcome. The async turn failure degrades the runtime.
    const delivery = await runtime.completionInput({
      text: 'done',
      sourceId: 'completion:mate-1',
    });
    expect(delivery.status).toBe('submitted');

    await runtime.stop();
  });

  it('degrades the runtime when a TeamMate completion turn fails asynchronously', async () => {
    const fleet = fakeFleet([new Error('delivery boom')]);
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();

    const result = await runtime.completionInput({
      text: 'done',
      sourceId: 'completion:mate-1',
    });
    expect(result.status).toBe('submitted');

    // A delivery failure degrades the whole runtime just like a channel turn
    await waitFor(() =>
      runtime.getStatus() === 'degraded' &&
      (store.get('flow')?.last_error?.includes('delivery boom') ?? false),
    );
    expect(store.get('flow')?.last_error).toContain('delivery boom');
  });

  it('fires onTurnSettled(completed) with the turn id when an inbound turn succeeds', async () => {
    const settled: TurnSettledSignal[] = [];
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet, {
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
    const { runtime } = await makeRuntime(fleet, {
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
    const { runtime } = await makeRuntime(fleetFromFactory(blockingFactory), {
      onTurnSettled: (s) => settled.push(s),
    });
    await runtime.start();
    await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    await waitFor(() => releaseTurn !== null);

    await runtime.stop();
    await waitFor(() => settled.length === 1);
    expect(settled[0]?.status).toBe('stopped');
  });
});
