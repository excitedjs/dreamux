import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeProvider,
  DreamuxLogger,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/catalog.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import type { DreamuxConfig } from '../src/config/config.js';
import {
  getRuntimeConfig,
  setRuntimeConfig,
  workflowRunRecordPath,
} from '../src/platform/paths.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { Server } from '../src/server.js';
import type { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { teamCreatePayloadHash } from '../src/service/team-collection/create-request.js';
import { createTeamMateMcpDelegate } from '../src/service/teammate-collection/mcp-delegate.js';
import type { TeamService } from '../src/service/team-service/index.js';
import type { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import { CHANNEL_SOURCE } from '../src/service/submission-sources.js';
import { adminContext } from './helpers/command-harness.js';
import {
  controllableRuntimeSubmission,
} from './helpers/runtime-submission.js';
import {
  ControlledRuntime,
  ControlledRuntimeProvider,
  deferred,
} from './helpers/controlled-runtime-provider.js';

const DISPATCHER_ID = 'completion-lifecycle';
const AGENT_RUNTIME_ID = 'controlled';
const PROVIDER_REF = 'npm:@example/completion-lifecycle-runtime';
const ACTIVE_WORKFLOW_SCRIPT = `
export const meta = {
  name: 'lifecycle-stop',
  description: 'Stay active until the owning scope stops',
};
return await agent('wait for owner teardown');
`;

const silentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
} as DreamuxLogger;

const hosts: LifecycleHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

describe('TeamMate completion delivery across deliberate lifecycle teardown', () => {
  it('keeps model and admin close results while suppressing actual owner input', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { server, dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);

    const direct = await spawnDispatcherTeammate(dispatcher, provider, 'direct-model');
    const dispatcherDelegate = createTeamMateMcpDelegate({
      kind: 'dispatcher',
      dispatcher,
    });
    await expect(
      dispatcherDelegate.call({
        name: 'close',
        arguments: { name: direct.result.teammate.name, note: 'model is done' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      structured: {
        teammate: { name: direct.result.teammate.name, status: 'closed' },
      },
    });

    const admin = await spawnDispatcherTeammate(dispatcher, provider, 'direct-admin');
    await expect(
      server.commands.invoke(adminContext(DISPATCHER_ID), 'teammate.close', {
        name: admin.result.teammate.name,
        note: 'admin is done',
      }),
    ).resolves.toMatchObject({
      teammate: { name: admin.result.teammate.name, status: 'closed' },
    });

    const team = await createTeam(dispatcher, 'close-team');
    const leaderRuntime = await startTeamLeaderRecipient(
      dispatcher,
      provider,
      team.team_name,
    );
    const member = await spawnTeamMember(
      dispatcher,
      provider,
      team.team_name,
      'team-model',
    );
    const leaderDelegate = createTeamMateMcpDelegate({
      kind: 'team_leader',
      team: () => dispatcher.team(team.team_name),
    });
    await expect(
      leaderDelegate.call({
        name: 'close',
        arguments: { name: member.result.teammate.name, note: 'leader is done' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      structured: {
        teammate: { name: member.result.teammate.name, status: 'closed' },
      },
    });

    expect(completionInputs(dispatcherRuntime)).toEqual([]);
    expect(completionInputs(leaderRuntime)).toEqual([]);
  });

  it('dissolves a real Team without member-to-leader or leader-to-Dispatcher cleanup input', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const leaderIndex = provider.runtimes.length;
    const creating = dispatcher.createTeam({
      requestId: 'dissolve-request',
      payloadHash: teamCreatePayloadHash({ scenario: 'dissolve' }),
      options: {
        namePrefix: 'dissolve-team',
        leaderAgentRuntime: AGENT_RUNTIME_ID,
        intent: 'exercise Team dissolve',
        prompt: 'pending leader task',
      },
    });
    const leaderRuntime = await runtimeAt(provider, leaderIndex);
    const team = await creating;
    await spawnTeamMember(
      dispatcher,
      provider,
      team.team_name,
      'pending-member',
    );

    await expect(
      dispatcher.dissolveTeam({
        teamId: team.team_name,
        note: 'dissolve test complete',
        force: true,
      }),
    ).resolves.toEqual({
      accepted: true,
      team_name: team.team_name,
      status: 'submitted',
    });
    await vi.waitFor(async () => {
      const row = (await dispatcher.listTeams()).find(
        (candidate) => candidate.team_name === team.team_name,
      );
      expect(row?.status).toBe('closed');
    });

    expect(completionInputs(leaderRuntime)).toEqual([]);
    expect(completionInputs(dispatcherRuntime)).toEqual([]);
  });

  it('dissolves a Team with an active Workflow without submitting its stopped terminal fact', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const team = await createTeam(dispatcher, 'workflow-dissolve');
    const leaderRuntime = await startTeamLeaderRecipient(
      dispatcher,
      provider,
      team.team_name,
    );
    const leader = await dispatcher.team(team.team_name);
    const agentIndex = provider.runtimes.length;
    const accepted = await leader.workflows.run({
      script: ACTIVE_WORKFLOW_SCRIPT,
    });
    const workflowAgent = await runtimeAt(provider, agentIndex);
    await workflowAgent.submitStarted.promise;

    await expect(
      dispatcher.dissolveTeam({
        teamId: team.team_name,
        note: 'stop active Team Workflow',
        force: true,
      }),
    ).resolves.toMatchObject({ accepted: true, status: 'submitted' });
    await vi.waitFor(async () => {
      const row = (await dispatcher.listTeams()).find(
        (candidate) => candidate.team_name === team.team_name,
      );
      expect(row?.status).toBe('closed');
    });

    const record = JSON.parse(
      await readFile(
        workflowRunRecordPath({
          dispatcherId: DISPATCHER_ID,
          teamId: team.team_name,
          runId: accepted.run_id,
        }),
        'utf8',
      ),
    ) as { status: string };
    expect(record.status).toBe('stopped');
    expect(completionInputs(leaderRuntime)).toEqual([]);
    expect(completionInputs(dispatcherRuntime)).toEqual([]);
  });

  it('keeps a failed host stop published through late admission settlement without owner input', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const lateAdmission = deferred<RuntimeAdmission>();
    const stopError = new Error('native stop failed');
    provider.planNext({
      delayedAdmission: lateAdmission.promise,
      stopFailures: [stopError],
    });
    const runtimeIndex = provider.runtimes.length;
    const spawning = dispatcher.teammates.spawn({
      name: 'late-admission',
      prompt: 'work whose admission resolves during stop',
      intent: 'exercise the host-stop admission race',
    });
    const teammateRuntime = await runtimeAt(provider, runtimeIndex);
    await teammateRuntime.submitStarted.promise;

    const stopping = materializedDispatcherTeammate(dispatcher).stopForHost();
    await teammateRuntime.stopStarted.promise;
    expect(await hasSettled(stopping)).toBe(false);
    const lateSubmission = controllableRuntimeSubmission();
    lateAdmission.resolve({
      status: 'submitted',
      submission: lateSubmission.submission,
    });
    lateSubmission.complete('late result');

    await expect(spawning).resolves.toMatchObject({ status: 'submitted' });
    await expect(stopping).rejects.toBe(stopError);
    expect(completionInputs(dispatcherRuntime)).toEqual([]);
  });

  it('suppresses shutdown cleanup and delivers a new Turn after restart', async () => {
    const host = await createHost();
    const firstProvider = new ControlledRuntimeProvider();
    const first = await host.start(firstProvider);
    const firstDispatcherRuntime = await startDispatcherRecipient(
      first.dispatcher,
      firstProvider,
    );
    const direct = await spawnDispatcherTeammate(
      first.dispatcher,
      firstProvider,
      'restart-direct',
    );
    const leaderIndex = firstProvider.runtimes.length;
    const creating = first.dispatcher.createTeam({
      requestId: 'restart-request',
      payloadHash: teamCreatePayloadHash({ scenario: 'restart' }),
      options: {
        namePrefix: 'restart-team',
        leaderAgentRuntime: AGENT_RUNTIME_ID,
        intent: 'exercise host restart',
        prompt: 'pending leader work at shutdown',
      },
    });
    const firstLeaderRuntime = await runtimeAt(firstProvider, leaderIndex);
    const team = await creating;
    await spawnTeamMember(
      first.dispatcher,
      firstProvider,
      team.team_name,
      'restart-member',
    );

    await host.stop(first.server);
    expect(completionInputs(firstDispatcherRuntime)).toEqual([]);
    expect(completionInputs(firstLeaderRuntime)).toEqual([]);

    const secondProvider = new ControlledRuntimeProvider();
    const second = await host.start(secondProvider);
    const secondDispatcherRuntime = await startDispatcherRecipient(
      second.dispatcher,
      secondProvider,
    );
    const runtimeIndex = secondProvider.runtimes.length;
    const sending = second.dispatcher.teammates.send({
      name: direct.result.teammate.name,
      prompt: 'new work after restart',
      intent: 'prove future delivery remains eligible',
    });
    const restartedTeammate = await runtimeAt(secondProvider, runtimeIndex);
    await expect(sending).resolves.toMatchObject({ status: 'submitted' });
    restartedTeammate.submissions[0]!.complete('post-restart result');

    await vi.waitFor(() => {
      expect(completionInputs(secondDispatcherRuntime)).toHaveLength(1);
    });
  });

  it('drops completions settling behind the dispatcher fence while Workflow teardown still runs', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { server, dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const direct = await spawnDispatcherTeammate(
      dispatcher,
      provider,
      'fenced-direct',
    );
    const leaderIndex = provider.runtimes.length;
    const creating = dispatcher.createTeam({
      requestId: 'fenced-team-request',
      payloadHash: teamCreatePayloadHash({ scenario: 'dispatcher-fence' }),
      options: {
        namePrefix: 'fenced-team',
        leaderAgentRuntime: AGENT_RUNTIME_ID,
        intent: 'exercise the dispatcher fence',
        prompt: 'pending leader work',
      },
    });
    const leaderRuntime = await runtimeAt(provider, leaderIndex);
    const team = await creating;
    const member = await spawnTeamMember(
      dispatcher,
      provider,
      team.team_name,
      'fenced-member',
    );

    const allowWorkflowStop = deferred<void>();
    provider.planNext({ stopBarrier: allowWorkflowStop.promise });
    const workflowAgentIndex = provider.runtimes.length;
    await dispatcher.workflows.run({ script: ACTIVE_WORKFLOW_SCRIPT });
    const workflowAgent = await runtimeAt(provider, workflowAgentIndex);
    await workflowAgent.submitStarted.promise;

    const stopping = host.stop(server);
    await workflowAgent.stopStarted.promise;
    direct.runtime.submissions[0]!.complete('direct completed after fence');
    member.runtime.submissions[0]!.complete('member completed after fence');
    leaderRuntime.submissions[0]!.complete('leader completed after fence');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(completionInputs(leaderRuntime)).toEqual([]);
    expect(completionInputs(dispatcherRuntime)).toEqual([]);

    allowWorkflowStop.resolve();
    await stopping;
  });

  it('keeps the dispatcher fence closed while an admitted task restarts a released TeamLeader', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { server, dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const team = await createTeam(dispatcher, 'restart-under-fence');
    await startTeamLeaderRecipient(dispatcher, provider, team.team_name);

    const releaseDirectStop = deferred<void>();
    provider.planNext({ stopBarrier: releaseDirectStop.promise });
    const direct = await spawnDispatcherTeammate(
      dispatcher,
      provider,
      'block-direct-sweep',
    );
    const dispatcherAgent = materializedDispatcherAgent(dispatcher);
    const service = await materializedTeamService(dispatcher, team.team_name);
    const releaseAdmittedTask = deferred<void>();
    const admittedTaskStarted = deferred<void>();
    const admitted = dispatcher.admitOperation(async () => {
      admittedTaskStarted.resolve();
      await releaseAdmittedTask.promise;
      return service.submitToLeader({
        source: CHANNEL_SOURCE,
        text: 'work admitted before the dispatcher fence',
        initiator: dispatcherAgent,
      });
    });
    await admittedTaskStarted.promise;

    const restartedLeaderIndex = provider.runtimes.length;
    const stopping = host.stop(server);
    await direct.runtime.stopStarted.promise;
    try {
      releaseAdmittedTask.resolve();
      const restartedLeader = await runtimeAt(provider, restartedLeaderIndex);
      await expect(admitted).resolves.toMatchObject({ status: 'submitted' });
      restartedLeader.submissions[0]!.complete('completed after release sweep');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completionInputs(dispatcherRuntime)).toEqual([]);
    } finally {
      releaseDirectStop.resolve();
    }
    await stopping;
  });

  it('stops an active Dispatcher Workflow without submitting its terminal fact during host shutdown', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { server, dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(dispatcher, provider);
    const agentIndex = provider.runtimes.length;
    const accepted = await dispatcher.workflows.run({
      script: ACTIVE_WORKFLOW_SCRIPT,
    });
    const workflowAgent = await runtimeAt(provider, agentIndex);
    await workflowAgent.submitStarted.promise;

    await host.stop(server);

    const record = JSON.parse(
      await readFile(
        workflowRunRecordPath({
          dispatcherId: DISPATCHER_ID,
          teamId: null,
          runId: accepted.run_id,
        }),
        'utf8',
      ),
    ) as { status: string };
    expect(record.status).toBe('stopped');
    expect(completionInputs(dispatcherRuntime)).toEqual([]);
  });
});

interface StartedServer {
  readonly server: Server;
  readonly dispatcher: DispatcherService;
}

class LifecycleHost {
  private readonly running = new Set<Server>();
  private socketSequence = 0;

  constructor(
    readonly root: string,
    private readonly workspace: string,
    private readonly config: DreamuxConfig,
    private readonly previousConfig: DreamuxConfig,
    private readonly previousRoot: string | undefined,
  ) {}

  async start(provider: AgentRuntimeProvider<unknown>): Promise<StartedServer> {
    const registry = new ProviderRegistry();
    registry.register({
      id: PROVIDER_REF,
      kind: 'agentRuntime',
      ref: parseProviderRef(PROVIDER_REF),
    });
    registry.registerImplementation(PROVIDER_REF, provider);
    const server = new Server({
      config: this.config,
      providerRegistry: registry,
      agentRuntimeProviderCatalog: new AgentRuntimeProviderCatalog({ registry }),
      channelProviderCatalog: new ChannelProviderCatalog({ registry }),
      adminSocketPath: join(this.root, `admin-${this.socketSequence++}.sock`),
      logger: silentLogger,
    });
    await server.start();
    this.running.add(server);
    return { server, dispatcher: server.getDispatcher(DISPATCHER_ID) };
  }

  async stop(server: Server): Promise<void> {
    try {
      await server.shutdown();
    } finally {
      this.running.delete(server);
    }
  }

  async close(): Promise<void> {
    for (const server of [...this.running]) {
      await server.shutdown();
    }
    this.running.clear();
    setRuntimeConfig(this.previousConfig);
    if (this.previousRoot === undefined) delete process.env['DREAMUX_ROOT'];
    else process.env['DREAMUX_ROOT'] = this.previousRoot;
    await rm(this.root, { recursive: true, force: true });
    await rm(this.workspace, { recursive: true, force: true });
  }
}

async function createHost(): Promise<LifecycleHost> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-completion-lifecycle-'));
  const workspace = await mkdtemp(join(tmpdir(), 'dreamux-completion-workspace-'));
  const previousConfig = getRuntimeConfig();
  const previousRoot = process.env['DREAMUX_ROOT'];
  process.env['DREAMUX_ROOT'] = root;
  const runtime = { provider: PROVIDER_REF, config: {} };
  const config: DreamuxConfig = {
    agents: { [AGENT_RUNTIME_ID]: runtime },
    dispatchers: [
      {
        id: DISPATCHER_ID,
        cwd: workspace,
        enabled: true,
        workspace: { enabled: false },
        channels: [],
        agentRuntime: AGENT_RUNTIME_ID,
        runtime,
      },
    ],
  };
  const host = new LifecycleHost(
    root,
    workspace,
    config,
    previousConfig,
    previousRoot,
  );
  hosts.push(host);
  return host;
}

async function runtimeAt(
  provider: ControlledRuntimeProvider,
  index: number,
): Promise<ControlledRuntime> {
  await vi.waitFor(() => {
    expect(provider.runtimes.length).toBeGreaterThan(index);
  });
  return provider.runtimes[index]!;
}

async function startDispatcherRecipient(
  dispatcher: DispatcherService,
  provider: ControlledRuntimeProvider,
): Promise<ControlledRuntime> {
  const index = provider.runtimes.length;
  const submitting = dispatcher.submitToAgent({
    source: CHANNEL_SOURCE,
    text: 'start dispatcher recipient',
  });
  const runtime = await runtimeAt(provider, index);
  await expect(submitting).resolves.toMatchObject({ status: 'submitted' });
  runtime.submissions[0]!.complete('dispatcher ready');
  return runtime;
}

async function startTeamLeaderRecipient(
  dispatcher: DispatcherService,
  provider: ControlledRuntimeProvider,
  teamId: string,
): Promise<ControlledRuntime> {
  const index = provider.runtimes.length;
  const submitting = dispatcher.submitToTeamLeader({
    teamId,
    source: CHANNEL_SOURCE,
    text: 'start TeamLeader recipient',
    deliverCompletionToDispatcher: false,
  });
  const runtime = await runtimeAt(provider, index);
  await expect(submitting).resolves.toMatchObject({ status: 'submitted' });
  runtime.submissions[0]!.complete('leader ready');
  return runtime;
}

async function createTeam(dispatcher: DispatcherService, prefix: string) {
  return dispatcher.createTeam({
    requestId: `${prefix}-request`,
    payloadHash: teamCreatePayloadHash({ prefix }),
    options: {
      namePrefix: prefix,
      leaderAgentRuntime: AGENT_RUNTIME_ID,
      intent: `exercise ${prefix}`,
    },
  });
}

async function spawnDispatcherTeammate(
  dispatcher: DispatcherService,
  provider: ControlledRuntimeProvider,
  name: string,
) {
  const index = provider.runtimes.length;
  const spawning = dispatcher.teammates.spawn({
    name,
    prompt: `pending work for ${name}`,
    intent: `exercise ${name}`,
  });
  const runtime = await runtimeAt(provider, index);
  return { result: await spawning, runtime };
}

async function spawnTeamMember(
  dispatcher: DispatcherService,
  provider: ControlledRuntimeProvider,
  teamId: string,
  name: string,
) {
  const team = await dispatcher.team(teamId);
  const index = provider.runtimes.length;
  const spawning = team.spawnTeamMate({
    name,
    prompt: `pending work for ${name}`,
    intent: `exercise ${name}`,
  });
  const runtime = await runtimeAt(provider, index);
  return { result: await spawning, runtime };
}

function completionInputs(runtime: ControlledRuntime): string[] {
  return runtime.inputs.filter(isCompletionInput);
}

/** Exercise the owner-only lifecycle operation without stopping its recipient. */
function materializedDispatcherTeammate(
  dispatcher: DispatcherService,
): TeammateService {
  const collection = (
    dispatcher as unknown as { readonly _teammates: TeammateCollection }
  )._teammates;
  const entities = collection.materializedEntities();
  expect(entities).toHaveLength(1);
  return entities[0]!;
}

function materializedDispatcherAgent(
  dispatcher: DispatcherService,
): TeammateService {
  const inputSources = (
    dispatcher as unknown as {
      readonly inputSources: { readonly agent: TeammateService | null };
    }
  ).inputSources;
  expect(inputSources.agent).not.toBeNull();
  return inputSources.agent!;
}

function materializedTeamService(
  dispatcher: DispatcherService,
  teamId: string,
): Promise<TeamService> {
  const teams = (
    dispatcher as unknown as {
      readonly teams: { open(id: string): Promise<TeamService> };
    }
  ).teams;
  return teams.open(teamId);
}

async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setImmediate(() => resolve(false))),
  ]);
}

function isCompletionInput(text: string): boolean {
  return text.startsWith('<task-notification>');
}
