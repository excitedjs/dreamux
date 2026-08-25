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
import { randomUUID } from 'node:crypto';
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
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
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

const TEST_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PREVIOUS_SESSION_ID = '00000000-0000-4000-8000-000000000002';

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
  return { isError: false, text: 'done', sessionId, subtype: 'success', errors: [], hasStructuredOutput: false };
}

function pinnedSessionId(spec: ClaudeCodeSessionSpec): string | null {
  for (const flag of ['--session-id', '--resume']) {
    const index = spec.args.indexOf(flag);
    if (index >= 0) return spec.args[index + 1] ?? null;
  }
  return null;
}

/**
 * The native result no longer travels back through the `submitTurn` promise —
 * that promise now only reports "every accepted command drained". Attribution
 * and settlement travel over the `onProtocolEvent` seam instead, so a faithful
 * session double has to replay the same two protocol facts the resident CLI
 * emits: a `command_lifecycle` `started` that names which submitted commands
 * the next result speaks for, then the `result` envelope itself.
 */
function emitCommandStarted(
  spec: ClaudeCodeSessionSpec,
  commandUuid: string,
): void {
  spec.onProtocolEvent?.({
    kind: 'command_lifecycle',
    commandUuid,
    state: 'started',
  });
}

function emitResult(spec: ClaudeCodeSessionSpec, outcome: TurnOutcome): void {
  spec.onProtocolEvent?.({ kind: 'result', outcome });
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
      async submitTurn(prompt, options, commandUuid = randomUUID()) {
        prompts.push(prompt);
        submitOptions.push(options);
        const outcome = outcomes[Math.min(turnIndex, outcomes.length - 1)];
        turnIndex += 1;
        if (outcome instanceof Error) throw outcome;
        // Publish the result BEFORE resolving: the runtime drops protocol
        // events once `submitTurn` resolves and it releases the active turn.
        emitCommandStarted(spec, commandUuid);
        emitResult(spec, { ...outcome, sessionId: pinnedSessionId(spec) });
      },
      async steerTurn(prompt, options, commandUuid = randomUUID()) {
        prompts.push(prompt);
        submitOptions.push(options);
        // A live steer joins the in-flight command group; the CLI announces it
        // with its own `started`, and the next `result` then speaks for every
        // started command at once.
        emitCommandStarted(spec, commandUuid);
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

/**
 * A fleet whose native result is released by the TEST, not by `submitTurn`.
 *
 * `submitTurn` announces its `command_lifecycle` `started` immediately and then
 * parks: while it is parked the runtime still owns an active turn, so later
 * sends take the live-steer path and join the SAME command group. `resolveNext`
 * publishes the one `result` envelope that speaks for every started command and
 * only then drains the submit promise — the same ordering the real resident CLI
 * produces, and the ordering the runtime requires (it drops protocol events once
 * it releases the active turn).
 */
function controllableFleet(): FakeFleet & {
  resolveNext(outcome?: TurnOutcome): void;
} {
  const sessions: FakeSession[] = [];
  let pendingResolve: (() => void) | null = null;
  let pendingResult: ((outcome: TurnOutcome) => void) | null = null;
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
      async submitTurn(prompt, options, commandUuid = randomUUID()) {
        prompts.push(prompt);
        submitOptions.push(options);
        emitCommandStarted(spec, commandUuid);
        return new Promise<void>((resolve) => {
          pendingResolve = resolve;
          pendingResult = (outcome) =>
            emitResult(spec, { ...outcome, sessionId: pinnedSessionId(spec) });
        });
      },
      async steerTurn(prompt, options, commandUuid = randomUUID()) {
        prompts.push(prompt);
        submitOptions.push(options);
        emitCommandStarted(spec, commandUuid);
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
      pendingResult?.(outcome);
      pendingResolve?.();
      pendingResolve = null;
      pendingResult = null;
    },
  };
}

/** Narrow an admission to the one accepted submission it carries. */
function submittedSubmission(admission: RuntimeAdmission): RuntimeSubmission {
  if (admission.status !== 'submitted') {
    throw new Error(`expected a submitted admission, got ${admission.status}`);
  }
  return admission.submission;
}

/**
 * Narrow a settlement to the provider-observed completion token it carries.
 * `{kind:'failed'}` and `{kind:'stopped'}` deliberately carry NO token.
 */
function expectCompletion(
  settlement: RuntimeSubmissionSettlement,
): RuntimeCompletion {
  if (settlement.kind !== 'completion') {
    throw new Error(`expected a completion settlement, got ${settlement.kind}`);
  }
  return settlement.completion;
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
    expect(provider.getCapabilities()).toEqual({
      resume: { supported: true },
      structuredOutput: { supported: true, scope: 'create-context' },
    });
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
    process.env['DREAMUX_ROOT'] = home;
  });

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(home, { recursive: true, force: true });
  });

  async function makeRuntime(
    fleet: FakeFleet,
    opts: {
      resumeSession?: string;
      systemPrompt?: AgentRuntimeSystemPrompt;
      skillSources?: AgentRuntimeSkillSource[];
      disableFeatures?: readonly string[];
      outputSchema?: Record<string, unknown>;
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
      generateSessionId: () => TEST_SESSION_ID,
      resolveTranscriptPath: async ({ sessionId }) =>
        join(cwd, `${sessionId}.jsonl`),
    }).createRuntime({
      identity: {
        runtime_id: 'flow',
        checkpoint:
          identity.session_id === null
            ? null
            : {
                id: identity.session_id,
                transcript_locator: identity.transcript_locator,
              },
      },
      config: dispatcherClaudeCodeConfig(dispatcher),
      cwd,
      mcpServers: [FEISHU_MCP],
      state,
      paths: hostRuntimePaths,
      // Required by the create context: the sink is installed before start so
      // no native activity fact can be produced without a live consumer.
      activitySink: () => {},
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.skillSources !== undefined
        ? { skillSources: opts.skillSources }
        : {}),
      ...(opts.disableFeatures !== undefined
        ? { disableFeatures: opts.disableFeatures }
        : {}),
      outputSchema: opts.outputSchema,
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
    const { runtime } = await makeRuntime(fleet, {
      resumeSession: PREVIOUS_SESSION_ID,
    });
    expect(runtime.wasCheckpointResumed()).toBe(true);
    expect((runtime.getCheckpoint()?.id ?? null)).toBe(PREVIOUS_SESSION_ID);
    await runtime.start();
    expect(
      fleet.sessions[0]?.spec.args.slice(
        fleet.sessions[0].spec.args.indexOf('--resume'),
        fleet.sessions[0].spec.args.indexOf('--resume') + 2,
      ),
    ).toEqual(['--resume', PREVIOUS_SESSION_ID]);
  });

  it('submits an inbound turn (accept -> run), dedupes, and captures the session', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'do it' });
    expect(first.status).toBe('submitted');

    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    expect(fleet.sessions[0]?.prompts[0]).toBe('do it');
    await waitFor(() => (runtime.getCheckpoint()?.id ?? null) === TEST_SESSION_ID);

    const dup = await runtime.channelInput({
      sourceId: 'm1',
      text: 'do it again',
    });
    expect(dup.status).toBe('duplicate');
    expect(fleet.sessions[0]?.prompts).toHaveLength(1);
  });

  it('returns the structural unsupported-feature error for outputSchema', async () => {
    const { runtime } = await makeRuntime(fakeFleet());
    await runtime.start();

    const result = await runtime.completionInput({
      text: 'return structured output',
      sourceId: 'completion:schema',
      outputSchema: { type: 'object' },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
        message:
          'claude-code runtime does not support per-turn outputSchema on the resident session',
      },
    });
  });

  it('applies --json-schema from the create context on resident spawn', async () => {
    const fleet = fakeFleet();
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    const { runtime } = await makeRuntime(fleet, { outputSchema: schema });
    await runtime.start();
    const args = fleet.sessions[0]?.spec.args ?? [];
    const flagIndex = args.indexOf('--json-schema');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(JSON.stringify(schema));
  });

  it('omits --json-schema when no create-context schema is set', async () => {
    const fleet = fakeFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();
    const args = fleet.sessions[0]?.spec.args ?? [];
    expect(args).not.toContain('--json-schema');
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

  it('surfaces an error result envelope as a failed completion, not runtime degradation', async () => {
    // Contract change: a native `result` carrying an error subtype IS a real
    // provider-observed completion boundary. It now settles the submission with
    // an opaque `failed` completion token routed back to the sender, instead of
    // the pre-split behaviour where the error escaped through the submitTurn
    // promise and degraded the whole runtime. `{kind:'failed'}` stays reserved
    // for internal terminal states that produce no completion token at all.
    const fleet = fakeFleet([
      { isError: true, text: '', sessionId: 'session-abc', subtype: 'error_during_execution', errors: ['model overloaded'], hasStructuredOutput: false },
    ]);
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();
    const admission = await runtime.channelInput({
      sourceId: 'm1',
      text: 'go',
    });
    if (admission.status !== 'submitted') {
      throw new Error(`expected submitted, got ${admission.status}`);
    }

    const settlement = await admission.submission.settled;
    if (settlement.kind !== 'completion') {
      throw new Error(`expected a completion settlement, got ${settlement.kind}`);
    }
    const { completion } = settlement;
    if (completion.status !== 'failed') {
      throw new Error(`expected a failed completion, got ${completion.status}`);
    }
    expect(completion.error.message).toContain('model overloaded');
    // The token is frozen, provider-owned, and displays through the one
    // submission that represents this native stream.
    expect(completion.displaySubmission).toBe(admission.submission);
    expect(Object.isFrozen(completion)).toBe(true);

    // The turn drained normally: an error result is a per-completion outcome,
    // so the resident runtime stays healthy and records no last_error. The
    // extra tick gives an (incorrect) asynchronous degrade time to land, since
    // markTurnFailed releases waitIdle before it persists `degraded`.
    await runtime.waitIdle?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.getStatus()).toBe('ready');
    expect(store.get('flow')?.last_error).toBeNull();
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

  it('steers follow-up sends into the active channel turn and settles once', async () => {
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    expect(first.status).toBe('submitted');
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

    const second = await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    const third = await runtime.channelInput({ sourceId: 'm3', text: 'third' });
    expect(second.status).toBe('submitted');
    expect(third.status).toBe('submitted');
    const submissions = [first, second, third].map(submittedSubmission);
    // Every accepted send gets its OWN submission — object identity never
    // implies folding under the locked contract.
    expect(submissions[1]).not.toBe(submissions[0]);
    expect(submissions[2]).not.toBe(submissions[0]);

    expect(fleet.sessions[0]?.prompts).toEqual(['first', 'second', 'third']);
    expect(fleet.sessions[0]?.submitOptions).toEqual([
      undefined,
      { priority: 'next' },
      { priority: 'next' },
    ]);

    fleet.resolveNext(okOutcome('session-abc'));
    const completions = await Promise.all(
      submissions.map(async (submission) =>
        expectCompletion(await submission.settled),
      ),
    );
    // ONE native result -> ONE shared frozen token. Because the token is
    // `Object.is`-identical for all three sends, the sender is pushed once.
    expect(completions[1]).toBe(completions[0]);
    expect(completions[2]).toBe(completions[0]);
    expect(new Set(completions).size).toBe(1);
    expect(completions[0]).toMatchObject({
      status: 'completed',
      resultText: 'done',
      truncated: false,
    });
    expect(completions[0]?.displaySubmission).toBe(submissions[0]);
    expect(Object.isFrozen(completions[0])).toBe(true);
  });

  it('folds Dreamux-owned completionInput sends into the active logical turn', async () => {
    // PR #282 E2E regression: spawn a TeamMate turn that does `sleep 30`, then
    // `send` two follow-ups (S30_B, S30_C) while the first is in-flight. Before
    // the fix each `send` (which routes through `completionInput`) created its
    // own logical turn + its own completion, so B/C produced "收到 S30_B" /
    // "收到 S30_C" instead of folding into the active turn. Under the locked
    // contract `completionInput` must behave exactly like `channelInput`: same
    // active steerable slot, ONE native result, ONE shared completion token.
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet);
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
    expect(second.status).toBe('submitted');
    expect(third.status).toBe('submitted');
    const submissions = [first, second, third].map(submittedSubmission);

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

    fleet.resolveNext(okOutcome('session-abc'));
    const completions = await Promise.all(
      submissions.map(async (submission) =>
        expectCompletion(await submission.settled),
      ),
    );
    // One logical turn settles: one token, so one push for the burst.
    expect(new Set(completions).size).toBe(1);
    expect(completions[1]).toBe(completions[0]);
    expect(completions[2]).toBe(completions[0]);
    expect(completions[0]).toMatchObject({
      status: 'completed',
      resultText: 'done',
      truncated: false,
    });
    expect(completions[0]?.displaySubmission).toBe(submissions[0]);
  });

  it('folds a channel inbound into an active completionInput turn', async () => {
    // The active slot is shared, not channel-only: a Dreamux-owned send that
    // started the turn must also accept channel-XML inbound as a steer. The
    // first native outcome is held open so the steer deterministically reaches
    // the same active command group.
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.completionInput({
      text: 'first send',
      sourceId: 'send:mate-1:first',
    });
    expect(first.status).toBe('submitted');
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);

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
    expect(second.status).toBe('submitted');
    const firstSubmission = submittedSubmission(first);
    const secondSubmission = submittedSubmission(second);

    fleet.resolveNext();
    const firstCompletion = expectCompletion(await firstSubmission.settled);
    const secondCompletion = expectCompletion(await secondSubmission.settled);
    // The same native result carries both the original plain text and the
    // channel-rendered inbound, so both sends settle with the SAME token.
    expect(secondCompletion).toBe(firstCompletion);
    expect(firstCompletion.status).toBe('completed');
    expect(firstCompletion.displaySubmission).toBe(firstSubmission);

    const modelInput = fleet.sessions[0]?.prompts.join('\n\n') ?? '';
    expect(modelInput).toContain('first send');
    expect(modelInput).toContain('<channel source="feishu"');
    expect(modelInput).toContain('inbound follow-up');
    // The initial completionInput turn is a real user turn, not synthetic.
    expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
  });

  it('starts a fresh logical turn for completionInput after the prior turn settled', async () => {
    // Sequential submissions are QUEUED, not folded: each native result creates
    // its own token even though both results are byte-identical.
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.completionInput({
      text: 'first',
      sourceId: 'send:mate-1:first',
    });
    const firstCompletion = expectCompletion(
      await submittedSubmission(first).settled,
    );
    // The active slot is only released after the submit promise drains; wait
    // for idle so the next send genuinely queues instead of steering.
    await runtime.waitIdle?.();

    const second = await runtime.completionInput({
      text: 'second',
      sourceId: 'send:mate-1:second',
    });
    const secondCompletion = expectCompletion(
      await submittedSubmission(second).settled,
    );

    expect(submittedSubmission(second)).not.toBe(submittedSubmission(first));
    expect(secondCompletion).not.toBe(firstCompletion);
    expect([firstCompletion.status, secondCompletion.status]).toEqual([
      'completed',
      'completed',
    ]);
    // Two distinct tokens with identical payloads -> one push EACH, in order.
    expect(firstCompletion).toMatchObject({ resultText: 'done' });
    expect(secondCompletion).toMatchObject({ resultText: 'done' });
  });

  it('does not reuse the prior successful result for a later empty successful turn', async () => {
    const fleet = fakeFleet([
      okOutcome('session-abc'),
      { ...okOutcome('session-abc'), text: '' },
    ]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    const firstCompletion = expectCompletion(
      await submittedSubmission(first).settled,
    );
    await runtime.waitIdle?.();

    const second = await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    const secondCompletion = expectCompletion(
      await submittedSubmission(second).settled,
    );

    expect(secondCompletion).not.toBe(firstCompletion);
    expect(
      [firstCompletion, secondCompletion].map((completion) =>
        completion.status === 'completed' ? completion.resultText : null,
      ),
    ).toEqual(['done', null]);
  });

  it('starts a fresh logical turn for a sequential send after the previous turn completed', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const first = await runtime.channelInput({ sourceId: 'm1', text: 'first' });
    const firstCompletion = expectCompletion(
      await submittedSubmission(first).settled,
    );
    await runtime.waitIdle?.();

    const second = await runtime.channelInput({ sourceId: 'm2', text: 'second' });
    const secondCompletion = expectCompletion(
      await submittedSubmission(second).settled,
    );

    expect(submittedSubmission(second)).not.toBe(submittedSubmission(first));
    // Distinct native results -> distinct tokens, even byte-identical ones.
    expect(secondCompletion).not.toBe(firstCompletion);
    expect([firstCompletion.status, secondCompletion.status]).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('does not reuse logical Turn objects across resumed runtime instances', async () => {
    const firstRuntime = await makeRuntime(fakeFleet([okOutcome('session-abc')]));
    await firstRuntime.runtime.start();
    const first = await firstRuntime.runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    const firstCompletion = expectCompletion(
      await submittedSubmission(first).settled,
    );

    const secondRuntime = await makeRuntime(fakeFleet([okOutcome('session-abc')]), {
      resumeSession: TEST_SESSION_ID,
    });
    await secondRuntime.runtime.start();
    const second = await secondRuntime.runtime.channelInput({
      sourceId: 'm2',
      text: 'second',
    });
    const secondCompletion = expectCompletion(
      await submittedSubmission(second).settled,
    );

    // A resumed instance never inherits the prior instance's submission or its
    // completion token: each native result owns a fresh identity.
    expect(submittedSubmission(second)).not.toBe(submittedSubmission(first));
    expect(secondCompletion).not.toBe(firstCompletion);
  });

  it('delivers completionInput as a plain user turn', async () => {
    const fleet = controllableFleet();
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    // The turn is queued but the native result is NOT released yet. The
    // delivery must return submitted immediately (submit-then-serialize),
    // decoupled from model thinking time.
    const result = await runtime.completionInput({
      text: 'TeamMate reviewer has finished its task. Output below:\n\nall done',
      sourceId: 'completion:mate-1',
    });
    expect(result).toMatchObject({ status: 'submitted' });
    const submission = submittedSubmission(result);
    expect(submission.settled).toBeInstanceOf(Promise);

    // Admission returns before the resident session has necessarily installed
    // its native outcome resolver. Wait for native submission, then release it
    // so teardown never races an unsettled submission.
    await waitFor(() => fleet.sessions[0]?.prompts.length === 1);
    fleet.resolveNext(okOutcome('session-abc'));
    expect(expectCompletion(await submission.settled).status).toBe('completed');

    const prompt = fleet.sessions[0]?.prompts[0] ?? '';
    expect(prompt).toBe('TeamMate reviewer has finished its task. Output below:\n\nall done');
    expect(prompt).not.toContain('<task-notification>');
    expect(prompt).not.toContain('<task-id>');
    expect(prompt).not.toContain('<teammate_session_completion');
    // Delivered as ordinary input, NOT a synthetic notification.
    expect(fleet.sessions[0]?.submitOptions[0]).toEqual({ isSynthetic: false });
  });

  it('fails a completed schema turn that lacks native structured_output', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    // `okOutcome` carries `hasStructuredOutput: false`, i.e. claude returned a
    // successful `result` envelope with no validated structured object.
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet, { outputSchema: schema });
    await runtime.start();

    const admission = await runtime.completionInput({
      text: 'return structured output',
      sourceId: 'completion:schema-native',
      outputSchema: schema,
    });
    expect(admission.status).toBe('submitted');

    const completion = expectCompletion(
      await submittedSubmission(admission).settled,
    );
    // A native result that violates the session's --json-schema is still a
    // provider-observed completion boundary: it settles as a `failed`
    // COMPLETION token (which is routed to the sender), not as an internal
    // `{kind:'failed'}` (which produces no token at all).
    expect(completion.status).toBe('failed');
    if (completion.status !== 'failed') throw new Error('expected failed completion');
    expect(completion.error.message).toContain('did not return structured_output');
    expect(completion.displaySubmission).toBe(submittedSubmission(admission));
    expect(Object.isFrozen(completion)).toBe(true);
  });

  it('degrades on an unexpected child exit and re-spawns (with --resume) on the next turn', async () => {
    const fleet = fakeFleet([okOutcome('session-abc'), okOutcome('session-abc')]);
    const { runtime, store } = await makeRuntime(fleet);
    await runtime.start();

    // First turn establishes the session id.
    const first = await runtime.channelInput({
      sourceId: 'm1',
      text: 'first',
    });
    expect(
      expectCompletion(await submittedSubmission(first).settled).status,
    ).toBe('completed');
    await runtime.waitIdle?.();
    await waitFor(() => (runtime.getCheckpoint()?.id ?? null) === TEST_SESSION_ID);

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
    )).toEqual(['--resume', TEST_SESSION_ID]);
    await waitFor(() => runtime.getStatus() === 'ready');
  });

  it('settles the submitted RuntimeSubmission as completed', async () => {
    const fleet = fakeFleet([okOutcome('session-abc')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const submit = await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    expect(submit.status).toBe('submitted');
    const submission = submittedSubmission(submit);

    const completion = expectCompletion(await submission.settled);
    expect(completion.status).toBe('completed');
    if (completion.status !== 'completed') throw new Error('expected completed');
    expect(completion.resultText).toBe('done');
    expect(completion.truncated).toBe(false);
    // The token is a frozen, provider-owned opaque identity that displays
    // through the one submission representing this native stream.
    expect(completion.displaySubmission).toBe(submission);
    expect(Object.isFrozen(completion)).toBe(true);
  });

  it('settles the submitted RuntimeSubmission as failed', async () => {
    const fleet = fakeFleet([new Error('turn boom')]);
    const { runtime } = await makeRuntime(fleet);
    await runtime.start();

    const submit = await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    const settlement = await submittedSubmission(submit).settled;
    // A submit that dies before any native result is NOT a completion: it
    // carries no token, so nothing is ever pushed for it.
    expect(settlement.kind).toBe('failed');
    if (settlement.kind !== 'failed') throw new Error('expected failed settlement');
    expect(settlement.error.message).toContain('turn boom');
  });

  it('settles the submitted RuntimeSubmission as stopped when stop wins', async () => {
    // A submit that never drains on its own; stop() tears the session down,
    // which rejects the in-flight submit — it must settle as `stopped`, and a
    // `stopped` settlement creates no completion token at all.
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
          return new Promise<void>((_resolve, reject) => {
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
    const { runtime } = await makeRuntime(fleetFromFactory(blockingFactory));
    await runtime.start();
    const submit = await runtime.channelInput({ sourceId: 'm1', text: 'go' });
    const submission = submittedSubmission(submit);
    await waitFor(() => releaseTurn !== null);

    await runtime.stop();
    await expect(submission.settled).resolves.toEqual({ kind: 'stopped' });
  });
});
