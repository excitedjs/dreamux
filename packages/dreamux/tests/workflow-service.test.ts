import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeTurnResult,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  workflowRunJournalPath,
  type WorkflowScopePathInput,
} from '../src/platform/paths.js';
import {
  CompletionRouter,
  type CompletionDeliveryResult,
  type CompletionEnvelope,
  type CompletionInitiator,
} from '../src/service/completion-router/index.js';
import type {
  OwnedTeammateOwner,
  OwnedTeammateOps,
  OwnedTeamMateSpawnResult,
  SpawnOwnedTeamMateOptions,
} from '../src/service/teammate-collection/owned-teammates.js';
import { WorkflowJournal } from '../src/service/workflow-service/journal.js';
import type {
  WorkflowRunnerChildMessage,
  WorkflowRunnerParentMessage,
} from '../src/service/workflow-service/protocol.js';
import type {
  WorkflowRunnerFactory,
  WorkflowRunnerHandle,
  WorkflowRunnerHandlers,
} from '../src/service/workflow-service/runner-process.js';
import { WorkflowRunStore } from '../src/service/workflow-service/store.js';
import {
  WorkflowService,
} from '../src/service/workflow-service/index.js';
import type { WorkflowRunRecord } from '../src/service/workflow-service/types.js';
import type {
  AgentEntityRuntimeStatus,
} from '../src/service/agent-entity/types.js';

const SCOPE: WorkflowScopePathInput = {
  dispatcherId: 'dispatcher-workflow-test',
  teamId: null,
};

type OwnedSpawnInput = Parameters<OwnedTeammateOps['spawnOwned']>[0];

interface FakeSpawn {
  input: OwnedSpawnInput;
  options: SpawnOwnedTeamMateOptions;
  name: string;
  turnId: string;
  settled: boolean;
}

class FakeOwnedTeammates implements OwnedTeammateOps {
  readonly spawns: FakeSpawn[] = [];
  readonly releases: string[] = [];
  readonly routeTasks = new Set<Promise<void>>();
  private readonly owners = new Map<string, OwnedTeammateOwner>();
  spawnAttempts = 0;
  spawnError: Error | null = null;
  spawnErrorAfterOwnership: Error | null = null;
  releaseGate: Promise<void> | null = null;
  releaseAttempts = 0;
  releaseAllGate: Promise<void> | null = null;
  releaseAllError: Error | null = null;
  releaseAllAttempts = 0;
  autoSettle: {
    status: CompletionEnvelope['status'];
    result: string | null;
  } | null = null;
  nextTurnStatus: AgentRuntimeTurnResult['status'] = 'submitted';
  nextTurnError: Error | undefined;

  async spawnOwned(
    input: OwnedSpawnInput,
    options: SpawnOwnedTeamMateOptions,
  ): Promise<OwnedTeamMateSpawnResult> {
    this.spawnAttempts += 1;
    if (this.spawnError !== null) throw this.spawnError;
    const ordinal = this.spawns.length + 1;
    if (this.spawnErrorAfterOwnership !== null) {
      this.owners.set(input.name, options.owner);
      throw this.spawnErrorAfterOwnership;
    }
    const spawn: FakeSpawn = {
      input,
      options,
      name: input.name,
      turnId: `turn-${ordinal}`,
      settled: false,
    };
    this.spawns.push(spawn);
    this.owners.set(spawn.name, options.owner);
    if (this.autoSettle !== null) {
      const completion = this.autoSettle;
      const task = this.settleSpawn(spawn, completion.status, completion.result);
      this.routeTasks.add(task);
      void task.finally(() => this.routeTasks.delete(task));
    }
    return {
      teammate: teammateStatus(spawn.name, 'running'),
      turn: runtimeTurnResult(
        this.nextTurnStatus,
        spawn.turnId,
        this.nextTurnError,
      ),
    };
  }

  private async releaseOwned(
    name: string,
    owner: OwnedTeammateOwner,
  ): Promise<void> {
    if (this.owners.get(name) !== owner) {
      throw new Error(`fake TeamMate ${name} has a different owner`);
    }
    this.releaseAttempts += 1;
    await this.releaseGate;
    this.owners.delete(name);
    this.releases.push(name);
  }

  async releaseAllOwned(owner: OwnedTeammateOwner): Promise<void> {
    this.releaseAllAttempts += 1;
    await this.releaseAllGate;
    if (this.releaseAllError !== null) throw this.releaseAllError;
    const names = [...this.owners.entries()]
      .filter(([, currentOwner]) => currentOwner === owner)
      .map(([name]) => name);
    await Promise.all(names.map((name) => this.releaseOwned(name, owner)));
  }

  async sweepAllOwned(): Promise<void> {
    await Promise.all(
      [...this.owners.entries()].map(([name, owner]) =>
        this.releaseOwned(name, owner)),
    );
  }

  async settle(
    position: number,
    status: CompletionEnvelope['status'],
    result: string | null,
  ): Promise<void> {
    const spawn = this.spawns[position];
    if (spawn === undefined) throw new Error(`missing fake spawn ${position}`);
    await this.settleSpawn(spawn, status, result);
  }

  async settleAll(): Promise<void> {
    for (const spawn of this.spawns) {
      if (!spawn.settled) await this.settleSpawn(spawn, 'stopped', null);
    }
    await Promise.allSettled([...this.routeTasks]);
  }

  private async settleSpawn(
    spawn: FakeSpawn,
    status: CompletionEnvelope['status'],
    result: string | null,
  ): Promise<void> {
    if (spawn.settled) return;
    spawn.settled = true;
    await spawn.options.routeSettledCompletion(
      spawn.name,
      spawn.turnId,
      {
        kind: 'teammate',
        source: spawn.name,
        id: `${spawn.name}:${spawn.turnId}`,
        status,
        result,
      },
    );
  }
}

function runtimeTurnResult(
  status: AgentRuntimeTurnResult['status'],
  turnId: string,
  error?: Error,
): AgentRuntimeTurnResult {
  switch (status) {
    case 'submitted':
      return { status, turnId };
    case 'failed':
      return { status, error: error ?? new Error('runtime turn failed') };
    case 'duplicate':
    case 'stopped':
    case 'skipped':
      return { status };
  }
}

class FakeWorkflowRunner implements WorkflowRunnerHandle {
  readonly sent: WorkflowRunnerParentMessage[] = [];
  startCount = 0;
  stopCount = 0;

  constructor(
    private readonly handlers: WorkflowRunnerHandlers,
    private readonly onStart?: (runner: FakeWorkflowRunner) => void,
    private readonly onSend?: (
      message: WorkflowRunnerParentMessage,
      runner: FakeWorkflowRunner,
    ) => void,
  ) {}

  start(): Promise<void> {
    this.startCount += 1;
    this.onStart?.(this);
    return Promise.resolve();
  }

  async send(message: WorkflowRunnerParentMessage): Promise<void> {
    this.sent.push(message);
    this.onSend?.(message, this);
  }

  stop(): Promise<void> {
    this.stopCount += 1;
    return Promise.resolve();
  }

  emit(message: WorkflowRunnerChildMessage): void {
    this.handlers.onMessage(message);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.handlers.onExit({ code, signal });
  }
}

class RunnerHarness {
  readonly runners: FakeWorkflowRunner[] = [];
  onStart?: (runner: FakeWorkflowRunner) => void;
  onSend?: (
    message: WorkflowRunnerParentMessage,
    runner: FakeWorkflowRunner,
  ) => void;

  readonly factory: WorkflowRunnerFactory = (handlers) => {
    const runner = new FakeWorkflowRunner(
      handlers,
      (current) => this.onStart?.(current),
      (message, current) => this.onSend?.(message, current),
    );
    this.runners.push(runner);
    return runner;
  };

  latest(): FakeWorkflowRunner {
    const runner = this.runners.at(-1);
    if (runner === undefined) throw new Error('no fake workflow runner');
    return runner;
  }
}

class CapturingInitiator implements CompletionInitiator {
  readonly received: CompletionEnvelope[] = [];
  deliveryGate: Promise<void> | null = null;

  async completionInput(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult> {
    this.received.push(completion);
    if (this.deliveryGate !== null) await this.deliveryGate;
    return { status: 'accepted' };
  }
}

interface TestContext {
  service: WorkflowService;
  runner: RunnerHarness;
  teammates: FakeOwnedTeammates;
  initiator: CapturingInitiator;
  log: CaptureLog;
}

interface CaptureLog {
  logger: DreamuxLogger;
  events: Array<{
    level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
    fields: Record<string, unknown> | null;
    message: string | null;
  }>;
}

describe('WorkflowService', () => {
  let home: string;
  let previousHome: string | undefined;
  const services: WorkflowService[] = [];
  const teammateFakes: FakeOwnedTeammates[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dreamux-workflow-service-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(async () => {
    for (const teammates of teammateFakes) await teammates.settleAll();
    await Promise.allSettled(services.map((service) => service.stopAll()));
    services.length = 0;
    teammateFakes.length = 0;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function context(
    runIds: string[],
    configure?: (harness: RunnerHarness) => void,
    start = true,
  ): Promise<TestContext> {
    const runner = new RunnerHarness();
    configure?.(runner);
    const teammates = new FakeOwnedTeammates();
    const initiator = new CapturingInitiator();
    const log = captureLog();
    const router = new CompletionRouter({
      dispatcherId: SCOPE.dispatcherId,
      log: log.logger,
    });
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      ownedTeammates: teammates,
      router,
      completionInitiator: () => initiator,
      createRunner: runner.factory,
      generateRunId: () => {
        const next = runIds.shift();
        if (next === undefined) throw new Error('fake run ids exhausted');
        return next;
      },
      log: log.logger,
    });
    services.push(service);
    teammateFakes.push(teammates);
    if (start) await service.start();
    return { service, runner, teammates, initiator, log };
  }

  it('registers terminal delivery before runner start and evicts the terminal entity', async () => {
    const ctx = await context(['run-register-first'], (harness) => {
      harness.onStart = (runner) => {
        runner.emit({
          type: 'run_result',
          status: 'completed',
          result: { answer: 42 },
        });
      };
    });

    const accepted = await ctx.service.run({ script: validScript() });
    expect(accepted).toEqual({ run_id: 'run-register-first' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));

    expect(ctx.initiator.received[0]).toMatchObject({
      source: 'workflow',
      id: 'run-register-first',
      status: 'completed',
    });
    expect(JSON.parse(ctx.initiator.received[0]?.result ?? '')).toMatchObject({
      run_id: 'run-register-first',
      result: { answer: 42 },
      agents: [],
    });
    expect(await ctx.service.status({ run_id: 'run-register-first' })).toMatchObject({
      status: 'completed',
      result: { answer: 42 },
    });
    expect(activeRunCount(ctx.service)).toBe(0);
    await vi.waitFor(() => expect(ctx.log.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'info',
        message: 'workflow run created',
      }),
      expect.objectContaining({
        level: 'info',
        message: 'workflow run terminal',
      }),
    ])));
  });

  it('waits for an admitted run creation before sweeping live runs on stop', async () => {
    const ctx = await context(['run-create-stop-race']);
    const createStarted = deferred<void>();
    const allowCreate = deferred<void>();
    const originalCreate = WorkflowRunStore.prototype.create;
    vi.spyOn(WorkflowRunStore.prototype, 'create').mockImplementationOnce(
      async function (this: WorkflowRunStore, record) {
        createStarted.resolve();
        await allowCreate.promise;
        await originalCreate.call(this, record);
      },
    );

    const runTask = ctx.service.run({ script: validScript() });
    await createStarted.promise;
    expect((await journalEvents('run-create-stop-race'))[0]).toMatchObject({
      kind: 'run',
      version: 1,
      run_id: 'run-create-stop-race',
    });
    let stopSettled = false;
    const stopTask = ctx.service.stopAll().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    allowCreate.resolve();
    await expect(runTask).resolves.toEqual({ run_id: 'run-create-stop-race' });
    await stopTask;
    expect(ctx.runner.latest().stopCount).toBeGreaterThan(0);
    expect(await ctx.service.status({ run_id: 'run-create-stop-race' }))
      .toMatchObject({ status: 'stopped' });
  });

  it('waits for terminal persistence and delivery before stopAll returns', async () => {
    const ctx = await context(['run-terminal-drain']);
    const allowDelivery = deferred<void>();
    ctx.initiator.deliveryGate = allowDelivery.promise;
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'run_result',
      status: 'completed',
      result: 'done',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(await ctx.service.status({ run_id: 'run-terminal-drain' }))
      .toMatchObject({ status: 'completed' });

    let stopSettled = false;
    const stopTask = ctx.service.stopAll().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    allowDelivery.resolve();
    await stopTask;
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('reserves stopped before an admission fence rejects queued agents', async () => {
    const ctx = await context(['run-fenced-queue'], (harness) => {
      harness.onSend = (message, runner) => {
        if (message.type === 'agent_result' && message.error !== undefined) {
          runner.emit({
            type: 'run_result',
            status: 'failed',
            error: message.error,
          });
        }
      };
    });
    await ctx.service.run({ script: validScript(), max_concurrency: 1 });
    const runner = ctx.runner.latest();
    for (const index of [0, 1]) {
      runner.emit({
        type: 'agent_start',
        index,
        prompt: `agent ${index}`,
        options: {},
      });
    }
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    const stopTask = ctx.service.stopAll();
    await Promise.resolve();
    expect(agentResults(runner)).toEqual([]);
    await ctx.teammates.settle(0, 'completed', 'late result');
    await stopTask;
    expect(await ctx.service.status({ run_id: 'run-fenced-queue' }))
      .toMatchObject({ status: 'stopped' });
    expect(agentResults(runner)).toEqual([]);
  });

  it('captures a fast owned settle without routing an intermediate completion to the caller', async () => {
    const ctx = await context(['run-fast-settle']);
    ctx.teammates.autoSettle = { status: 'completed', result: 'fast result' };

    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'fast prompt',
      options: { label: 'fast' },
    });

    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: 'fast result' },
      ]),
    );
    expect(ctx.initiator.received).toHaveLength(0);

    const events = await journalEvents('run-fast-settle');
    expect(events.map((event) => event.kind)).toEqual([
      'run',
      'submit',
      'result',
    ]);
    expect(events[2]).toEqual({
      kind: 'result',
      index: 0,
      status: 'completed',
      settled_at: expect.any(Number),
    });
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('completed');
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'info',
      message: 'workflow agent settled',
    }));
  });

  it('accepts runner messages in IPC order before starting agents', async () => {
    const ctx = await context(['run-message-order']);
    const phaseWriteStarted = deferred<void>();
    const allowPhaseWrite = deferred<void>();
    const originalWrite = WorkflowRunStore.prototype.write;
    let blockPhase = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (blockPhase && record.phase === 'collect') {
          blockPhase = false;
          phaseWriteStarted.resolve();
          await allowPhaseWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({ type: 'emit', kind: 'phase', message: 'collect' });
    await phaseWriteStarted.promise;
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'phase-sensitive work',
      options: {},
    });
    await Promise.resolve();
    expect(ctx.teammates.spawns).toHaveLength(0);

    allowPhaseWrite.resolve();
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    expect(await ctx.service.status({ run_id: 'run-message-order' }))
      .toMatchObject({ agents: [{ phase: 'collect' }] });
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
  });

  it('passes outputSchema once and maps invalid structured output to null without retry', async () => {
    const ctx = await context(['run-schema']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    const schema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
    };
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema },
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    expect(ctx.teammates.spawns[0]?.options.outputSchema).toEqual(schema);
    await ctx.teammates.settle(0, 'completed', 'not valid JSON');
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );
    expect(ctx.teammates.spawns).toHaveLength(1);
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'workflow structured output was not valid JSON',
    }));

    runner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
  });

  it('returns a non-submitted agent as null and auto-closes it at terminal', async () => {
    const ctx = await context(['run-agent-failed']);
    ctx.teammates.nextTurnStatus = 'failed';
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'rejected prompt',
      options: {},
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );
    expect(ctx.teammates.releases).toEqual([]);

    runner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
  });

  it('leaves a non-submitted agent for the shutdown collection sweep', async () => {
    const ctx = await context(['run-agent-failed-shutdown']);
    ctx.teammates.nextTurnStatus = 'failed';
    const writeStarted = deferred<void>();
    const allowWrite = deferred<void>();
    const releaseGate = deferred<void>();
    ctx.teammates.releaseGate = releaseGate.promise;
    const originalWrite = WorkflowRunStore.prototype.write;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (record.agents[0]?.status === 'failed') {
          writeStarted.resolve();
          await allowWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'runtime rejects before shutdown',
      options: {},
    });
    await writeStarted.promise;

    const shutdown = ctx.service.stopAllForShutdown();
    allowWrite.resolve();
    await shutdown;
    const sweep = ctx.teammates.sweepAllOwned();
    await Promise.resolve();
    expect(ctx.teammates.releaseAttempts).toBe(1);

    releaseGate.resolve();
    await sweep;
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
  });

  it('returns a plain agent spawn failure as null', async () => {
    const ctx = await context(['run-agent-spawn-failed']);
    ctx.teammates.spawnError = new Error('runtime could not start');
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'plain prompt',
      options: {},
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );
    expect(ctx.teammates.spawnAttempts).toBe(1);

    runner.emit({ type: 'run_result', status: 'completed', result: [null] });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('completed');
  });

  it('sweeps ownership retained after failed spawn cleanup at run terminal', async () => {
    const ctx = await context(['run-owned-spawn-cleanup-failed']);
    ctx.teammates.spawnErrorAfterOwnership = new Error(
      'submission and immediate cleanup failed',
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'plain prompt',
      options: { label: 'residual-owner' },
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );
    expect(ctx.teammates.releases).toEqual([]);

    runner.emit({ type: 'run_result', status: 'completed', result: [null] });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));

    expect(ctx.teammates.releases).toEqual(['residual-owner']);
    expect(ctx.initiator.received[0]?.status).toBe('completed');
  });

  it('preserves a completed result when terminal cleanup fails', async () => {
    const ctx = await context(['run-cleanup-failed']);
    ctx.teammates.releaseAllError = new Error('owned cleanup failed');
    await ctx.service.run({ script: validScript() });

    ctx.runner.latest().emit({
      type: 'run_result',
      status: 'completed',
      result: { answer: 42 },
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));

    expect(ctx.initiator.received[0]?.status).toBe('completed');
    expect(JSON.parse(ctx.initiator.received[0]?.result ?? '')).toMatchObject({
      status: 'completed',
      result: { answer: 42 },
      error: 'owned cleanup failed',
    });
    expect(await ctx.service.status({ run_id: 'run-cleanup-failed' }))
      .toMatchObject({
        status: 'completed',
        result: { answer: 42 },
        error: 'owned cleanup failed',
      });
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'workflow terminal cleanup had failures',
    }));
  });

  it('locks the run failed before a persistence error can produce agent_result', async () => {
    const ctx = await context(['run-agent-persistence-failed'], (harness) => {
      harness.onSend = (message, runner) => {
        if (message.type === 'agent_result') {
          runner.emit({ type: 'run_result', status: 'completed', result: null });
        }
      };
    });
    const originalWrite = WorkflowRunStore.prototype.write;
    let failRunningWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (failRunningWrite && record.agents[0]?.status === 'running') {
          failRunningWrite = false;
          throw new Error('workflow state write failed');
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'must not escape failed persistence',
      options: {},
    });

    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(await ctx.service.status({ run_id: 'run-agent-persistence-failed' }))
      .toMatchObject({ status: 'failed' });
  });

  it('unwinds the settle route before journal-failure auto-close', async () => {
    const ctx = await context(['run-result-journal-failed']);
    const releaseGate = deferred<void>();
    ctx.teammates.releaseAllGate = releaseGate.promise;
    const originalAppend = WorkflowJournal.prototype.append;
    let failResultAppend = true;
    vi.spyOn(WorkflowJournal.prototype, 'append').mockImplementation(
      async function (this: WorkflowJournal, event) {
        if (failResultAppend && event.kind === 'result') {
          failResultAppend = false;
          throw new Error('result journal append failed');
        }
        await originalAppend.call(this, event);
      },
    );
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settle before cleanup',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    await ctx.teammates.settle(0, 'completed', 'done');
    releaseGate.resolve();

    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(await ctx.service.status({ run_id: 'run-result-journal-failed' }))
      .toMatchObject({ status: 'failed' });
  });

  it('propagates an unsupported outputSchema runtime as an agent error', async () => {
    const ctx = await context(['run-schema-unsupported']);
    ctx.teammates.nextTurnStatus = 'failed';
    const unsupported = Object.assign(
      new Error('claude-code runtime does not support per-turn outputSchema'),
      {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    );
    ctx.teammates.nextTurnError = unsupported;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema: { type: 'object' } },
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        {
          type: 'agent_result',
          index: 0,
          error: 'claude-code runtime does not support per-turn outputSchema',
        },
      ]),
    );
    expect(ctx.teammates.spawnAttempts).toBe(1);
    expect(ctx.teammates.spawns).toHaveLength(1);
    expect(ctx.teammates.releases).toEqual([]);

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'claude-code runtime does not support per-turn outputSchema',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
  });

  it('propagates an unsupported outputSchema error thrown by spawnOwned', async () => {
    const ctx = await context(['run-schema-throw']);
    const unsupported = Object.assign(
      new Error('claude-code runtime does not support per-turn outputSchema'),
      {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    );
    ctx.teammates.spawnError = unsupported;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema: { type: 'object' } },
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        {
          type: 'agent_result',
          index: 0,
          error: 'claude-code runtime does not support per-turn outputSchema',
        },
      ]),
    );
    expect(ctx.teammates.spawnAttempts).toBe(1);
    expect(ctx.teammates.spawns).toHaveLength(0);

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'claude-code runtime does not support per-turn outputSchema',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
  });

  it('maps an ordinary outputSchema turn failure to null', async () => {
    const ctx = await context(['run-schema-failed']);
    ctx.teammates.nextTurnStatus = 'failed';
    ctx.teammates.nextTurnError = new Error('structured turn failed');
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema: { type: 'object' } },
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );

    runner.emit({ type: 'run_result', status: 'completed', result: [null] });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('completed');
  });

  it('clamps concurrency to 1..8 and queues excess agent starts server-side', async () => {
    const ctx = await context(['run-lower-clamp', 'run-upper-clamp']);
    await ctx.service.run({ script: validScript(), max_concurrency: 0 });
    const firstRunner = ctx.runner.latest();
    expect(
      (await ctx.service.status({ run_id: 'run-lower-clamp' })).max_concurrency,
    ).toBe(1);

    firstRunner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'first',
      options: {},
    });
    firstRunner.emit({
      type: 'agent_start',
      index: 1,
      prompt: 'second',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    expect(ctx.teammates.spawns[0]?.input.prompt).toBe('first');

    await ctx.teammates.settle(0, 'completed', 'one');
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(2));
    expect(ctx.teammates.spawns[1]?.input.prompt).toBe('second');
    await ctx.teammates.settle(1, 'completed', 'two');
    firstRunner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() =>
      expect(ctx.initiator.received.some((item) => item.id === 'run-lower-clamp'))
        .toBe(true),
    );

    await ctx.service.run({ script: validScript(), max_concurrency: 99 });
    const secondRunner = ctx.runner.latest();
    expect(
      (await ctx.service.status({ run_id: 'run-upper-clamp' })).max_concurrency,
    ).toBe(8);
    secondRunner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() =>
      expect(ctx.initiator.received.some((item) => item.id === 'run-upper-clamp'))
        .toBe(true),
    );
  });

  it('returns stop after reserving the outcome and finalizes after natural settle', async () => {
    const ctx = await context(['run-stop'], (harness) => {
      harness.onSend = (message, runner) => {
        if (message.type === 'abort') {
          runner.emit({
            type: 'run_result',
            status: 'failed',
            error: 'workflow aborted',
          });
        }
      };
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'keep running naturally',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    await expect(ctx.service.stop({ run_id: 'run-stop' })).resolves.toEqual({
      run_id: 'run-stop',
      status: 'stopped',
    });
    await vi.waitFor(() =>
      expect(runner.sent.some((message) => message.type === 'abort')).toBe(true),
    );
    expect(ctx.teammates.releases).toEqual([]);
    expect(ctx.initiator.received).toHaveLength(0);

    await ctx.teammates.settle(0, 'completed', 'late result');
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(ctx.initiator.received).toHaveLength(1);
    expect(ctx.initiator.received[0]?.status).toBe('stopped');
    expect((await journalEvents('run-stop')).map((event) => event.kind)).toEqual([
      'run',
      'submit',
      'result',
      'end',
    ]);
    expect(await ctx.service.status({ run_id: 'run-stop' })).toMatchObject({
      status: 'stopped',
      agents: [{ status: 'completed' }],
    });
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('stops for shutdown without waiting for an in-flight turn or auto-close', async () => {
    const ctx = await context(['run-shutdown-stop']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'leave runtime cleanup to the shutdown sweep',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    await expect(ctx.service.stopAllForShutdown()).resolves.toBeUndefined();

    expect(runner.stopCount).toBeGreaterThan(0);
    expect(ctx.teammates.releases).toEqual([]);
    const terminal = await ctx.service.status({ run_id: 'run-shutdown-stop' });
    expect(terminal).toMatchObject({
      status: 'stopped',
      agents: [{ status: 'stopped' }],
    });
    expect(terminal.updated_at).toBe(terminal.ended_at);
    expect(activeRunCount(ctx.service)).toBe(0);
    expect(ctx.initiator.received).toEqual([]);
    expect((await journalEvents('run-shutdown-stop')).map((event) => event.kind))
      .toEqual(['run', 'submit', 'end']);

    await ctx.teammates.settle(0, 'stopped', null);
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.teammates.releases).toEqual([]);
    expect((await journalEvents('run-shutdown-stop')).map((event) => event.kind))
      .toEqual(['run', 'submit', 'end']);
    expect(await ctx.service.status({ run_id: 'run-shutdown-stop' }))
      .toEqual(terminal);
  });

  it('freezes completions before draining the latest shutdown mutation', async () => {
    const ctx = await context(['run-shutdown-mutation']);
    const writeStarted = deferred<void>();
    const allowWrite = deferred<void>();
    const originalWrite = WorkflowRunStore.prototype.write;
    let gateFirstResult = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (
          gateFirstResult &&
          record.agents[0]?.status === 'completed' &&
          record.agents[1]?.status === 'running'
        ) {
          gateFirstResult = false;
          writeStarted.resolve();
          await allowWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript(), max_concurrency: 2 });
    const runner = ctx.runner.latest();
    for (const index of [0, 1]) {
      runner.emit({
        type: 'agent_start',
        index,
        prompt: `agent ${index}`,
        options: {},
      });
    }
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(2));

    const firstSettle = ctx.teammates.settle(0, 'completed', 'first');
    await writeStarted.promise;
    const secondSettle = ctx.teammates.settle(1, 'completed', 'second');
    await vi.waitFor(async () =>
      expect((await ctx.service.status({ run_id: 'run-shutdown-mutation' }))
        .agents[1]?.status).toBe('completed'));
    const shutdown = ctx.service.stopAllForShutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    allowWrite.resolve();
    await Promise.all([firstSettle, secondSettle, shutdown]);
    expect((await journalEvents('run-shutdown-mutation')).map((event) =>
      event.kind)).toEqual([
      'run',
      'submit',
      'submit',
      'result',
      'result',
      'end',
    ]);
  });

  it('rejects a completion arriving after shutdown starts draining mutations', async () => {
    const ctx = await context(['run-shutdown-late-mutation']);
    const writeStarted = deferred<void>();
    const allowWrite = deferred<void>();
    const originalWrite = WorkflowRunStore.prototype.write;
    let gateFirstResult = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (
          gateFirstResult &&
          record.agents[0]?.status === 'completed' &&
          record.agents[1]?.status === 'running'
        ) {
          gateFirstResult = false;
          writeStarted.resolve();
          await allowWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript(), max_concurrency: 2 });
    const runner = ctx.runner.latest();
    for (const index of [0, 1]) {
      runner.emit({
        type: 'agent_start',
        index,
        prompt: `agent ${index}`,
        options: {},
      });
    }
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(2));

    const firstSettle = ctx.teammates.settle(0, 'completed', 'first');
    await writeStarted.promise;
    const shutdown = ctx.service.stopAllForShutdown();
    await vi.waitFor(() => expect(runner.stopCount).toBeGreaterThan(0));
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    const secondSettle = ctx.teammates.settle(1, 'completed', 'late');
    allowWrite.resolve();
    await Promise.all([firstSettle, secondSettle, shutdown]);

    expect((await journalEvents('run-shutdown-late-mutation')).map((event) =>
      event.kind)).toEqual(['run', 'submit', 'submit', 'result', 'end']);
    expect(await ctx.service.status({ run_id: 'run-shutdown-late-mutation' }))
      .toMatchObject({
        status: 'stopped',
        agents: [{ status: 'completed' }, { status: 'stopped' }],
      });
  });

  it('joins auto-close already running when shutdown begins', async () => {
    const ctx = await context(['run-shutdown-auto-close']);
    const releaseGate = deferred<void>();
    ctx.teammates.releaseAllGate = releaseGate.promise;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'complete before shutdown',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.teammates.releaseAllAttempts).toBe(1));

    const shutdown = ctx.service.stopAllForShutdown();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(ctx.teammates.releaseAllAttempts).toBe(1);

    releaseGate.resolve();
    await shutdown;
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(ctx.teammates.releases).toHaveLength(1);
    expect(await ctx.service.status({ run_id: 'run-shutdown-auto-close' }))
      .toMatchObject({ status: 'completed', result: 'done' });
  });

  it('fails on runner exit but still drains the owned turn before release', async () => {
    const ctx = await context(['run-crash']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'survive runner crash',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    runner.exit(7, null);
    await Promise.resolve();
    expect(ctx.initiator.received).toHaveLength(0);
    expect(ctx.teammates.releases).toEqual([]);

    await ctx.teammates.settle(0, 'completed', 'late result');
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-crash' })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(
        'workflow runner exited before reporting a result (code=7',
      ),
    });
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'info',
      fields: expect.objectContaining({ run_id: 'run-crash', code: 7 }),
      message: 'workflow runner exited',
    }));
  });

  it('recovers durable running records as stopped without starting a runner', async () => {
    const store = new WorkflowRunStore(SCOPE);
    const record = workflowRecord('run-recovery', {
      agents: [
        agentRecord(0, 'queued'),
        agentRecord(1, 'running'),
        agentRecord(2, 'completed'),
      ],
    });
    await store.create(record);
    await new WorkflowJournal(
      workflowRunJournalPath({ ...SCOPE, runId: record.run_id }),
    ).create({
      kind: 'run',
      version: 1,
      run_id: record.run_id,
      script_hash: record.script_hash,
      caller: { kind: 'dispatcher' },
      dispatcher_id: SCOPE.dispatcherId,
      team_id: null,
      created_at: record.created_at,
    });

    const ctx = await context(['unused-run-id'], undefined, false);
    await ctx.service.recover();
    expect(ctx.runner.runners).toHaveLength(0);
    await expect(ctx.service.run({ script: validScript() })).rejects.toThrow(
      /workflow admission is closed/,
    );
    expect(await ctx.service.status({ run_id: record.run_id })).toMatchObject({
      status: 'stopped',
      error: 'Dreamux stopped before the workflow reached a terminal result',
      agents: [
        { status: 'stopped' },
        { status: 'stopped' },
        { status: 'completed' },
      ],
    });
    expect((await journalEvents(record.run_id)).at(-1)).toMatchObject({
      kind: 'end',
      status: 'stopped',
    });
  });

  it('fails the run loudly when its real journal cannot append', async () => {
    await mkdir(
      workflowRunJournalPath({ ...SCOPE, runId: 'run-journal-failure' }),
      { recursive: true },
    );
    const ctx = await context(['run-journal-failure']);

    await expect(ctx.service.run({ script: validScript() })).rejects.toThrow(
      /workflow journal .* already exists/,
    );
    expect(ctx.initiator.received).toHaveLength(0);
    await expect(ctx.service.list()).resolves.toEqual({ runs: [] });
    expect(ctx.runner.runners).toHaveLength(1);
    expect(ctx.runner.latest().startCount).toBe(0);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('rejects run ids outside the lowercase alphanumeric-hyphen grammar', async () => {
    const ctx = await context(['Bad/../run']);

    await expect(ctx.service.run({ script: validScript() })).rejects.toThrow(
      'invalid workflow run id',
    );
    await expect(ctx.service.status({ run_id: '../escape' })).rejects.toThrow(
      'invalid workflow run id',
    );
    expect(ctx.runner.runners).toHaveLength(0);
    await expect(ctx.service.list()).resolves.toEqual({ runs: [] });
  });
});

function validScript(): string {
  return `
    export const meta = { name: 'test', description: 'test workflow' };
    export default async function run() { return null; }
  `;
}

function activeRunCount(service: WorkflowService): number {
  return (service as unknown as { runs: Map<string, unknown> }).runs.size;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function agentResults(
  runner: FakeWorkflowRunner,
): WorkflowRunnerParentMessage[] {
  return runner.sent.filter((message) => message.type === 'agent_result');
}

async function journalEvents(
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(
    workflowRunJournalPath({ ...SCOPE, runId }),
    'utf8',
  );
  return text.trim().split('\n').map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

function workflowRecord(
  runId: string,
  patch: Partial<WorkflowRunRecord> = {},
): WorkflowRunRecord {
  return {
    version: 1,
    run_id: runId,
    dispatcher_id: SCOPE.dispatcherId,
    team_id: null,
    caller_kind: 'dispatcher',
    script_hash: 'abc123',
    status: 'running',
    max_concurrency: 8,
    phase: null,
    last_log: null,
    agents: [],
    result: null,
    error: null,
    created_at: 100,
    updated_at: 100,
    ended_at: null,
    ...patch,
  };
}

function agentRecord(
  index: number,
  status: WorkflowRunRecord['agents'][number]['status'],
): WorkflowRunRecord['agents'][number] {
  return {
    index,
    name: `agent-${index}`,
    label: null,
    phase: null,
    turn_id: `turn-${index}`,
    status,
    created_at: 100,
    settled_at: status === 'completed' ? 110 : null,
  };
}

function teammateStatus(
  name: string,
  status: 'running' | 'closed',
): AgentEntityRuntimeStatus {
  return {
    name,
    session_id: `session-${name}`,
    agent_runtime: 'codex',
    repo: {
      mode: 'reuse-cwd',
      path: '/tmp/workflow-test',
      source_repo: null,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
    },
    intent: null,
    status,
    runtime_status: status === 'running' ? 'ready' : null,
    last_error: null,
    closed_at: status === 'closed' ? 1 : null,
    close_note: null,
  };
}

function captureLog(): CaptureLog {
  const events: CaptureLog['events'] = [];
  const method = (
    level: CaptureLog['events'][number]['level'],
  ) => (
    fieldsOrMessage: Record<string, unknown> | string,
    message?: string,
  ): void => {
    events.push({
      level,
      fields: typeof fieldsOrMessage === 'string' ? null : fieldsOrMessage,
      message: typeof fieldsOrMessage === 'string'
        ? fieldsOrMessage
        : message ?? null,
    });
  };
  return {
    events,
    logger: {
      error: method('error'),
      warn: method('warn'),
      info: method('info'),
      debug: method('debug'),
      trace: method('trace'),
    },
  };
}
