import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRuntimeProviderCatalog,
  type AgentRuntime,
  type AgentRuntimeCapabilities,
  type AgentRuntimeCreateContext,
  type AgentRuntimeLastResult,
  type AgentRuntimeProvider,
  type AgentRuntimeResumeInput,
  type AgentRuntimeSystemInput,
  type AgentRuntimeTurnResult,
  type CompletionEnvelope,
} from '../src/agent-runtime/index.js';
import type { TurnSettledSignal } from '../src/agent-runtime/turn.js';
import type { InboundTurnInput } from '../src/agent-runtime/turn.js';
import { TeamMateAgentService } from '../src/dispatcher-service/teammate/service.js';
import { teamServicePrincipal } from '../src/dispatcher-service/teammate/types.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  dispatcherCompletionSpillDir,
  dispatcherTeamMateDir,
  dispatcherTeamMateRecordsDir,
  dispatcherTeamMateRecordPath,
  dispatcherTeamMateTurnsPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: true },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: ReturnType<AgentRuntime['getStatus']> = 'declared';
  private threadId: string | null = null;
  private resumed = false;
  private turns = 0;
  readonly submitted: InboundTurnInput[] = [];
  /** Overridable last-assistant text so tests can drive capture/truncation. */
  lastText = 'last fake result';

  constructor(private readonly context: AgentRuntimeCreateContext) {}

  async start(): Promise<void> {
    this.status = 'ready';
    this.threadId = `${this.context.row.dispatcher_id}-thread`;
    await this.context.state?.setThreadId(
      this.context.row.dispatcher_id,
      this.threadId,
    );
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async resume(input: AgentRuntimeResumeInput = {}): Promise<void> {
    this.resumed = true;
    this.status = 'ready';
    this.threadId = input.checkpoint?.id ?? null;
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'ready');
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    await this.context.state?.setStatus(this.context.row.dispatcher_id, 'stopped');
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    this.turns += 1;
    return { status: 'submitted', turnId: `turn-${this.turns}` };
  }

  async systemInput(_notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }

  getStatus(): ReturnType<AgentRuntime['getStatus']> {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  wasThreadResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: this.lastText };
  }

  async getContext(): Promise<{ usedTokens: number; windowTokens: number }> {
    return { usedTokens: 12, windowTokens: 100 };
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  /** True when the launcher wired the reverse-delivery settle hook. */
  hasSettleHook(): boolean {
    return this.context.onTurnSettled !== undefined;
  }

  /** Simulate the runtime firing a terminal turn-settled signal. */
  settle(status: TurnSettledSignal['status'], turnId: string | null): void {
    this.context.onTurnSettled?.({ turnId, status });
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref: string;
  readonly runtimes: FakeRuntime[] = [];
  /** Every create context this provider was asked to build, for assertions. */
  readonly contexts: AgentRuntimeCreateContext[] = [];

  constructor(
    readonly descriptor: AgentRuntimeProvider['descriptor'],
    ref: string = 'builtin:codex',
  ) {
    this.ref = ref;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }

  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
    this.contexts.push(context);
    const runtime = new FakeRuntime(context);
    this.runtimes.push(runtime);
    return runtime;
  }
}

function providerCatalog(): {
  catalog: AgentRuntimeProviderCatalog;
  provider: FakeProvider;
} {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  const provider = new FakeProvider(descriptor);
  registry.registerImplementation(descriptor.id, provider);
  return {
    catalog: new AgentRuntimeProviderCatalog({ registry }),
    provider,
  };
}

/**
 * The dispatcher workspace cwd for the current test (issue #182 PR-4); set in
 * beforeEach to a non-`~/.dreamux` directory so managed worktrees land under
 * `<workspace>/.workspace/worktree/...`. reuse-cwd tests ignore it.
 */
let dispatcherCwd: string;

function buildService(provider: AgentRuntimeProvider): TeamMateAgentService {
  const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
  const dispatchers = new DispatcherStore(config);
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:codex');
  registry.registerImplementation(descriptor.id, provider);
  return new TeamMateAgentService({
    config,
    dispatchers,
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

describe('TeamMateAgentService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // realpath: on macOS tmpdir() is a /var -> /private/var symlink, and git
    // reports symlink-resolved repo roots (source_repo), so fixture paths must
    // be canonical for path equality assertions.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-teammate-agent-')));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    dispatcherCwd = join(root, 'workspace');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs a cross-provider teammate from its own named agent config', async () => {
    // Dispatcher 'flow' runs the 'codex' agent (builtin:codex). A teammate that
    // names the 'claude' agent (builtin:claude-code) must run with the claude
    // agent's resolved config — NOT inherit the codex dispatcher's runtime
    // (which is the wrong shape and used to throw "is not wired to Claude
    // Code"). The create-context dispatcher carries the teammate's OWN resolved
    // runtime, so cross-provider correctness falls out structurally.
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'codex' });
    const config = {
      agents: {
        codex: {
          provider: 'builtin:codex',
          config: dispatcher.runtime.config,
        },
        claude: {
          provider: 'builtin:claude-code',
          config: { permission_mode: 'default' },
        },
      },
      dispatchers: [dispatcher],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const claudeDesc = registry.resolve('builtin:claude-code');
    const codexProvider = new FakeProvider(codexDesc, 'builtin:codex');
    const claudeProvider = new FakeProvider(claudeDesc, 'builtin:claude-code');
    registry.registerImplementation(codexDesc.id, codexProvider);
    registry.registerImplementation(claudeDesc.id, claudeProvider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'claude-mate',
      intent: 'work',
      agentRuntime: 'claude',
      prompt: 'go',
      cwd: root,
    });
    expect(claudeProvider.contexts).toHaveLength(1);
    // The teammate's create-context carries the claude agent's resolved runtime,
    // taken from agents['claude'] — never the dispatcher's codex runtime.
    expect(claudeProvider.contexts[0]?.dispatcher).not.toBeNull();
    expect(claudeProvider.contexts[0]?.dispatcher?.runtime.provider).toBe(
      'builtin:claude-code',
    );

    // A teammate omitting agentRuntime falls back to the dispatcher's own agent.
    await service.spawn({
      dispatcherId: 'flow',
      name: 'codex-mate',
      intent: 'work',
      prompt: 'go',
      cwd: root,
    });
    expect(codexProvider.contexts).toHaveLength(1);
    expect(codexProvider.contexts[0]?.dispatcher).not.toBeNull();
    expect(codexProvider.contexts[0]?.dispatcher?.runtime.provider).toBe(
      'builtin:codex',
    );

    // Issue #182 PR-2: a teammate runtime spills under its OPERATOR dispatcher
    // id ('flow'), NOT its composite runtime id — for both runtime kinds. The
    // launcher resolves completionSpillDir to the operator cache regardless of
    // the id argument, and the spill dir must not carry the teammate-name
    // segment that the runtime dir (dispatcherDir) does.
    const operatorSpill = dispatcherCompletionSpillDir('flow');
    for (const { captured, name } of [
      { captured: claudeProvider.contexts[0], name: 'claude-mate' },
      { captured: codexProvider.contexts[0], name: 'codex-mate' },
    ]) {
      const paths = captured?.paths;
      expect(paths).toBeDefined();
      expect(paths!.completionSpillDir('ignored-arg')).toBe(operatorSpill);
      // The runtime dir is keyed by the teammate name; the spill dir is not.
      expect(paths!.dispatcherDir('ignored-arg')).toContain(name);
      expect(paths!.completionSpillDir('ignored-arg')).not.toContain(name);
    }
  });

  it('dispatcher and teammate referencing the same agent id get the same resolved runtime (#148)', async () => {
    // Both the dispatcher config (resolved at loadConfig) and the teammate
    // create-context (resolved at spawn time by service.ts) walk the same
    // agents[] id -> {provider, config} map. They must produce structurally
    // equal results — this guards both resolution paths against drift.
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'shared' });
    // Manually inject a shared agent entry so the dispatcher's resolved
    // runtime comes from agents['shared'] (same as what the teammate will get).
    const sharedRuntime = dispatcher.runtime;
    const config = {
      agents: { shared: { provider: sharedRuntime.provider, config: sharedRuntime.config } },
      dispatchers: [{ ...dispatcher, agentRuntime: 'shared', runtime: sharedRuntime }],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const provider = new FakeProvider(codexDesc, 'builtin:codex');
    registry.registerImplementation(codexDesc.id, provider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: noopLog(),
    });

    // Spawn a teammate that explicitly names the same 'shared' agent.
    await service.spawn({
      dispatcherId: 'flow',
      name: 'same-mate',
      intent: 'work',
      agentRuntime: 'shared',
      prompt: 'go',
      cwd: root,
    });
    expect(provider.contexts).toHaveLength(1);
    const teammateDispatcher = provider.contexts[0]?.dispatcher;
    expect(teammateDispatcher).not.toBeNull();
    // The teammate's dispatcher.runtime must deep-equal the dispatcher's own
    // resolved runtime — both came from agents['shared'].
    expect(teammateDispatcher?.runtime).toEqual(sharedRuntime);
    expect(teammateDispatcher?.runtime.provider).toBe('builtin:codex');
  });

  it('getCapabilities advertises spawnable agents[].id values, not provider refs', async () => {
    const dispatcher = testDispatcherConfig({ id: 'flow', agentRuntime: 'codex-safe' });
    const config = {
      agents: {
        'codex-safe': {
          provider: 'builtin:codex',
          config: dispatcher.runtime.config,
        },
        'codex-yolo': {
          provider: 'builtin:codex',
          config: { ...dispatcher.runtime.config, sandbox_mode: 'danger-full-access' },
        },
      },
      dispatchers: [dispatcher],
    };
    const registry = createBuiltinProviderRegistry();
    const codexDesc = registry.resolve('builtin:codex');
    const provider = new FakeProvider(codexDesc, 'builtin:codex');
    registry.registerImplementation(codexDesc.id, provider);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      log: noopLog(),
    });

    const capabilities = service.getCapabilities();
    expect(capabilities.agent_runtimes.map((entry) => entry.id)).toEqual([
      'codex-safe',
      'codex-yolo',
    ]);
    expect(
      capabilities.agent_runtimes.map((entry) => entry.spawn.agent_runtime),
    ).toEqual(['codex-safe', 'codex-yolo']);
    expect(JSON.stringify(capabilities)).not.toContain('provider_ref');
    expect(JSON.stringify(capabilities)).not.toContain('builtin:codex');

    const spawnableId = capabilities.agent_runtimes[1]!.id;
    expect(spawnableId).toBe('codex-yolo');
    await service.spawn({
      dispatcherId: 'flow',
      name: 'from-caps',
      intent: 'work',
      agentRuntime: spawnableId,
      prompt: 'go',
      cwd: root,
    });
    expect(provider.contexts[0]?.dispatcher?.agentRuntime).toBe('codex-yolo');
  });

  it('spawns a named resumable teammate and records raw history events', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'reviewer',
      intent: 'work',
      prompt: 'Review the change.',
      cwd: root,
    });
    expect(spawned.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    // #188: spawn allocates a concrete name and returns it; the requested label
    // is kept as display_name. All later calls use the returned concrete name.
    const reviewer = spawned.teammate.name;
    expect(reviewer).toMatch(/^reviewer-[a-z0-9]{8}$/);
    // #199 Slice 2: the collapsed status exposes owner (no public role/team_id),
    // a compact `repo` view (no source_cwd/cwd/worktree), and the runtime-native
    // session_id (the checkpoint id); display_name and checkpoint are gone.
    expect(spawned.teammate).toMatchObject({
      name: reviewer,
      owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
      agent_runtime: 'flow',
      repo: {
        mode: 'reuse-cwd',
        path: root,
        source_repo: null,
        cleanup_state: 'not-managed',
      },
      status: 'running',
      session_id: expect.stringContaining('thread'),
    });
    for (const removed of [
      'display_name',
      'role',
      'team_id',
      'checkpoint',
      'source_cwd',
      'cwd',
      'runtime_cwd',
      'worktree',
    ]) {
      expect(spawned.teammate).not.toHaveProperty(removed);
    }

    await service.send({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Check tests too.',
    });
    const sent = await service.send({
      dispatcherId: 'flow',
      name: reviewer,
      prompt: 'Continue from prior context.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-3' });
    expect(provider.runtimes).toHaveLength(1);
    expect(provider.runtimes[0]?.submitted).toHaveLength(3);

    // #199 Slice 3: the per-name turns archive captures one compact `submit`
    // row per spawn/send, in append order, with prompt previews. No settle rows
    // here (no completion sink wired).
    const turnRows = [];
    for await (const row of service.turns().stream('flow', reviewer)) {
      turnRows.push(row);
    }
    expect(turnRows.map((row) => row.type)).toEqual(['submit', 'submit', 'submit']);
    expect(turnRows.map((row) => row.prompt_preview)).toEqual([
      'Review the change.',
      'Check tests too.',
      'Continue from prior context.',
    ]);
    // The record's rolling summary tracks the turn count + last prompt preview.
    const reviewerRecord = (await service.status('flow', reviewer));
    expect(reviewerRecord.status).toBe('running');
  });

  it('persists records as JSON + per-name turns as the only JSONL store (#199 Slice 3)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });
    const name = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'archiver',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    provider.runtimes[0]!.lastText = 'the answer';
    provider.runtimes[0]!.settle('completed', 'turn-1');
    await waitForSettled(service, name, 1);

    // The per-name record is JSON and never persists the runtime checkpoint
    // wrapper (checkpoint / checkpoint_kind / session_ref).
    const record = JSON.parse(
      await readFile(dispatcherTeamMateRecordPath('flow', name), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['version']).toBe(1);
    // The runtime checkpoint wrapper and the write-only `display_name` are no
    // longer persisted (issue #199 Slice 2/3).
    for (const removed of ['checkpoint', 'checkpoint_kind', 'session_ref', 'display_name']) {
      expect(record).not.toHaveProperty(removed);
    }
    expect(record).toHaveProperty('turn_count');

    // The turns archive is JSONL and its rows are compact — turn facts only, no
    // record/common fields repeated.
    const turnLines = (
      await readFile(dispatcherTeamMateTurnsPath('flow', name), 'utf8')
    )
      .trim()
      .split('\n');
    const allowed = new Set([
      'version',
      'type',
      'turn_id',
      'timestamp',
      'turn_origin',
      'prompt_preview',
      'intent',
      'settle_status',
      'assistant',
      'assistant_preview',
      'assistant_truncated',
    ]);
    for (const line of turnLines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
      for (const forbidden of ['name', 'owner', 'agent_runtime', 'source_repo', 'cwd', 'worktree']) {
        expect(row).not.toHaveProperty(forbidden);
      }
    }
    expect(turnLines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      'submit',
      'settled',
    ]);

    // The only JSONL anywhere under the dispatcher's state is teammate/turns/*;
    // the session ledger and the team ledger are gone.
    const teammateDir = dispatcherTeamMateDir('flow');
    expect(existsSync(join(teammateDir, 'sessions.jsonl'))).toBe(false);
    const jsonl = await collectJsonl(join(teammateDir, '..'));
    expect(jsonl.length).toBeGreaterThan(0);
    for (const file of jsonl) {
      expect(file.includes(join('teammate', 'turns'))).toBe(true);
    }
  });

  it('resumes persisted identity through the same provider contract', async () => {
    const { provider } = providerCatalog();
    const first = buildService(provider);
    const builder = (
      await first.spawn({
        dispatcherId: 'flow',
        name: 'builder',
        intent: 'work',
        prompt: 'Build once.',
        cwd: root,
      })
    ).teammate.name;
    await first.stopAll();

    const second = buildService(provider);
    const sent = await second.send({
      dispatcherId: 'flow',
      name: builder,
      prompt: 'Resume and continue.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);

    // #188/#199: last is a pure record+turns read keyed by the concrete name. Resolved
    // to the identity's session, it returns a well-formed result; with no
    // completion sink wired here, no settled turn was captured.
    const last = await second.last('flow', builder);
    expect(last.teammate.name).toBe(builder);
    expect(last.requested_turns).toBe(1);
    // #199 Slice 2/3: the internal session id is not surfaced on the last result.
    expect(last).not.toHaveProperty('session_id');
    expect(last.turns).toEqual([]);
  });

  it('returns bounded history rows with worktree metadata and filters (#199)', async () => {
    const repo = await initGitRepo(join(root, 'ledger-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const alpha = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'alpha',
        prompt: 'Review alpha.',
        cwd: root,
        intent: 'review alpha',
      })
    ).teammate.name;
    const managedName = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'managed-ledger',
        prompt: 'Build managed.',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'managed-ledger',
          branch: 'dreamux/managed-ledger',
          cleanup: 'keep',
        },
        intent: 'managed work',
      })
    ).teammate.name;
    await service.close({ dispatcherId: 'flow', name: alpha, note: 'done' });

    const firstPage = await service.history({ dispatcherId: 'flow', limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).not.toBeNull();

    const all = await service.history({ dispatcherId: 'flow' });
    // #199 Slice 1: history rows are keyed by the concrete name; the requested
    // label / id / cwd / worktree / close_status are no longer projected.
    expect(all.items.map((item) => item.name).sort()).toEqual(
      [alpha, managedName].sort(),
    );
    const managed = all.items.find((item) => item.name === managedName);
    expect(managed).toMatchObject({
      name: managedName,
      agent_runtime: 'flow',
      source_repo: repo,
      cleanup_state: 'managed-active',
      intent: 'managed work',
      resume: { tool: 'send', name: managedName },
    });
    // The trimmed legacy fields must not reappear on a history row.
    for (const removed of [
      'id',
      'display_name',
      'session_id',
      'team_id',
      'role',
      'source_cwd',
      'runtime_cwd',
      'cwd',
      'worktree',
      'checkpoint',
      'state',
      'close_status',
    ]) {
      expect(managed).not.toHaveProperty(removed);
    }

    // The closed teammate is still recoverable via history (no close_status
    // filter in #199 Slice 1; find it by its concrete name instead).
    const closedRow = all.items.find((item) => item.name === alpha);
    expect(closedRow).toMatchObject({
      close_note_preview: 'done',
      last_prompt_preview: 'Review alpha.',
    });

    const grep = await service.history({ dispatcherId: 'flow', grep: 'managed work' });
    expect(grep.items.map((item) => item.name)).toEqual([managedName]);

    // #199 Slice 1: the lifecycle `status` filter survives (legacy `state` /
    // `close_status` are gone). `alpha` was closed; `managed-ledger` stays open.
    const closedByStatus = await service.history({ dispatcherId: 'flow', status: 'closed' });
    expect(closedByStatus.items.map((item) => item.name)).toEqual([alpha]);

    const second = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const afterRestart = await second.history({
      dispatcherId: 'flow',
      name: managedName,
    });
    expect(afterRestart.items).toHaveLength(1);
    expect(afterRestart.items[0]?.cleanup_state).toBe('managed-active');
  });

  it('closes a live teammate without deleting its history', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const closer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'closer',
        intent: 'work',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    const closed = await service.close({
      dispatcherId: 'flow',
      name: closer,
      note: 'done',
    });
    expect(closed.teammate).toMatchObject({
      name: closer,
      status: 'closed',
      close_note: 'done',
    });
    expect(closed.teammate).not.toHaveProperty('display_name');
    // #188: last is a pure durable-ledger read — it does NOT reopen a runtime, so
    // it works on a CLOSED teammate (this is the failed-completion fallback). It
    // returns the closed status and an empty turn list (no settled turn captured
    // here, since no completion sink is wired). status likewise does not reopen.
    expect(provider.runtimes).toHaveLength(1);
    const closerLast = await service.last('flow', closer);
    expect(closerLast.teammate.status).toBe('closed');
    expect(closerLast.turns).toEqual([]);
    expect((await service.status('flow', closer)).status).toBe('closed');
    expect(provider.runtimes).toHaveLength(1); // no new runtime started

    // #199 Slice 3: closing retains the per-name record — the closed teammate is
    // still searchable in history — and the turns archive keeps its submit row.
    // No separate close row is written; the close note lands on the record.
    const closerHistory = await service.history({ dispatcherId: 'flow', name: closer });
    expect(closerHistory.items.map((item) => item.name)).toEqual([closer]);
    expect(closerHistory.items[0]?.status).toBe('closed');
    expect(closerHistory.items[0]?.close_note).toBe('done');
    const turnRows = [];
    for await (const row of service.turns().stream('flow', closer)) {
      turnRows.push(row);
    }
    expect(turnRows.map((row) => row.type)).toEqual(['submit']);
  });

  it('send reopens a closed teammate from its checkpoint (issue #155)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const reopener = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reopener',
        intent: 'work',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    const closed = await service.close({
      dispatcherId: 'flow',
      name: reopener,
      note: 'paused',
    });
    expect(closed.teammate).toMatchObject({ status: 'closed', close_note: 'paused' });

    // send must NOT throw on a closed teammate: it clears the closed markers,
    // restarts the runtime from the persisted checkpoint, and submits.
    const sent = await service.send({
      dispatcherId: 'flow',
      name: reopener,
      prompt: 'Pick up where you left off.',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(sent.teammate).toMatchObject({
      name: reopener,
      status: 'running',
      closed_at: null,
      close_note: null,
    });
    // A second runtime was launched and it resumed from checkpoint (not a fresh
    // start) — that is what proves send revived the prior session.
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);
  });

  it('send updates the recorded intent when supplied, and leaves it unchanged otherwise (#182 PR-3)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const shifter = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'shifter',
        intent: 'first task',
        prompt: 'Start.',
        cwd: root,
      })
    ).teammate.name;
    expect((await service.status('flow', shifter)).intent).toBe('first task');

    // send WITH intent updates the durable recovery subject.
    const moved = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      intent: 'second task',
      prompt: 'Now do the second thing.',
    });
    expect(moved.teammate.intent).toBe('second task');
    expect((await service.status('flow', shifter)).intent).toBe('second task');

    // send WITHOUT intent leaves the recorded intent unchanged.
    const kept = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      prompt: 'Keep going.',
    });
    expect(kept.teammate.intent).toBe('second task');

    // send with an EMPTY intent must NOT wipe the recorded subject (#182 PR-3).
    const emptied = await service.send({
      dispatcherId: 'flow',
      name: shifter,
      intent: '',
      prompt: 'Still going.',
    });
    expect(emptied.teammate.intent).toBe('second task');
  });

  it('rejects direct service spawn/close with missing or empty intent/note (#182 PR-3 P1)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    // spawn.intent required at the service boundary (in-process bypass of the
    // MCP shim / admin layer). Empty and missing both rejected.
    await expect(
      service.spawn({ dispatcherId: 'flow', name: 'a', intent: '', prompt: 'go', cwd: root }),
    ).rejects.toThrow(/TeamMate spawn intent must be a non-empty string/);
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'a',
        prompt: 'go',
        cwd: root,
      } as unknown as Parameters<TeamMateAgentService['spawn']>[0]),
    ).rejects.toThrow(/TeamMate spawn intent must be a non-empty string/);

    // close.note required at the service boundary — checked after the teammate
    // is found, so spawn a real one first.
    const closeme = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'closeme',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    await expect(
      service.close({ dispatcherId: 'flow', name: closeme, note: '' }),
    ).rejects.toThrow(/TeamMate close note must be a non-empty string/);
  });

  it('fails loud when spawned with an agentRuntime that matches no agent', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'ghost',
        intent: 'work',
        agentRuntime: 'no-such-agent',
        prompt: 'go',
        cwd: root,
      }),
    ).rejects.toThrow(/'no-such-agent', which matches no agents\[\]\.id/);
  });

  it('spawns with no repo into a plain .workspace/work/<name> dir (non-git cwd)', async () => {
    // #199: omitting `repo` (no explicit cwd) creates a plain per-name work
    // directory under the dispatcher workspace — NOT a git worktree — so the
    // dispatcher cwd need not be a git repo. dispatcherCwd here is a plain
    // (non-git) directory.
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      intent: 'work',
      prompt: 'go',
    } as Parameters<TeamMateAgentService['spawn']>[0]);
    const reviewer = spawned.teammate.name;
    expect(spawned.teammate.repo).toMatchObject({
      mode: 'reuse-cwd',
      source_repo: null,
      cleanup_state: 'not-managed',
    });
    // The runtime cwd is the default work dir, not the dispatcher cwd itself.
    expect(spawned.teammate.repo.path).toMatch(
      new RegExp(`/\\.workspace/work/${reviewer}$`),
    );
    expect(spawned.teammate.repo.path).not.toBe(dispatcherCwd);
    expect(existsSync(spawned.teammate.repo.path)).toBe(true);
    // The boundary `.gitignore` (`*`) keeps the work dir out of any repo view.
    expect(
      await readFile(join(dispatcherCwd, '.workspace', '.gitignore'), 'utf8'),
    ).toContain('*');
  });

  it('fails loud when a no-repo spawn has no configured dispatcher cwd', async () => {
    // The dispatcher cwd contract still holds: with no configured cwd there is
    // nowhere to root the default work dir, so spawn fails loud (issue #182).
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: null })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'no-cwd',
        intent: 'work',
        prompt: 'go',
      } as Parameters<TeamMateAgentService['spawn']>[0]),
    ).rejects.toThrow(/cwd/);
  });

  it('reads old identities without owner as dispatcher-owned until mutated', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const dir = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'records',
    );
    const path = join(dir, 'oldie.json');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'oldie',
        agent_runtime: 'flow',
        cwd: root,
        created_at: 1,
        updated_at: 1,
        status: 'stopped',
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
      { mode: 0o600 },
    );

    expect((await service.status('flow', 'oldie')).owner).toEqual({
      kind: 'dispatcher',
      dispatcher_id: 'flow',
    });
    const history = await service.history({ dispatcherId: 'flow', name: 'oldie' });
    // #199 Slice 1: a pre-#188 record still reads back without migration; the
    // trimmed history row keys on the concrete name and a reuse-cwd record
    // surfaces a 'not-managed' cleanup state.
    expect(history.items[0]).toMatchObject({
      name: 'oldie',
      intent: null,
      cleanup_state: 'not-managed',
    });
    expect(history.items[0]).not.toHaveProperty('display_name');
    expect(history.items[0]).not.toHaveProperty('session_id');
    expect(history.items[0]).not.toHaveProperty('worktree');
    expect(await readFile(path, 'utf8')).not.toContain('"owner"');
  });

  it('prepares managed worktrees, persists metadata, and deletes clean worktrees on close', async () => {
    const repo = await initGitRepo(join(root, 'repo'));
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'managed',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'managed',
        branch: 'dreamux/managed',
        cleanup: 'delete-on-close',
      },
    });

    expect(spawned.teammate.repo).toMatchObject({
      mode: 'managed',
      source_repo: repo,
      branch: 'dreamux/managed',
      base_ref: 'HEAD',
      cleanup: 'delete-on-close',
      cleanup_state: 'managed-active',
    });
    expect(provider.contexts[0]?.cwd).toBe(spawned.teammate.repo.path);
    expect(existsSync(spawned.teammate.repo.path)).toBe(true);

    const closed = await service.close({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.repo.cleanup_state).toBe('deleted');
    expect(existsSync(spawned.teammate.repo.path)).toBe(false);
  });

  it('reports the git-canonical source_repo when cwd reaches the repo through a symlink', async () => {
    // macOS regression guard: tmpdir() lives behind a /var -> /private/var
    // symlink, so `git rev-parse --show-toplevel` reports the symlink-resolved
    // repo root. Reproduce that shape on any OS with an explicit symlink:
    // source_repo is the canonical root while source_cwd keeps the
    // caller-supplied path.
    const repo = await initGitRepo(join(root, 'real-repo'));
    const linked = join(root, 'linked-repo');
    await symlink(repo, linked);
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'symlinked',
      intent: 'work',
      prompt: 'go',
      cwd: linked,
    });

    // #199 Slice 2: source_cwd is no longer surfaced; repo.source_repo is the
    // git-canonical root even when the caller cwd reaches it through a symlink.
    expect(spawned.teammate.repo.source_repo).toBe(repo);
  });

  it('recreates a deleted managed worktree when send reopens a closed teammate', async () => {
    const repo = await initGitRepo(join(root, 'reopen-repo'));
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'reopen-managed',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'reopen-managed',
        branch: 'dreamux/reopen-managed',
        cleanup: 'delete-on-close',
      },
    });
    const worktreePath = spawned.teammate.repo.path;
    await service.close({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(existsSync(worktreePath)).toBe(false);

    const sent = await service.send({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      prompt: 'continue',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'turn-1' });
    expect(sent.teammate.repo).toMatchObject({
      mode: 'managed',
      path: worktreePath,
      cleanup_state: 'managed-active',
    });
    expect(existsSync(worktreePath)).toBe(true);
    expect(provider.runtimes).toHaveLength(2);
    expect(provider.runtimes[1]?.wasThreadResumed()).toBe(true);
    expect(provider.contexts[1]?.cwd).toBe(worktreePath);
  });

  it('marks intentionally retained managed worktrees as kept on close', async () => {
    const repo = await initGitRepo(join(root, 'kept-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'keeper',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'keeper',
        branch: 'dreamux/keeper',
        cleanup: 'keep',
      },
    });

    const closed = await service.close({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.repo.cleanup_state).toBe('kept');
    expect(existsSync(spawned.teammate.repo.path)).toBe(true);
  });

  it('retains dirty managed worktrees on close', async () => {
    const repo = await initGitRepo(join(root, 'dirty-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'dirty',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'dirty',
        branch: 'dreamux/dirty',
        cleanup: 'delete-on-close',
      },
    });
    await writeFile(join(spawned.teammate.repo.path, 'dirty.txt'), 'dirty');

    const closed = await service.close({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.repo.cleanup_state).toBe('retained-dirty');
    expect(existsSync(spawned.teammate.repo.path)).toBe(true);
  });

  it('retains clean detached managed worktrees with unique commits', async () => {
    const repo = await initGitRepo(join(root, 'detached-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const spawned = await service.spawn({
      dispatcherId: 'flow',
      name: 'detached',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'detached',
        branch: 'dreamux/detached',
        cleanup: 'delete-on-close',
      },
    });
    const worktreePath = spawned.teammate.repo.path;
    await execa('git', ['switch', '--detach'], { cwd: worktreePath });
    await writeFile(join(worktreePath, 'detached.txt'), 'detached\n');
    await execa('git', ['add', 'detached.txt'], { cwd: worktreePath });
    await execa('git', ['commit', '-m', 'Detached work'], { cwd: worktreePath });

    const closed = await service.close({
      dispatcherId: 'flow',
      name: spawned.teammate.name,
      note: 'done',
    });
    expect(closed.teammate.repo.cleanup_state).toBe(
      'retained-unique-commits',
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('disambiguates the same managed slug across different source repos (#182 PR-4)', async () => {
    // Repo-disambiguation: two different source repos that share an inner slug
    // must map to DISTINCT managed worktrees (under distinct repo-slug dirs),
    // not collide at one path. This is the cross-repo uniqueness contract.
    const firstRepo = await initGitRepo(join(root, 'slug-a'));
    const secondRepo = await initGitRepo(join(root, 'slug-b'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    const first = await service.spawn({
      dispatcherId: 'flow',
      name: 'first-slug',
      intent: 'work',
      prompt: 'go',
      cwd: firstRepo,
      worktree: {
        mode: 'managed',
        slug: 'shared-slug',
        branch: 'dreamux/shared-slug',
        cleanup: 'keep',
      },
    });
    const second = await service.spawn({
      dispatcherId: 'flow',
      name: 'second-slug',
      intent: 'work',
      prompt: 'go',
      cwd: secondRepo,
      worktree: {
        mode: 'managed',
        slug: 'shared-slug',
        branch: 'dreamux/shared-slug',
        cleanup: 'keep',
      },
    });

    const firstPath = first.teammate.repo.path;
    const secondPath = second.teammate.repo.path;
    expect(firstPath).not.toBe(secondPath);
    // Both live under the dispatcher workspace boundary, never under ~/.dreamux.
    const boundary = join(dispatcherCwd, '.workspace', 'worktree');
    expect(firstPath.startsWith(boundary)).toBe(true);
    expect(secondPath.startsWith(boundary)).toBe(true);
    // Same inner slug, different repo-disambiguated parent dir.
    expect(join(firstPath, '..')).not.toBe(join(secondPath, '..'));
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
  });

  it('self-ignores the .workspace boundary so managed worktrees are not repo content (#182 PR-4)', async () => {
    const repo = await initGitRepo(join(root, 'boundary-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'boundary',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'boundary',
        branch: 'dreamux/boundary',
        cleanup: 'keep',
      },
    });

    const gitignore = join(dispatcherCwd, '.workspace', '.gitignore');
    expect(existsSync(gitignore)).toBe(true);
    expect((await readFile(gitignore, 'utf8')).split('\n')).toContain('*');
  });

  it('repairs an existing unsafe .workspace/.gitignore (#182 PR-4, PR#186 P2)', async () => {
    const repo = await initGitRepo(join(root, 'unsafe-boundary-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    // Seed an existing boundary file that does NOT safely ignore everything: it
    // un-ignores worktree content via a negation and has no bare `*`.
    const boundaryDir = join(dispatcherCwd, '.workspace');
    await mkdir(boundaryDir, { recursive: true });
    const gitignore = join(boundaryDir, '.gitignore');
    await writeFile(gitignore, '# keep some stuff\n!leaked\n', 'utf8');

    await service.spawn({
      dispatcherId: 'flow',
      name: 'unsafe-boundary',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'unsafe-boundary',
        branch: 'dreamux/unsafe-boundary',
        cleanup: 'keep',
      },
    });

    // The unsafe file must have been repaired to the canonical ignore-all form.
    const lines = (await readFile(gitignore, 'utf8'))
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('*');
    expect(lines.some((line) => line.startsWith('!'))).toBe(false);
  });

  it('rejects a managed worktree under a workspace that symlinks into Dreamux home (#182 PR-4, PR#186 P1)', async () => {
    const repo = await initGitRepo(join(root, 'symlink-repo'));
    // A directory physically inside Dreamux home, reached via a workspace path
    // that is OUTSIDE Dreamux home lexically but symlinks into it.
    const targetUnderDreamux = join(root, 'home', '.dreamux', 'state', 'sneaky');
    await mkdir(targetUnderDreamux, { recursive: true });
    const symlinkedWorkspace = join(root, 'outside-link');
    await symlink(targetUnderDreamux, symlinkedWorkspace);

    const config = testDreamuxConfig([
      testDispatcherConfig({ cwd: symlinkedWorkspace }),
    ]);
    const { catalog } = providerCatalog();
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'sneaky',
        intent: 'work',
        prompt: 'go',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'sneaky',
          branch: 'dreamux/sneaky',
          cleanup: 'keep',
        },
      }),
    ).rejects.toThrow(/must not be created under the Dreamux home/);

    // And no managed worktree was physically created under Dreamux home.
    expect(existsSync(join(targetUnderDreamux, '.workspace', 'worktree'))).toBe(
      false,
    );
  });

  it('rejects two teammate identities using the same explicit managed slug', async () => {
    const repo = await initGitRepo(join(root, 'same-slug-repo'));
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'slug-one',
      intent: 'work',
      prompt: 'go',
      cwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'same-slug',
        branch: 'dreamux/same-slug',
        cleanup: 'keep',
      },
    });
    await expect(
      service.spawn({
        dispatcherId: 'flow',
        name: 'slug-two',
        intent: 'work',
        prompt: 'go',
        cwd: repo,
        worktree: {
          mode: 'managed',
          slug: 'same-slug',
          branch: 'dreamux/same-slug',
          cleanup: 'keep',
        },
      }),
      // The owner is reported by its concrete name (#188: `slug-one-<suffix>`).
    ).rejects.toThrow(/already owned by TeamMate "slug-one-/);
  });

  it('fails loud on a legacy provider_ref teammate identity (pre-#148)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    // Seed a pre-#148 identity record carrying the removed provider_ref field
    // instead of agent_runtime. Any lifecycle verb that reads it must fail loud
    // with rebuild guidance rather than silently defaulting a runtime.
    const dir = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'records',
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'legacy.json'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'legacy',
        provider_ref: 'builtin:codex',
        cwd: root,
        created_at: 1,
        updated_at: 1,
        status: 'running',
        checkpoint: null,
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
      { mode: 0o600 },
    );
    await expect(
      service.send({ dispatcherId: 'flow', name: 'legacy', prompt: 'go' }),
    ).rejects.toThrow(/legacy provider_ref format/);
  });

  it('fails loud on list/history when a record carries a removed #199 field', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    // A stale record carrying the removed `checkpoint` field must not be quietly
    // skipped by the list chokepoint (which feeds teammate.list AND
    // teammate.history); both public read surfaces fail loud (issue #199 Slice 5).
    const dir = join(root, 'home', '.dreamux', 'state', 'flow', 'teammate', 'records');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'stale.json'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'stale',
        agent_runtime: 'flow',
        cwd: root,
        created_at: 1,
        updated_at: 1,
        status: 'stopped',
        checkpoint: null,
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
      { mode: 0o600 },
    );
    await expect(service.list('flow')).rejects.toThrow(/removed in issue #199/);
    await expect(
      service.history({ dispatcherId: 'flow' }),
    ).rejects.toThrow(/removed in issue #199/);
  });

  it('reads a legacy under-state managed worktree path verbatim (#182 PR-4)', async () => {
    // A teammate identity persisted before the worktree relocation carries a
    // managed worktree.path under `~/.dreamux/state/.../worktrees/`. The reader
    // must surface that legacy path UNCHANGED — never rewrite it to the new
    // `.workspace/worktree/...` layout and never delete the old location.
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const legacyWorktreePath = join(
      root,
      'home',
      '.dreamux',
      'state',
      'flow',
      'teammate',
      'worktrees',
      'legacy-mate',
    );
    await mkdir(dispatcherTeamMateRecordsDir('flow'), { recursive: true });
    await writeFile(
      dispatcherTeamMateRecordPath('flow', 'legacy-mate'),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'legacy-mate',
        owner: { kind: 'dispatcher', dispatcher_id: 'flow' },
        role: 'teammate',
        team_id: null,
        agent_runtime: 'flow',
        source_cwd: root,
        source_repo: root,
        cwd: legacyWorktreePath,
        runtime_cwd: legacyWorktreePath,
        worktree: {
          mode: 'managed',
          slug: 'legacy-mate',
          path: legacyWorktreePath,
          branch: 'dreamux/legacy-mate',
          base_ref: 'HEAD',
          cleanup: 'keep',
          cleanup_state: 'managed-active',
          cleanup_error: null,
        },
        intent: 'legacy work',
        created_at: 1,
        updated_at: 1,
        status: 'closed',
        last_error: null,
        closed_at: 2,
        close_note: 'archived',
      }),
      { mode: 0o600 },
    );

    const status = await service.status('flow', 'legacy-mate');
    expect(status.repo.mode).toBe('managed');
    expect(status.repo.path).toBe(legacyWorktreePath);
  });

  it('does not wire the settle hook when no completion sink is configured', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    await service.spawn({
      dispatcherId: 'flow',
      name: 'solo',
      intent: 'work',
      prompt: 'Start.',
      cwd: root,
    });
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(false);
  });

  it('delivers a settled teammate turn upward as a completion envelope', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const received: Array<{ id: string; name: string; env: CompletionEnvelope }> = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (id, identity, env) => {
        received.push({ id, name: identity.name, env });
      },
      log: noopLog(),
    });

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'Review.',
        cwd: root,
      })
    ).teammate.name;
    expect(provider.runtimes[0]?.hasSettleHook()).toBe(true);

    provider.runtimes[0]?.settle('completed', 'turn-1');
    await flush();

    // The completion envelope keys on the concrete name (#188).
    expect(received).toEqual([
      {
        id: 'flow',
        name: reviewer,
        env: {
          source: reviewer,
          id: `${reviewer}:turn-1`,
          status: 'completed',
          result: 'last fake result',
        },
      },
    ]);
  });

  it('delivers terminal failure/stop settlements with their own status', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    const breaker = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'breaker',
        intent: 'work',
        prompt: 'Run.',
        cwd: root,
      })
    ).teammate.name;

    provider.runtimes[0]?.settle('failed', 'turn-7');
    provider.runtimes[0]?.settle('stopped', 'turn-8');
    await flush();

    expect(received).toEqual([
      {
        source: breaker,
        id: `${breaker}:turn-7`,
        status: 'failed',
        result: 'last fake result',
      },
      {
        source: breaker,
        id: `${breaker}:turn-8`,
        status: 'stopped',
        result: 'last fake result',
      },
    ]);
  });

  it('drops null-turn settlements rather than fabricating a completion id', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    await service.spawn({
      dispatcherId: 'flow',
      name: 'breaker',
      intent: 'work',
      prompt: 'Run.',
      cwd: root,
    });

    provider.runtimes[0]?.settle('stopped', null);
    await flush();

    expect(received).toEqual([]);
  });

  it('delivers concurrent teammate completions without dropping any', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const received: CompletionEnvelope[] = [];
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: (_id, _identity, env) => {
        received.push(env);
      },
      log: noopLog(),
    });

    const one = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'one',
        intent: 'work',
        prompt: 'A.',
        cwd: root,
      })
    ).teammate.name;
    const two = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'two',
        intent: 'work',
        prompt: 'B.',
        cwd: root,
      })
    ).teammate.name;

    provider.runtimes[0]?.settle('completed', 'turn-1');
    provider.runtimes[1]?.settle('completed', 'turn-1');
    await flush();

    expect(received.map((env) => env.source).sort()).toEqual([one, two].sort());
    expect(received).toHaveLength(2);
  });

  it('last(turns): defaults to 1, accepts 1..5, and rejects out-of-range/non-integer (#188)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const name = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'turns',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;

    expect((await service.last('flow', name)).requested_turns).toBe(1);
    expect((await service.last('flow', name, 5)).requested_turns).toBe(5);
    await expect(service.last('flow', name, 0)).rejects.toThrow(/1\.\.5/);
    await expect(service.last('flow', name, 6)).rejects.toThrow(/1\.\.5/);
    await expect(service.last('flow', name, 1.5)).rejects.toThrow(/1\.\.5/);
  });

  it('last reads settled turns from the per-name turns archive with truncation metadata (#188/#199)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      // A completion sink wires the settle hook so settled turns are captured.
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'first',
        cwd: root,
      })
    ).teammate.name;

    // Settle three turns with distinct assistant outputs; the third exceeds the
    // 160k hard cap so it must come back flagged truncated.
    const runtime = provider.runtimes[0]!;
    runtime.lastText = 'answer one';
    runtime.settle('completed', 'turn-1');
    await waitForSettled(service, reviewer, 1);
    await service.send({ dispatcherId: 'flow', name: reviewer, prompt: 'second' });
    runtime.lastText = 'answer two';
    runtime.settle('completed', 'turn-2');
    await waitForSettled(service, reviewer, 2);
    await service.send({ dispatcherId: 'flow', name: reviewer, prompt: 'third' });
    const huge = 'z'.repeat(170_000);
    runtime.lastText = huge;
    runtime.settle('completed', 'turn-3');
    await waitForSettled(service, reviewer, 3);

    // Default returns just the newest settled turn (truncated to the hard cap).
    const latest = await service.last('flow', reviewer);
    expect(latest.requested_turns).toBe(1);
    expect(latest.returned_turns).toBe(1);
    const newest = latest.turns.at(-1)!;
    expect(newest.turn_id).toBe('turn-3');
    expect(newest.assistant_truncated).toBe(true);
    expect(newest.assistant).toHaveLength(160_000);

    // turns:5 returns all three in append order, oldest first; older turns are
    // captured whole.
    const all = await service.last('flow', reviewer, 5);
    expect(all.returned_turns).toBe(3);
    expect(all.turns.map((turn) => turn.turn_id)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    expect(all.turns[0]).toMatchObject({
      assistant: 'answer one',
      assistant_truncated: false,
    });
  });

  it('last(turns) evicts older turns beyond the window, keeping the most recent by start order (#188 bounded fold)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const name = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'evict',
        intent: 'work',
        prompt: 'first',
        cwd: root,
      })
    ).teammate.name;
    const runtime = provider.runtimes[0]!;
    // Settle FOUR turns in one session so last(turns=2) must drive the bounded
    // fold's eviction path (recent.size > requestedTurns) more than once.
    runtime.lastText = 'a1';
    runtime.settle('completed', 'turn-1');
    await waitForSettled(service, name, 1);
    for (const [turnId, text, prompt] of [
      ['turn-2', 'a2', 'second'],
      ['turn-3', 'a3', 'third'],
      ['turn-4', 'a4', 'fourth'],
    ] as const) {
      await service.send({ dispatcherId: 'flow', name, prompt });
      runtime.lastText = text;
      runtime.settle('completed', turnId);
      await waitForSettled(service, name, Number(turnId.slice('turn-'.length)));
    }

    // Only the two most-recent-by-start turns survive, in append order.
    const last = await service.last('flow', name, 2);
    expect(last.requested_turns).toBe(2);
    expect(last.returned_turns).toBe(2);
    expect(last.turns.map((turn) => turn.turn_id)).toEqual(['turn-3', 'turn-4']);
    expect(last.turns.map((turn) => turn.assistant)).toEqual(['a3', 'a4']);
    // Default (turns=1) keeps only the newest.
    const latest = await service.last('flow', name);
    expect(latest.turns.map((turn) => turn.turn_id)).toEqual(['turn-4']);
  });

  it('last works on a closed teammate without starting a runtime (#188)', async () => {
    const { catalog, provider } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      onTeamMateCompletion: () => undefined,
      log: noopLog(),
    });

    const reviewer = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'reviewer',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    provider.runtimes[0]!.lastText = 'the captured answer';
    provider.runtimes[0]!.settle('completed', 'turn-1');
    await waitForSettled(service, reviewer, 1);
    await service.close({ dispatcherId: 'flow', name: reviewer, note: 'done' });

    const runtimesBefore = provider.runtimes.length;
    const last = await service.last('flow', reviewer);
    // No new runtime was launched to serve the read.
    expect(provider.runtimes).toHaveLength(runtimesBefore);
    expect(last.teammate.status).toBe('closed');
    expect(last.turns.at(-1)).toMatchObject({
      turn_id: 'turn-1',
      assistant: 'the captured answer',
      settle_status: 'completed',
    });
  });

  it('concrete names are never reused, even after close (#188)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const first = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'dup',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    await service.close({ dispatcherId: 'flow', name: first, note: 'done' });
    // Re-spawning the same requested label allocates a DISTINCT concrete name —
    // the closed identity's name is never handed out again.
    const second = (
      await service.spawn({
        dispatcherId: 'flow',
        name: 'dup',
        intent: 'work',
        prompt: 'go',
        cwd: root,
      })
    ).teammate.name;
    expect(second).not.toBe(first);
    expect(first).toMatch(/^dup-[a-z0-9]{8}$/);
    expect(second).toMatch(/^dup-[a-z0-9]{8}$/);
    // Both identities persist; the closed one is still addressable by its name.
    const names = (await service.history({ dispatcherId: 'flow' })).items.map((i) => i.name);
    expect(names).toContain(first);
    expect(names).toContain(second);
  });

  it('createTeamLeader fails loud on a reused concrete name, even after close (#188 P1)', async () => {
    const { catalog } = providerCatalog();
    const config = testDreamuxConfig([testDispatcherConfig({ cwd: dispatcherCwd })]);
    const service = new TeamMateAgentService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: catalog,
      log: noopLog(),
    });
    const leaderInput = {
      dispatcherId: 'flow',
      teamId: 'alpha',
      name: 'tl-alpha-fixedaaa',
      displayName: 'alpha-leader',
      prompt: 'lead',
      agentRuntime: 'flow',
      sourceCwd: root,
      sourceRepo: null,
      runtimeCwd: root,
      worktree: {
        mode: 'reuse-cwd' as const,
        slug: null,
        path: root,
        branch: null,
        base_ref: null,
        cleanup: 'keep' as const,
        cleanup_state: 'not-managed' as const,
        cleanup_error: null,
      },
      intent: 'work',
    };
    await service.createTeamLeader(leaderInput);
    // The public service seam must not rebind a concrete name to a new session —
    // not even for a CLOSED leader. #188: concrete names are never reused, and
    // the duplicate check includes closed identities. #199 Slice 4: a TeamLeader
    // is closed through the internal Team-service authority — it is not visible
    // on the dispatcher `teammate.*` surface.
    await service.closeScoped({
      principal: teamServicePrincipal({
        dispatcherId: 'flow',
        teamId: 'alpha',
        leaderName: 'tl-alpha-fixedaaa',
      }),
      name: 'tl-alpha-fixedaaa',
      note: 'done',
    });
    await expect(service.createTeamLeader(leaderInput)).rejects.toThrow(
      /already exists/,
    );
  });
});

/** Poll the per-name turns archive until it has captured `count` settled turns. */
async function waitForSettled(
  service: TeamMateAgentService,
  name: string,
  count: number,
): Promise<void> {
  // Generous deadline: the settle handler runs off a void-ed callback, so under
  // full-suite parallel load the turns-archive write can lag a few ticks.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let settled = 0;
    for await (const row of service.turns().stream('flow', name)) {
      if (row.type === 'settled') settled += 1;
    }
    if (settled >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} settled turns`);
}

/** Recursively collect every `.jsonl` file path under a directory. */
async function collectJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsonl(full)));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function noopLog(): {
  info: () => undefined;
  warn: () => undefined;
  error: () => undefined;
} {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Drain the microtask/macrotask the void-ed settle handler runs on. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function initGitRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await execa('git', ['init', '-b', 'main'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dreamux Test'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dreamux-test@example.com'], {
    cwd: path,
  });
  await writeFile(join(path, 'README.md'), 'test\n');
  await execa('git', ['add', 'README.md'], { cwd: path });
  await execa('git', ['commit', '-m', 'Initial test commit'], { cwd: path });
  return path;
}
