import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeProvider,
  DreamuxLogger,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

import { globalConfigFile } from '../src/config/config.js';
import { ConfigService } from '../src/config/service.js';
import { createFakeChannelProvider } from './helpers/fake-channel-provider.js';
import { workflowRunRecordPath } from '../src/platform/paths.js';
import { parseProviderRef } from '../src/registry/provider-ref.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { Server } from '../src/server.js';
import type { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import type { TeamService } from '../src/service/team/service.js';
import { TeammateCollection } from '../src/service/agent/index.js';
import { TeamCollection } from '../src/service/team/index.js';
import type { AgentService } from '../src/service/agent/service.js';
import type { TeamCreateCommand } from '@excitedjs/dreamux-types';
import { CHANNEL_SOURCE } from '../src/service/submission-sources.js';
import { adminContext } from './helpers/command-harness.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';
import {
  ControlledRuntime,
  ControlledRuntimeProvider,
  deferred,
} from './helpers/controlled-runtime-provider.js';

const DISPATCHER_ID = 'completion-lifecycle';
const AGENT_RUNTIME_ID = 'controlled';
const PROVIDER_REF = 'builtin:controlled';
const ACTIVE_WORKFLOW_SCRIPT = `
export const meta = {
  name: 'lifecycle-stop',
  description: 'Stay active until the owning scope stops',
};
return await agent('wait for owner teardown');
`;

const silentLogger: DreamuxLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
};

const hosts: LifecycleHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

describe('TeamMate completion delivery across deliberate lifecycle teardown', () => {
  it('keeps model and admin close results while suppressing actual owner input', async () => {
    const host = await createHost();
    const provider = new ControlledRuntimeProvider();
    const { server, dispatcher } = await host.start(provider);
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );

    const direct = await spawnDispatcherTeammate(
      dispatcher,
      provider,
      'direct-model',
    );
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

    const admin = await spawnDispatcherTeammate(
      dispatcher,
      provider,
      'direct-admin',
    );
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
      team: await openTeam(dispatcher, team.team_name),
    });
    await expect(
      leaderDelegate.call({
        name: 'close',
        arguments: {
          name: member.result.teammate.name,
          note: 'leader is done',
        },
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
    const leaderIndex = provider.runtimes.length;
    const creating = createTeam(
      dispatcher,
      'dissolve-team',
      'pending leader task',
    );
    const leaderRuntime = await runtimeAt(provider, leaderIndex);
    const team = await creating;
    await spawnTeamMember(
      dispatcher,
      provider,
      team.team_name,
      'pending-member',
    );

    await expect(
      dispatcher.teams.dissolve(team.team_name, {
        note: 'dissolve test complete',
        force: true,
      }),
    ).resolves.toEqual({
      accepted: true,
      team_name: team.team_name,
      status: 'submitted',
    });
    await vi.waitFor(async () => {
      const row = (await dispatcher.teams.list()).find(
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
    const team = await createTeam(dispatcher, 'workflow-dissolve');
    const leaderRuntime = await startTeamLeaderRecipient(
      dispatcher,
      provider,
      team.team_name,
    );
    const leader = await openTeam(dispatcher, team.team_name);
    const agentIndex = provider.runtimes.length;
    const accepted = await leader.workflows.run({
      script: ACTIVE_WORKFLOW_SCRIPT,
    });
    const workflowAgent = await runtimeAt(provider, agentIndex);
    await workflowAgent.submitStarted.promise;

    await expect(
      dispatcher.teams.dissolve(team.team_name, {
        note: 'stop active Team Workflow',
        force: true,
      }),
    ).resolves.toMatchObject({ accepted: true, status: 'submitted' });
    await vi.waitFor(async () => {
      const row = (await dispatcher.teams.list()).find(
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
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
    const creating = createTeam(
      first.dispatcher,
      'restart-team',
      'pending leader work at shutdown',
    );
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
    const direct = await spawnDispatcherTeammate(
      dispatcher,
      provider,
      'fenced-direct',
    );
    const leaderIndex = provider.runtimes.length;
    const creating = createTeam(
      dispatcher,
      'fenced-team',
      'pending leader work',
    );
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
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
    const admitted = dispatcher.fence.admit(async () => {
      admittedTaskStarted.resolve();
      await releaseAdmittedTask.promise;
      return service.submitInput({
        source: CHANNEL_SOURCE,
        text: 'work admitted before the dispatcher fence',
        completionRecipient: dispatcherAgent,
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
    const dispatcherRuntime = await startDispatcherRecipient(
      dispatcher,
      provider,
    );
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

/** Reopen the same file-backed installation with a new real process owner. */
class LifecycleHost {
  private readonly running = new Set<Server>();
  private socketSequence = 0;
  constructor(readonly root: string) {}
  async start(provider: AgentRuntimeProvider<unknown>): Promise<StartedServer> {
    const registry = new ProviderRegistry();
    registry.register(
      {
        id: 'controlled',
        kind: 'agentRuntime',
        ref: parseProviderRef(PROVIDER_REF),
      },
      provider,
    );
    registry.register(
      {
        id: 'fixture',
        kind: 'channel',
        ref: parseProviderRef('builtin:fixture'),
      },
      createFakeChannelProvider().provider,
    );
    const config = await ConfigService.open({ providerRegistry: registry });
    const server = new Server({
      config,
      providerRegistry: registry,
      adminSocketPath: join(this.root, `admin-${this.socketSequence++}.sock`),
      logger: silentLogger,
      channelLoggerFactory: () => silentLogger,
      workflowLoggerFactory: () => silentLogger,
    });
    this.running.add(server);
    await server.start();
    return { server, dispatcher: server.dispatchers.get(DISPATCHER_ID) };
  }
  async stop(server: Server): Promise<void> {
    await server.shutdown();
    this.running.delete(server);
  }
  async close(): Promise<void> {
    try {
      for (const server of this.running) await server.shutdown();
    } finally {
      this.running.clear();
      await rm(this.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }
}

async function createHost(): Promise<LifecycleHost> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-completion-lifecycle-'));
  vi.stubEnv('DREAMUX_ROOT', join(root, 'state'));
  const config = {
    agents: [{ id: AGENT_RUNTIME_ID, provider: PROVIDER_REF, config: {} }],
    dispatchers: [
      {
        id: DISPATCHER_ID,
        cwd: root,
        enabled: true,
        workspace: { enabled: false },
        channels: [{ id: 'fixture', provider: 'builtin:fixture', config: {} }],
        agentRuntime: AGENT_RUNTIME_ID,
      },
    ],
  };
  const file = globalConfigFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const host = new LifecycleHost(root);
  hosts.push(host);
  return host;
}

function teamCollection(dispatcher: DispatcherService): TeamCollection {
  if (!(dispatcher.teams instanceof TeamCollection))
    throw new Error('expected the actual Team collection');
  return dispatcher.teams;
}
function openTeam(
  dispatcher: DispatcherService,
  id: string,
): Promise<TeamService> {
  return teamCollection(dispatcher).open(id);
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
  const submitting = dispatcher.teams.submitToLeader(teamId, {
    source: CHANNEL_SOURCE,
    text: 'start TeamLeader recipient',
    deliverCompletionToDispatcher: false,
  });
  const runtime = await runtimeAt(provider, index);
  await expect(submitting).resolves.toMatchObject({ status: 'submitted' });
  runtime.submissions[0]!.complete('leader ready');
  return runtime;
}

async function createTeam(
  dispatcher: DispatcherService,
  prefix: string,
  prompt?: string,
) {
  const command: TeamCreateCommand = {
    request_id: `${prefix}-request`,
    name_prefix: prefix,
    intent: `exercise ${prefix}`,
    leader: {
      agent_runtime: AGENT_RUNTIME_ID,
      ...(prompt === undefined ? {} : { prompt }),
    },
  };
  return dispatcher.teams.createFromRequest({
    requestId: command.request_id,
    payloadHash: teamCreatePayloadHash(command),
    command,
    deliverCompletionToDispatcher: true,
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
  const team = await openTeam(dispatcher, teamId);
  const index = provider.runtimes.length;
  const spawning = team.teammates.spawn({
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

/** Reach public concrete-owner capabilities, without private-field casts. */
function materializedDispatcherTeammate(
  dispatcher: DispatcherService,
): AgentService {
  if (!(dispatcher.teammates instanceof TeammateCollection))
    throw new Error('expected actual TeamMate collection');
  const entities = dispatcher.teammates.materializedEntities();
  expect(entities).toHaveLength(1);
  return entities[0]!;
}
function materializedDispatcherAgent(
  dispatcher: DispatcherService,
): AgentService {
  const agent = dispatcher.dispatcherAgent.current;
  if (agent === null) throw new Error('expected materialized Dispatcher Agent');
  return agent;
}
function materializedTeamService(
  dispatcher: DispatcherService,
  teamId: string,
): Promise<TeamService> {
  return openTeam(dispatcher, teamId);
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
