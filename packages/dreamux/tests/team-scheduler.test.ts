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
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelRoutes,
  ChannelSession,
  ChannelTarget,
  ChannelToolCall,
  DreamuxLogger,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { adminMethods } from '../src/admin/methods.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import {
  TeamCollection,
  TeamUnavailableError,
} from '../src/service/team-collection/index.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { ensureDispatcherIdentity } from '../src/service/dispatcher-service/identity.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import {
  dispatcherTeamCronJobsPath,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { Server } from '../src/server.js';
import { writeRestartIntent } from '../src/daemon/restart-intent.js';

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

class ResumedRuntime extends FakeRuntime {
  override wasCheckpointResumed(): boolean {
    return true;
  }
}

class DeferredStartRuntime extends FakeRuntime {
  releaseStart: (() => void) | null = null;

  override async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.releaseStart = resolve;
    });
    await super.start();
  }
}

function fakeRuntimeCatalog(input: {
  runtimes: FakeRuntime[];
  contexts?: AgentRuntimeCreateContext[];
  createRuntime?: (context: AgentRuntimeCreateContext) => FakeRuntime;
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
      const runtime = input.createRuntime?.(context) ?? new FakeRuntime();
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

function skillSourceNames(
  contexts: readonly AgentRuntimeCreateContext[],
  requiredName: string,
): string[] | undefined {
  return contexts
    .find((context) => context.skillSources?.some(
      (source) => source.name === requiredName,
    ))
    ?.skillSources
    ?.map((source) => source.name);
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

const CHANNEL_PROVIDER_REF = 'builtin:feishu';
const CHANNEL_DESCRIPTOR: ChannelProviderDescriptor = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: CHANNEL_PROVIDER_REF },
};

class CapturingChannelSession implements ChannelSession {
  readonly provider = CHANNEL_PROVIDER_REF;
  readonly channel_id: string;
  routes: ChannelRoutes | null = null;
  startCount = 0;
  closeCount = 0;
  handledTools: ChannelToolCall[] = [];

  constructor(
    channelId: string,
    private readonly startBlocker?: Promise<void>,
  ) {
    this.channel_id = channelId;
  }

  async start(routes: ChannelRoutes): Promise<void> {
    this.startCount += 1;
    this.routes = routes;
    await this.startBlocker;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  async resolveTarget(meta: unknown): Promise<ChannelTarget> {
    const chatId =
      typeof (meta as { chat_id?: unknown })?.chat_id === 'string'
        ? (meta as { chat_id: string }).chat_id
        : 'chat-default';
    return groupTarget(chatId);
  }

  async handleTool(call: ChannelToolCall): Promise<unknown> {
    this.handledTools.push(call);
    return { channel_id: this.channel_id, tool: call.name };
  }

  async emit(
    targetKey: string,
    text: string,
  ): Promise<AgentRuntimeTurnResult> {
    if (this.routes === null) throw new Error('channel not started');
    return this.routes.deliver(
      { sourceId: `message:${targetKey}:${text}`, text },
      {
        provider: this.provider,
        channel_id: this.channel_id,
        target: groupTarget(targetKey),
      }
    );
  }
}

function groupTarget(targetKey: string): ChannelTarget {
  return {
    target_type: 'group',
    target_key: targetKey,
    bindable: true,
    meta: { chat_id: targetKey },
  };
}

function capturingChannelCatalog(
  sessions: CapturingChannelSession[],
  options: { startBlockers?: Record<string, Promise<void>> } = {},
): ChannelProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve('builtin:feishu');
  const provider: ChannelProvider = {
    ref: CHANNEL_PROVIDER_REF,
    descriptor: {
      ...CHANNEL_DESCRIPTOR,
      id: descriptor.id,
      ref: descriptor.ref,
    },
    readConfig: (raw) => raw,
    createSession(context) {
      const session = new CapturingChannelSession(
        context.channel_id,
        options.startBlockers?.[context.channel_id],
      );
      sessions.push(session);
      return session;
    },
    tools: () => [{ name: 'reply' }],
  };
  registry.registerImplementation(descriptor.id, provider);
  return new ChannelProviderCatalog({ registry });
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

  it('startSchedulers reuses cached Team services', async () => {
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
    const runtimes: FakeRuntime[] = [];
    const log = noopLog();
    const teams = makeTeams({ config, log, runtimes });

    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    expect(runtimes).toHaveLength(1);

    teams.stopSchedulers();
    await new CronJobStore({
      dispatcherId: 'dispatcher-a',
      cronJobsPath: dispatcherTeamCronJobsPath('dispatcher-a', 'alpha'),
    }).create(
      {
        cron: '* * * * *',
        tz: 'UTC',
        recurring: false,
        action: { kind: 'prompt-agent', prompt: 'scheduled after warm restart' },
        nextRunAt: Date.now() + 2000,
      },
      128,
    );
    await teams.startSchedulers();

    expect(runtimes).toHaveLength(1);
    await waitFor(() => runtimes[0]!.textSubmitted.length === 1, 4000);
    expect(runtimes[0]!.textSubmitted[0]).toEqual({
      text: 'scheduled after warm restart',
      sourceId: expect.stringMatching(/^scheduled:job-/),
    });
    teams.stopSchedulers();
    await teams.stopAll();
  });

  it('rejects same-name create while Team route closing is in flight', async () => {
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

    const closingEntered = deferred<void>();
    const releaseClosing = deferred<void>();
    const closing = teams.withTeamRouteClosing('alpha', async () => {
      closingEntered.resolve();
      await releaseClosing.promise;
      return null;
    });
    await closingEntered.promise;

    await expect(
      teams.create({
        name: 'alpha',
        leaderAgentRuntime: 'agent-a',
        intent: 'new alpha',
      }),
    ).rejects.toThrow(/closing/);

    releaseClosing.resolve();
    await closing;
    await teams.stopAll();
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
    const wake = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'wake dispatcher',
      tz: 'UTC',
    });
    await expect(dispatcher.scheduler.runNow(wake.id)).resolves.toMatchObject({
      status: 'submitted',
    });

    expect(dispatcher.runtimeStatus()).toEqual({
      status: 'ready',
      threadId: 'checkpoint-only-thread',
      lastError: null,
    });
    expect(dispatcher.summary(dispatchers.get('dispatcher-a')!)).toMatchObject({
      status: 'running',
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
    const wake = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'wake dispatcher',
      tz: 'UTC',
    });
    await expect(dispatcher.scheduler.runNow(wake.id)).resolves.toMatchObject({
      status: 'submitted',
    });
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
    expect(append).toHaveLength(4);
    expect(append[0]).toBe('You are the TeamLeader of Dreamux Team "alpha".');
    expect(append[1]).toContain('team-workflow');
    expect(append[1]).toMatch(/TeamMate/i);
    expect(append[1]).toMatch(/channel/i);
    expect(append[1]).toMatch(/cron/i);
    expect(append[1]).toMatch(/transfer/i);
    expect(append[2]).toMatch(/task was submitted successfully[\s\S]*end the turn naturally/i);
    expect(append[3]).toBe('team coordinator');
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

  it('keeps admin-only custom skill sources across role composition and cold rebuild', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
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
    const contexts: AgentRuntimeCreateContext[] = [];
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes: [], contexts }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();
    const server = {
      repos: {
        dispatchers: {
          get: (id: string) => id === 'dispatcher-a' ? { dispatcher_id: id } : null,
        },
      },
      getDispatcher: () => dispatcher,
    } as unknown as Server;
    const teammateSource = {
      name: 'admin-teammate',
      path: '/skills/admin/teammate',
      source: 'admin',
    };
    const leaderSource = {
      name: 'admin-team-leader',
      path: '/skills/admin/team-leader',
      source: 'admin',
    };
    const memberSource = {
      name: 'admin-team-member',
      path: '/skills/admin/team-member',
      source: 'admin',
    };

    const teammate = await adminMethods['teammate.spawn']!(server, {
      dispatcher_id: 'dispatcher-a',
      name_prefix: 'helper',
      prompt: 'help',
      intent: 'admin helper',
      skill_sources: [teammateSource],
    }) as { teammate: { name: string } };
    const team = await adminMethods['team.create']!(server, {
      dispatcher_id: 'dispatcher-a',
      team_name: 'alpha',
      leader_agent_runtime: 'agent-a',
      intent: 'lead alpha',
      skill_sources: [leaderSource],
    }) as { leader: { name: string } };
    const member = await adminMethods['teammate.spawn']!(server, {
      dispatcher_id: 'dispatcher-a',
      caller_kind: 'team_leader',
      team_id: 'alpha',
      name_prefix: 'worker',
      prompt: 'work',
      intent: 'admin member',
      skill_sources: [memberSource],
    }) as { teammate: { name: string } };

    expect(skillSourceNames(contexts, 'admin-teammate')).toEqual([
      'admin-teammate',
    ]);
    expect(skillSourceNames(contexts, 'admin-team-leader')).toEqual([
      'team-leader',
      'admin-team-leader',
    ]);
    expect(skillSourceNames(contexts, 'admin-team-member')).toEqual([
      'admin-team-member',
    ]);
    expect(JSON.stringify({ teammate, team, member })).not.toContain('/skills/admin/');
    await dispatcher.stop();

    const rebuiltContexts: AgentRuntimeCreateContext[] = [];
    const rebuilt = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({
        runtimes: [],
        contexts: rebuiltContexts,
      }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await rebuilt.start();
    await rebuilt.teammates.send({
      name: teammate.teammate.name,
      prompt: 'resume helper',
    });
    await rebuilt.sendTeamLeader({
      teamId: 'alpha',
      prompt: 'resume leader',
    });
    const rebuiltTeam = await rebuilt.team('alpha');
    await rebuiltTeam.teammates.send({
      name: member.teammate.name,
      prompt: 'resume member',
    });

    expect(skillSourceNames(rebuiltContexts, 'admin-teammate')).toEqual([
      'admin-teammate',
    ]);
    expect(skillSourceNames(rebuiltContexts, 'admin-team-leader')).toEqual([
      'team-leader',
      'admin-team-leader',
    ]);
    expect(skillSourceNames(rebuiltContexts, 'admin-team-member')).toEqual([
      'admin-team-member',
    ]);
    await rebuilt.stop();
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
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'follow up',
    ]);
    expect(runtimes[0]!.submitted).toEqual([]);

    await dispatcher.shutdown();
    await expect(
      Promise.resolve().then(() =>
        dispatcher.sendTeamLeader({ teamId: 'alpha', prompt: 'too late' }),
      ),
    ).rejects.toThrow(/shutting down/);
  });

  it('rejects scheduler mutations after dispatcher shutdown through held references', async () => {
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
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    const dispatcherScheduler = dispatcher.scheduler;
    const dispatcherJob = await dispatcherScheduler.create({
      cron: '* * * * *',
      prompt: 'scheduled dispatcher',
      tz: 'UTC',
    });
    await dispatcher.createTeam({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    const heldTeam = await dispatcher.team('alpha');
    const teamScheduler = await dispatcher.teamScheduler('alpha');
    const teamJob = await teamScheduler.create({
      cron: '* * * * *',
      prompt: 'scheduled alpha',
      tz: 'UTC',
    });
    expect(dispatcherScheduler).not.toHaveProperty('start');
    expect(dispatcherScheduler).not.toHaveProperty('deleteStoreFile');
    expect(teamScheduler).not.toHaveProperty('start');
    expect(teamScheduler).not.toHaveProperty('deleteStoreFile');
    expect(heldTeam).not.toHaveProperty('scheduler');
    expect(heldTeam).not.toHaveProperty('scheduler_');
    expect(heldTeam).not.toHaveProperty('schedulerLifecycle');
    expect(heldTeam).not.toHaveProperty('dissolve');
    expect(heldTeam).not.toHaveProperty('startScheduler');
    expect(heldTeam).not.toHaveProperty('stopScheduler');
    expect(heldTeam.teammates).not.toHaveProperty('spawn');

    await dispatcher.shutdown();

    await expect(
      dispatcherScheduler.create({
        cron: '* * * * *',
        prompt: 'late dispatcher',
        tz: 'UTC',
      }),
    ).rejects.toThrow(/shutting down/);
    await expect(dispatcherScheduler.runNow(dispatcherJob.id)).rejects.toThrow(
      /shutting down/,
    );
    await expect(
      teamScheduler.create({
        cron: '* * * * *',
        prompt: 'late alpha',
        tz: 'UTC',
      }),
    ).rejects.toThrow(/shutting down/);
    await expect(teamScheduler.runNow(teamJob.id)).rejects.toThrow(
      /shutting down/,
    );
    await expect(
      heldTeam.spawnTeamMate({
        name: 'late',
        prompt: 'late member',
        intent: 'late member',
      }),
    ).rejects.toThrow(/shutting down/);
  });

  it('rejects held TeamLeader handles after Team dissolve or replacement', async () => {
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
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.createTeam({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead alpha',
    });
    const oldHandle = await dispatcher.team('alpha');
    const member = await oldHandle.spawnTeamMate({
      name: 'worker',
      prompt: 'start worker',
      intent: 'work alpha',
    });
    expect(oldHandle.teammates).not.toHaveProperty('spawn');

    await dispatcher.dissolveTeam({ teamId: 'alpha', note: 'done' });
    await expect(
      oldHandle.teammates.send({
        name: member.teammate.name,
        prompt: 'after close',
      }),
    ).rejects.toThrow(/closed/);
    await expect(
      oldHandle.spawnTeamMate({
        name: 'late',
        prompt: 'late worker',
        intent: 'late alpha',
      }),
    ).rejects.toThrow(/closed/);

    await dispatcher.createTeam({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'lead replacement alpha',
    });
    await expect(oldHandle.teammates.list()).rejects.toThrow(
      /generation is no longer current/,
    );
    await expect(
      oldHandle.teammates.send({
        name: member.teammate.name,
        prompt: 'after replacement',
      }),
    ).rejects.toThrow(/generation is no longer current/);
    await expect(
      oldHandle.spawnTeamMate({
        name: 'stale',
        prompt: 'stale worker',
        intent: 'stale alpha',
      }),
    ).rejects.toThrow(/generation is no longer current/);

    const replacementHandle = await dispatcher.team('alpha');
    await expect(
      replacementHandle.spawnTeamMate({
        name: 'fresh',
        prompt: 'fresh worker',
        intent: 'fresh alpha',
      }),
    ).resolves.toMatchObject({
      teammate: { name: expect.stringMatching(/^tm-fresh-/) },
      turn: { status: 'submitted' },
    });
    await dispatcher.shutdown();
  });

  it('ordinary dispatcher start prepares inputs without starting its runtime', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes }),
      channelProviders: capturingChannelCatalog(sessions),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });

    await dispatcher.start();

    expect(runtimes).toHaveLength(0);
    expect(dispatcher.runtimeStatus()).toEqual({
      status: null,
      threadId: null,
      lastError: null,
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.startCount).toBe(1);
    await dispatcher.stop();
  });

  it('coalesces concurrent dispatcher starts into one prepared channel set', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes: [] }),
      channelProviders: capturingChannelCatalog(sessions),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });

    await Promise.all([dispatcher.start(), dispatcher.start()]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.startCount).toBe(1);
    await dispatcher.stop();
  });

  it('publishes each started channel before later channels finish starting', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    let releaseSecondary: (() => void) | null = null;
    const secondaryBlocker = new Promise<void>((resolve) => {
      releaseSecondary = resolve;
    });
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
          {
            id: 'secondary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes: [] }),
      channelProviders: capturingChannelCatalog(sessions, {
        startBlockers: { secondary: secondaryBlocker },
      }),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });

    const start = dispatcher.start();
    await waitFor(
      () =>
        sessions.length === 2 &&
        sessions[0]?.startCount === 1 &&
        sessions[1] !== undefined &&
        sessions[1].routes !== null,
    );

    await expect(
      dispatcher.invokeChannelTool({
        channelId: 'primary',
        name: 'reply',
        arguments: {},
        caller: { kind: 'dispatcher' },
      }),
    ).resolves.toEqual({ channel_id: 'primary', tool: 'reply' });

    releaseSecondary!();
    await start;
    await dispatcher.stop();
  });

  it('unbound channel inbound starts dispatcher runtime', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes }),
      channelProviders: capturingChannelCatalog(sessions),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();

    await expect(
      sessions[0]!.emit('chat-unbound', 'hello dispatcher', ),
    ).resolves.toMatchObject({ status: 'submitted' });

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.submitted.map((input) => input.text)).toEqual([
      'hello dispatcher',
    ]);
    await dispatcher.stop();
  });

  it('bound channel inbound starts only TeamLeader, not dispatcher runtime', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const contexts: AgentRuntimeCreateContext[] = [];
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes, contexts }),
      channelProviders: capturingChannelCatalog(sessions),
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
    await dispatcher.bindTeamChannel({
      teamId: 'alpha',
      channelId: 'primary',
      meta: { chat_id: 'chat-team' },
    });
    await dispatcher.stop();

    const restarted = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes, contexts }),
      channelProviders: capturingChannelCatalog(sessions),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await restarted.start();

    await expect(
      sessions.at(-1)!.emit('chat-team', 'hello leader', ),
    ).resolves.toMatchObject({ status: 'submitted' });

    expect(
      contexts.some((context) => context.identity.runtime_id === 'dispatcher-a'),
    ).toBe(false);
    expect(runtimes.at(-1)!.submitted.map((input) => input.text)).toEqual([
      'hello leader',
    ]);
    await restarted.stop();
  });

  it('dispatcher cron starts a dormant dispatcher runtime', async () => {
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
    const log = noopLog();
    const dispatcher = new DispatcherService({
      id: 'dispatcher-a',
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: fakeRuntimeCatalog({ runtimes }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();
    const job = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'scheduled dispatcher',
      tz: 'UTC',
    });

    await expect(dispatcher.scheduler.runNow(job.id)).resolves.toEqual({
      id: job.id,
      status: 'submitted',
    });

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.textSubmitted[0]).toMatchObject({
      text: 'scheduled dispatcher',
      sourceId: expect.stringMatching(/^scheduled:/),
    });
    await dispatcher.stop();
  });

  it('dispatcher cron skips submission when stop races a lazy runtime start', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    let runtime: DeferredStartRuntime | null = null;
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
        runtimes: [],
        createRuntime: () => {
          runtime = new DeferredStartRuntime();
          return runtime;
        },
      }),
      channelProviders: fakeChannelCatalog(),
      adminSocketPath: '/tmp/dreamux-admin.sock',
      channelLoggerFactory: () => log,
      log,
    });
    await dispatcher.start();
    const job = await dispatcher.scheduler.create({
      cron: '* * * * *',
      prompt: 'scheduled dispatcher',
      tz: 'UTC',
    });

    const run = dispatcher.scheduler.runNow(job.id);
    await waitFor(() => runtime !== null && runtime.releaseStart !== null);
    const stopped = dispatcher.stop();
    runtime!.releaseStart!();

    await stopped;
    await expect(run).resolves.toEqual({ id: job.id, status: 'skipped' });
    expect(runtime!.textSubmitted).toEqual([]);
    expect(dispatcher.runtimeStatus()).toEqual({
      status: null,
      threadId: null,
      lastError: null,
    });
  });

  it('server start injects notify-resumed before input sources can deliver turns', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const runtimes: FakeRuntime[] = [];
    const sessions: CapturingChannelSession[] = [];
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        channels: [
          {
            id: 'primary',
            provider: CHANNEL_PROVIDER_REF,
            config: {},
          },
        ],
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
    const log = noopLog();
    await seedDispatcherCheckpoint(config, workspace, log, 'checkpoint-resume');
    await writeRestartIntent({
      targets: ['dispatcher-a'],
      announce: 'Restart completed.',
      now: Date.now(),
    });
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({
        runtimes,
        createRuntime: () => new ResumedRuntime(),
      }),
      channelProviderCatalog: capturingChannelCatalog(sessions),
      adminSocketPath: join(root, 'admin.sock'),
      channelLoggerFactory: () => log,
      logger: log,
    });

    await server.start();

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.textSubmitted.map((input) => input.text)).toEqual([
      'Restart completed.',
    ]);
    expect(sessions[0]?.startCount).toBe(1);
    await server.shutdown();
  });

  it('server start ignores expired restart targets and keeps dispatcher dormant', async () => {
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
    await writeRestartIntent({
      targets: ['dispatcher-a'],
      ttlMs: 1,
      now: Date.now() - 10_000,
    });
    const log = noopLog();
    const server = new Server({
      config,
      agentRuntimeProviderCatalog: fakeRuntimeCatalog({
        runtimes,
        createRuntime: () => new ResumedRuntime(),
      }),
      channelProviderCatalog: fakeChannelCatalog(),
      adminSocketPath: join(root, 'admin.sock'),
      channelLoggerFactory: () => log,
      logger: log,
    });

    await server.start();

    expect(runtimes).toHaveLength(0);
    await server.shutdown();
  });
});

async function seedDispatcherCheckpoint(
  config: ReturnType<typeof testDreamuxConfig>,
  workspace: string,
  log: DreamuxLogger,
  sessionId: string,
): Promise<void> {
  const identities = new AgentIdentityStore(log);
  const dispatcher = config.dispatchers[0]!;
  const identity = await ensureDispatcherIdentity(identities, {
    dispatcherId: dispatcher.id,
    agentRuntime: dispatcher.agentRuntime,
    sourceCwd: workspace,
    cwd: workspace,
    runtimeCwd: workspace,
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: workspace,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
  });
  await identities.update(identity, { sessionId });
}

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
    identities: new AgentIdentityStore(input.log),
    turnsStore: new AgentTurnsStore(input.log),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
