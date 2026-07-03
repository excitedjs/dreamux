import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import {
  TeamCollection,
  TeamUnavailableError,
} from '../src/service/team-collection/index.js';
import { TeamMateIdentityStore } from '../src/service/teammate-collection/identity-store.js';
import { TeamMateTurnsStore } from '../src/service/teammate-collection/turns-store.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  dispatcherTeamCronJobsPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const FAKE_RUNTIME_REF = 'test:runtime';

const CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = FAKE_RUNTIME_REF;
  readonly submitted: InboundTurnInput[] = [];
  readonly textSubmitted: AgentRuntimeTextInput[] = [];
  private status: AgentRuntimeStatus = 'declared';

  async start(): Promise<void> {
    this.status = 'ready';
  }

  async resume(): Promise<void> {
    this.status = 'ready';
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
  }

  async channelInput(input: InboundTurnInput): Promise<AgentRuntimeTurnResult> {
    this.submitted.push(input);
    return { status: 'submitted', turnId: `turn-${this.submitted.length}` };
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    this.textSubmitted.push(input);
    return { status: 'submitted', turnId: `text-${this.textSubmitted.length}` };
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCheckpoint(): { id: string } | null {
    return { id: 'thread-fake' };
  }

  wasCheckpointResumed(): boolean {
    return false;
  }

  async getLast(): Promise<AgentRuntimeLastResult> {
    return { text: 'fake last' };
  }

  async getContext(): Promise<null> {
    return null;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return CAPABILITIES;
  }
}

class NewContractOnlyRuntime extends FakeRuntime {
  override getCheckpoint(): { id: string } | null {
    return { id: 'checkpoint-only-thread' };
  }
}

function fakeRuntimeCatalog(input: {
  runtimes: FakeRuntime[];
  contexts?: AgentRuntimeCreateContext[];
  createRuntime?: () => FakeRuntime;
}): AgentRuntimeProviderCatalog {
  const provider: AgentRuntimeProvider = {
    ref: FAKE_RUNTIME_REF,
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: FAKE_RUNTIME_REF },
    },
    getCapabilities: () => CAPABILITIES,
    createRuntime(context: AgentRuntimeCreateContext) {
      input.contexts?.push(context);
      const runtime = input.createRuntime?.() ?? new FakeRuntime();
      input.runtimes.push(runtime);
      return runtime;
    },
  };
  return {
    list: () => [provider],
    resolve(ref: string) {
      if (ref !== FAKE_RUNTIME_REF) {
        throw new Error(`unexpected runtime provider ${JSON.stringify(ref)}`);
      }
      return provider;
    },
  } as AgentRuntimeProviderCatalog;
}

function noopLog(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

function fakeChannelCatalog(): ChannelProviderCatalog {
  return {
    list: () => [],
    resolve(ref: string) {
      throw new Error(`unexpected channel provider ${JSON.stringify(ref)}`);
    },
  } as unknown as ChannelProviderCatalog;
}

describe('TeamLeader cron scheduler lifecycle', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-scheduler-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a cron target for a missing or closed team with TeamUnavailableError', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = makeTeams({ config, log, runtimes: [] });

    // The admin `cronTargetFor` helper maps ONLY this typed error to
    // TEAM_NOT_FOUND; a plain Error here would mask real scheduler failures.
    await expect(teams.scheduler('ghost')).rejects.toBeInstanceOf(
      TeamUnavailableError,
    );

    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    await (await teams.get('alpha')).dissolve({ teamId: 'alpha', note: 'done' });
    await expect(teams.scheduler('alpha')).rejects.toBeInstanceOf(
      TeamUnavailableError,
    );

    teams.stopSchedulers();
    await teams.stopAll();
  });

  it('eager-arms an unaddressed TeamLeader cron after restart and lazy-starts the leader', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const first = makeTeams({ config, log, runtimes: [] });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    first.stopSchedulers();
    await first.stopAll();

    await new CronJobStore({
      dispatcherId: 'dispatcher-a',
      cronJobsPath: dispatcherTeamCronJobsPath('dispatcher-a', 'alpha'),
    }).create(
      {
        cron: '* * * * *',
        tz: 'UTC',
        recurring: false,
        action: { kind: 'prompt-agent', prompt: 'scheduled alpha' },
        nextRunAt: Date.now() + 2000,
      },
      128,
    );

    const restartedRuntimes: FakeRuntime[] = [];
    const restarted = makeTeams({ config, log, runtimes: restartedRuntimes });
    await restarted.startSchedulers();

    await waitFor(
      () =>
        restartedRuntimes.length === 1 &&
        restartedRuntimes[0]!.textSubmitted.length === 1,
      4000,
    );
    expect(restartedRuntimes[0]!.textSubmitted[0]).toEqual({
      text: 'scheduled alpha',
      sourceId: expect.stringMatching(/^scheduled:job-/),
    });
  });

  it('dissolve stops the TeamLeader scheduler and deletes its cron store', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const teams = makeTeams({ config, log, runtimes: [] });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    const team = await teams.get('alpha');
    const job = await team.scheduler.create({
      cron: '* * * * *',
      prompt: 'scheduled alpha',
      tz: 'UTC',
    });
    const cronPath = dispatcherTeamCronJobsPath('dispatcher-a', 'alpha');
    expect(existsSync(cronPath)).toBe(true);

    await team.dissolve({ teamId: 'alpha', note: 'done' });

    expect(existsSync(cronPath)).toBe(false);
    await expect(team.scheduler.runNow(job.id)).resolves.toEqual({
      id: job.id,
      status: 'skipped',
    });
  });

  it('projects runtime status from checkpoints', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const dispatchers = new DispatcherStore(config);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers,
      agentRuntimeProviders: fakeRuntimeCatalog({
        runtimes,
        createRuntime: () => {
          const runtime = new NewContractOnlyRuntime();
          return runtime;
        },
      }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });

    await dispatcher.start();

    expect(dispatcher.runtimeStatus()).toEqual({
      status: 'ready',
      threadId: 'checkpoint-only-thread',
    });
    expect(dispatcher.summary(dispatchers.get('dispatcher-a')!)).toMatchObject({
      status: 'ready',
      thread_id: 'checkpoint-only-thread',
    });

    await dispatcher.stop();
  });

  it('injects cron MCP for TeamLeaders but not regular Team members', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const contexts: AgentRuntimeCreateContext[] = [];
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({
        runtimes,
        contexts,
      }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();
    await dispatcher.createTeam({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
      identity: 'team coordinator',
    });
    const team = await dispatcher.team('alpha');
    await team.spawnTeamMate({
      name: 'worker',
      prompt: 'do work',
      agentRuntime: 'agent-a',
      intent: 'member work',
      identity: 'worker specialist',
    });
    await dispatcher.teammates.spawn({
      name: 'helper',
      prompt: 'help',
      cwd: workspace,
      worktree: { mode: 'reuse-cwd' },
      agentRuntime: 'agent-a',
      intent: 'ordinary work',
      identity: 'general helper',
    });

    const dispatcherContext = contexts.find(
      (context) => context.identity.runtime_id === 'dispatcher-a',
    );
    const leaderContext = contexts.find(
      (context) =>
        context.systemPrompt?.append?.some((prompt) =>
          prompt.includes('team coordinator'),
        ) === true,
    );
    const memberContext = contexts.find(
      (context) =>
        context.systemPrompt?.append?.some((prompt) =>
          prompt.includes('worker specialist'),
        ) === true,
    );
    const teammateContext = contexts.find(
      (context) =>
        context.systemPrompt?.append?.some((prompt) =>
          prompt.includes('general helper'),
        ) === true,
    );
    expect(dispatcherContext?.disableFeatures).toEqual(['userInterrupt', 'cron']);
    expect(dispatcherContext?.skillSources?.map((source) => source.name)).toEqual([
      'dispatcher',
    ]);
    expect(dispatcherContext?.systemPrompt?.replace).toMatch(/Dreamux Dispatcher/i);
    expect(dispatcherContext?.systemPrompt?.append).toEqual([
      expect.stringMatching(/Dreamux Dispatcher/i),
    ]);
    expect(leaderContext?.mcpServers.map((server) => server.name)).toContain('cron');
    expect(leaderContext?.mcpServers.map((server) => server.name)).toContain('team');
    expect(
      leaderContext?.mcpServers.find((server) => server.name === 'team')?.args,
    ).toEqual([
      'team-mcp',
      '--dispatcher',
      'dispatcher-a',
      '--admin-socket',
      '/tmp/dreamux-admin.sock',
      '--caller',
      'team_leader',
      '--team-id',
      'alpha',
      '--leader-name',
      expect.any(String),
    ]);
    expect(leaderContext?.disableFeatures).toEqual(['userInterrupt', 'cron']);
    expect(leaderContext?.skillSources?.map((source) => source.name)).toEqual([
      'team-leader',
    ]);
    const append = leaderContext?.systemPrompt?.append ?? [];
    expect(append).toHaveLength(3);
    expect(append[0]).toBe('You are the TeamLeader of Dreamux Team "alpha".');
    expect(append[1]).toContain('team-workflow');
    expect(append[1]).toMatch(/TeamMate/i);
    expect(append[1]).toMatch(/channel/i);
    expect(append[1]).toMatch(/cron/i);
    expect(append[1]).toMatch(/transfer/i);
    expect(append[2]).toBe('team coordinator');
    expect(leaderContext?.systemPrompt).not.toHaveProperty('replace');
    expect(memberContext?.mcpServers.map((server) => server.name)).not.toContain('team');
    expect(memberContext?.mcpServers.map((server) => server.name)).not.toContain('cron');
    expect(memberContext?.disableFeatures).toEqual(['userInterrupt']);
    expect(memberContext?.skillSources?.map((source) => source.name)).toEqual([]);
    expect(memberContext?.systemPrompt?.append).toEqual([
      'worker specialist',
    ]);
    expect(memberContext?.systemPrompt?.append?.join('\n')).not.toContain(
      'TeamLeader of Dreamux Team',
    );
    expect(teammateContext?.skillSources?.map((source) => source.name)).toEqual([]);
    expect(memberContext?.systemPrompt).not.toHaveProperty('replace');
    expect(teammateContext?.disableFeatures).toEqual(['userInterrupt']);
    expect(teammateContext?.systemPrompt?.append).toEqual([
      'general helper',
    ]);
    expect(teammateContext?.systemPrompt?.append?.join('\n')).not.toContain(
      'TeamLeader of Dreamux Team',
    );
    expect(teammateContext?.systemPrompt).not.toHaveProperty('replace');

    await dispatcher.stop();
  });

  it('dispatcher team.send submits to the TeamLeader and rejects shutdown sends', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const contexts: AgentRuntimeCreateContext[] = [];
    const runtimes: FakeRuntime[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({
        runtimes,
        contexts,
      }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();
    await dispatcher.createTeam({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });

    const sent = await dispatcher.sendTeamLeader({
      teamId: 'alpha',
      prompt: 'follow up',
    });
    expect(sent.turn).toEqual({ status: 'submitted', turn_id: 'text-1' });
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]!.textSubmitted.map((input) => input.text)).toEqual([
      'follow up',
    ]);
    expect(runtimes[1]!.submitted).toEqual([]);

    await dispatcher.shutdown();
    await expect(
      Promise.resolve().then(() =>
        dispatcher.sendTeamLeader({ teamId: 'alpha', prompt: 'too late' }),
      ),
    ).rejects.toThrow(/shutting down/);
  });
});

function makeTeams(input: {
  config: ReturnType<typeof testDreamuxConfig>;
  log: DreamuxLogger;
  runtimes: FakeRuntime[];
  contexts?: AgentRuntimeCreateContext[];
}): TeamCollection {
  return new TeamCollection({
    dispatcherId: 'dispatcher-a',
    config: input.config,
    agentRuntimeProviders: fakeRuntimeCatalog({
      runtimes: input.runtimes,
      contexts: input.contexts,
    }),
    worktrees: new WorktreeManager(),
    identities: new TeamMateIdentityStore({ warn: input.log.warn.bind(input.log) }),
    turnsStore: new TeamMateTurnsStore({ warn: input.log.warn.bind(input.log) }),
    router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log: input.log }),
    initiatorFor: async () => null,
    isShuttingDown: () => false,
    adminSocketPath: '/tmp/admin.sock',
    leaderChannelDescriptors: () => [],
    log: input.log,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
