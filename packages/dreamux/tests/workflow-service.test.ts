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
import {
  WorkflowOwnerReleaseError,
  WorkflowStopInterruptedError,
} from '../src/service/workflow-service/run-terminal.js';
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
  spawnGate: Promise<void> | null = null;
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
    if (this.spawnGate !== null) await this.spawnGate;
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
    process.env['DREAMUX_ROOT'] = home;
  });

  afterEach(async () => {
    for (const teammates of teammateFakes) await teammates.settleAll();
    await Promise.allSettled(services.map((service) => service.stopAll()));
    services.length = 0;
    teammateFakes.length = 0;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function context(
    runIds: string[],
    configure?: (harness: RunnerHarness) => void,
    start = true,
    options: { stopGraceMs?: number; now?: () => number } = {},
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
      ...(options.stopGraceMs !== undefined
        ? { stopGraceMs: options.stopGraceMs }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
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

  it.each([
    ['object', { question: 'direct', nested: ['a', 2, true, null] }],
    ['array', [{ id: 1 }, 'two', false, null]],
    ['string', '{"question":"text"}'],
    ['number', 3.5],
    ['boolean', false],
    ['null', null],
  ])('passes explicit JSON %s args to the runner unchanged', async (_kind, args) => {
    const ctx = await context(['run-json-args']);

    await ctx.service.run({ script: validScript(), args });

    expect(ctx.runner.latest().sent[0]).toEqual({
      type: 'run_start',
      script: validScript(),
      args,
    });
  });

  it('passes omitted args as undefined without treating them as explicit input', async () => {
    const ctx = await context(['run-omitted-args']);

    await ctx.service.run({ script: validScript() });

    expect(ctx.runner.latest().sent[0]).toEqual({
      type: 'run_start',
      script: validScript(),
      args: undefined,
    });
  });

  it('rejects non-JSON args before durable run creation', async () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const sparse = new Array<unknown>(2);
    sparse[1] = 'present';
    const nonPlain = Object.create({ inherited: true }) as Record<string, unknown>;
    nonPlain['own'] = 'value';
    const symbolKeyed = { valid: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol('hidden')] = 'invalid';
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => 'invalid',
    });
    const arrayWithExtra = ['valid'] as unknown[] & { extra?: string };
    arrayWithExtra.extra = 'invalid';
    const ctx = await context([
      'run-json-args-must-not-be-consumed',
    ]);
    const cases: Array<[string, unknown]> = [
      ['explicit undefined', undefined],
      ['NaN', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
      ['function', () => undefined],
      ['symbol', Symbol('invalid')],
      ['bigint', BigInt(1)],
      ['cycle', cycle],
      ['sparse array', sparse],
      ['array with undefined', [undefined]],
      ['non-plain object', nonPlain],
      ['date', new Date(0)],
      ['symbol-keyed object', symbolKeyed],
      ['accessor object', accessor],
      ['array with extra property', arrayWithExtra],
    ];

    for (const [_label, args] of cases) {
      await expect(ctx.service.run({
        script: validScript(),
        args,
      })).rejects.toThrow(/^workflow args at /);
    }
    expect(ctx.runner.runners).toHaveLength(0);
    await expect(ctx.service.list()).resolves.toEqual({ runs: [] });
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

  it('passes outputSchema and workflow role guidance once, then fails invalid successful JSON', async () => {
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
    expect(ctx.teammates.spawns[0]?.options.systemPromptAppend).toEqual([
      'You are executing one agent call inside a Dreamux workflow. Your final ' +
        'response is the return value consumed by the workflow, not a human-facing ' +
        'progress message. Return only the requested value. When an output schema is ' +
        "provided, use the runtime's structured-output mechanism and satisfy the " +
        'schema exactly.',
    ]);
    await ctx.teammates.settle(0, 'completed', 'not valid JSON');
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        {
          type: 'agent_result',
          index: 0,
          error:
            'runtime reported successful structured output that was not valid JSON',
        },
      ]),
    );
    expect(ctx.teammates.spawns).toHaveLength(1);
    expect(await ctx.service.status({ run_id: 'run-schema' })).toMatchObject({
      agents: [{ status: 'failed' }],
    });
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'workflow structured output was not valid JSON',
    }));

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error:
        'runtime reported successful structured output that was not valid JSON',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
  });

  it('fails an empty successful structured result with an accurate runner error', async () => {
    const ctx = await context(['run-schema-empty']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema: { type: 'object' } },
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', null);

    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        {
          type: 'agent_result',
          index: 0,
          error: 'runtime reported successful structured output that was empty',
        },
      ]),
    );
    expect(await ctx.service.status({ run_id: 'run-schema-empty' }))
      .toMatchObject({ agents: [{ status: 'failed' }] });
    expect(ctx.log.events).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'workflow structured output was empty',
    }));

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'runtime reported successful structured output that was empty',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
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

  it('rejects a natural terminal attempt whose owner release fails and stays retryable', async () => {
    const ctx = await context(['run-natural-release-failed']);
    ctx.teammates.releaseAllError = new Error('owned cleanup failed');
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'release will fail',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');

    ctx.runner.latest().emit({
      type: 'run_result',
      status: 'completed',
      result: { answer: 42 },
    });
    // The natural attempt rejects pre-terminal: no delivery, no end journal,
    // no terminal record, no eviction; durable status stays running.
    await vi.waitFor(() => expect(ctx.log.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        message: 'workflow terminal transition failed; run remains retryable',
      }),
    ])));
    expect(ctx.initiator.received).toHaveLength(0);
    expect(await ctx.service.status({ run_id: 'run-natural-release-failed' }))
      .toMatchObject({ status: 'running', result: null, ended_at: null });
    expect((await journalEvents('run-natural-release-failed')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'result']);
    expect(activeRunCount(ctx.service)).toBe(1);

    // A later stop retries the original intended status after release recovers.
    ctx.teammates.releaseAllError = null;
    await expect(ctx.service.stop({ run_id: 'run-natural-release-failed' }))
      .resolves.toEqual({ run_id: 'run-natural-release-failed', status: 'completed' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('completed');
    expect(JSON.parse(ctx.initiator.received[0]?.result ?? '')).toMatchObject({
      status: 'completed',
      result: { answer: 42 },
    });
    expect((await journalEvents('run-natural-release-failed')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'result', 'end']);
    expect(activeRunCount(ctx.service)).toBe(0);
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

  it('defaults concurrency, rejects invalid values, and queues excess agent starts server-side', async () => {
    const ctx = await context([
      'run-default-concurrency',
      'run-queued-concurrency',
    ]);
    await ctx.service.run({ script: validScript() });
    const defaultRunner = ctx.runner.latest();
    expect(
      (await ctx.service.status({ run_id: 'run-default-concurrency' }))
        .max_concurrency,
    ).toBe(16);
    defaultRunner.emit({
      type: 'run_result',
      status: 'completed',
      result: null,
    });
    await vi.waitFor(() =>
      expect(ctx.initiator.received.some(
        (item) => item.id === 'run-default-concurrency',
      )).toBe(true),
    );

    for (const maxConcurrency of [0, 17, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(ctx.service.run({
        script: validScript(),
        max_concurrency: maxConcurrency,
      })).rejects.toThrow(
        'workflow max_concurrency must be an integer between 1 and 16',
      );
    }
    expect(ctx.runner.runners).toHaveLength(1);

    await ctx.service.run({ script: validScript(), max_concurrency: 1 });
    const firstRunner = ctx.runner.latest();
    expect(
      (await ctx.service.status({ run_id: 'run-queued-concurrency' }))
        .max_concurrency,
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
      expect(ctx.initiator.received.some(
        (item) => item.id === 'run-queued-concurrency',
      ))
        .toBe(true),
    );
  });

  it('accepts 1000 lifetime agent calls and rejects call 1001 before spawn', async () => {
    const ctx = await context(['run-agent-limit']);
    ctx.teammates.nextTurnStatus = 'failed';
    await ctx.service.run({ script: validScript(), max_concurrency: 16 });
    const runner = ctx.runner.latest();

    for (let index = 0; index < 1001; index += 1) {
      runner.emit({
        type: 'agent_start',
        index,
        prompt: `agent ${index}`,
        options: {},
      });
    }

    await vi.waitFor(() => expect(ctx.teammates.spawnAttempts).toBe(1000), {
      timeout: 10_000,
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toContainEqual({
        type: 'agent_result',
        index: 1000,
        error: 'workflow agent lifecycle limit of 1000 exceeded',
      }), { timeout: 10_000 });
    expect(ctx.teammates.spawnAttempts).toBe(1000);

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'workflow agent lifecycle limit of 1000 exceeded',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
  }, 20_000);

  it('returns stopped only after a submitted call settled inside the grace window and every terminal barrier agrees', async () => {
    const ctx = await context(
      ['run-stop'],
      (harness) => {
        harness.onSend = (message, runner) => {
          if (message.type === 'abort') {
            runner.emit({
              type: 'run_result',
              status: 'failed',
              error: 'workflow aborted',
            });
          }
        };
      },
      true,
      { stopGraceMs: 500 },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settle inside the grace window',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    let stopSettled = false;
    const stopTask = ctx.service.stop({ run_id: 'run-stop' }).then((result) => {
      stopSettled = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(runner.sent.some((message) => message.type === 'abort')).toBe(true),
    );
    expect(stopSettled).toBe(false);
    expect(ctx.teammates.releases).toEqual([]);

    await ctx.teammates.settle(0, 'completed', 'grace result');
    // The stop returns only after release, the durable record and end journal,
    // terminal routing, and eviction all agree.
    await expect(stopTask).resolves.toEqual({ run_id: 'run-stop', status: 'stopped' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
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
    expect(await ctx.service.list()).toMatchObject({
      runs: [{ run_id: 'run-stop', status: 'stopped' }],
    });
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('stops a queued call without spawning and a never-settling submitted call after the grace window', async () => {
    const ctx = await context(['run-stop-queued'], undefined, true, {
      stopGraceMs: 100,
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

    await expect(ctx.service.stop({ run_id: 'run-stop-queued' })).resolves
      .toEqual({ run_id: 'run-stop-queued', status: 'stopped' });
    // The queued call never spawned; the submitted call was owner-cancelled
    // after the grace window and normalized to a durable stopped result.
    expect(ctx.teammates.spawnAttempts).toBe(1);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-stop-queued' })).toMatchObject({
      status: 'stopped',
      agents: [{ status: 'stopped' }, { status: 'stopped' }],
    });
    expect((await journalEvents('run-stop-queued')).map((event) => event.kind))
      .toEqual(['run', 'submit', 'result', 'result', 'end']);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('never lets an in-flight owned spawn publish after the release snapshot', async () => {
    const ctx = await context(['run-pre-spawn-stop'], undefined, true, {
      stopGraceMs: 100,
    });
    const spawnGate = deferred<void>();
    ctx.teammates.spawnGate = spawnGate.promise;
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'spawn is mid-flight',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawnAttempts).toBe(1));

    let stopSettled = false;
    const stopTask = ctx.service.stop({ run_id: 'run-pre-spawn-stop' }).then(
      () => {
        stopSettled = true;
      },
    );
    // The publication cutoff waits for the in-flight spawn boundary instead of
    // deadlocking or racing ahead of it.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(ctx.teammates.spawns).toHaveLength(0);
    expect(ctx.teammates.releaseAllAttempts).toBe(0);

    spawnGate.resolve();
    await expect(stopTask).resolves.toBeUndefined();
    // The spawn published before the release snapshot and was released.
    expect(ctx.teammates.spawns).toHaveLength(1);
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-pre-spawn-stop' }))
      .toMatchObject({ status: 'stopped', agents: [{ status: 'stopped' }] });
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('joins concurrent stops into one finalization without resetting the deadline', async () => {
    const ctx = await context(['run-concurrent-stop'], undefined, true, {
      stopGraceMs: 100,
    });
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    const first = ctx.service.stop({ run_id: 'run-concurrent-stop' });
    const second = ctx.service.stop({ run_id: 'run-concurrent-stop' });
    await expect(first).resolves.toEqual({ run_id: 'run-concurrent-stop', status: 'stopped' });
    await expect(second).resolves.toEqual({ run_id: 'run-concurrent-stop', status: 'stopped' });
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(ctx.runner.latest().sent.filter((message) => message.type === 'abort'))
      .toHaveLength(1);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('keeps the first stop intent deadline across a failed release retry', async () => {
    let now = 1_000;
    const ctx = await context(['run-stop-retry-deadline'], undefined, true, {
      stopGraceMs: 100,
      now: () => now,
    });
    ctx.teammates.releaseAllError = new Error('release fails once');
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    await expect(ctx.service.stop({ run_id: 'run-stop-retry-deadline' }))
      .rejects.toBeInstanceOf(WorkflowOwnerReleaseError);
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(await ctx.service.status({ run_id: 'run-stop-retry-deadline' }))
      .toMatchObject({ status: 'running' });
    expect(activeRunCount(ctx.service)).toBe(1);
    expect((await journalEvents('run-stop-retry-deadline')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit']);

    // The original deadline (1000 + 100) is long past: the retry must release
    // immediately without scheduling a new grace sleep.
    now = 2_000;
    ctx.teammates.releaseAllError = null;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await expect(ctx.service.stop({ run_id: 'run-stop-retry-deadline' }))
      .resolves.toEqual({ run_id: 'run-stop-retry-deadline', status: 'stopped' });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    expect(ctx.teammates.releaseAllAttempts).toBe(2);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-stop-retry-deadline' }))
      .toMatchObject({ status: 'stopped' });
  });

  it('lets a stop join an in-flight natural terminal attempt without overwriting its status', async () => {
    const ctx = await context(['run-stop-joins-natural'], undefined, true, {
      stopGraceMs: 100,
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settles naturally',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    runner.emit({ type: 'run_result', status: 'completed', result: 'natural' });
    await vi.waitFor(() => expect(ctx.teammates.releaseAllAttempts).toBe(0));
    // The natural attempt is waiting for the turn; the stop joins it.
    await ctx.teammates.settle(0, 'completed', 'natural result');
    await expect(ctx.service.stop({ run_id: 'run-stop-joins-natural' }))
      .resolves.toEqual({ run_id: 'run-stop-joins-natural', status: 'completed' });
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(await ctx.service.status({ run_id: 'run-stop-joins-natural' }))
      .toMatchObject({
        status: 'completed',
        result: 'natural',
        agents: [{ status: 'completed' }],
      });
    expect((await journalEvents('run-stop-joins-natural')).map((event) =>
      event.kind)).toEqual(['run', 'submit', 'result', 'end']);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('binds a joined natural attempt to the stop deadline when its turn never settles', async () => {
    const ctx = await context(['run-stop-joins-stuck'], undefined, true, {
      stopGraceMs: 100,
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    runner.emit({ type: 'run_result', status: 'completed', result: 'natural' });

    // The natural attempt is draining an unbounded turn; the joined stop
    // records the immutable deadline and bounds that drain.
    await expect(ctx.service.stop({ run_id: 'run-stop-joins-stuck' }))
      .resolves.toEqual({ run_id: 'run-stop-joins-stuck', status: 'completed' });
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-stop-joins-stuck' }))
      .toMatchObject({
        status: 'completed',
        result: 'natural',
        agents: [{ status: 'stopped' }],
      });
    expect((await journalEvents('run-stop-joins-stuck')).map((event) =>
      event.kind)).toEqual(['run', 'submit', 'result', 'end']);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('rejects a stop whose owner release fails without any false terminal fact', async () => {
    const ctx = await context(['run-stop-release-failed'], undefined, true, {
      stopGraceMs: 100,
    });
    ctx.teammates.releaseAllError = new Error('owned release failed');
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    await expect(ctx.service.stop({ run_id: 'run-stop-release-failed' }))
      .rejects.toBeInstanceOf(WorkflowOwnerReleaseError);
    // No end journal, terminal record, delivery, or eviction; the durable
    // record stays running with closed run admission.
    expect(ctx.initiator.received).toHaveLength(0);
    expect(await ctx.service.status({ run_id: 'run-stop-release-failed' }))
      .toMatchObject({ status: 'running', ended_at: null });
    expect((await journalEvents('run-stop-release-failed')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit']);
    expect(activeRunCount(ctx.service)).toBe(1);
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 1,
      prompt: 'must be rejected',
      options: {},
    });
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    expect(ctx.teammates.spawnAttempts).toBe(1);
    expect(ctx.teammates.spawns).toHaveLength(1);

    ctx.teammates.releaseAllError = null;
    await expect(ctx.service.stop({ run_id: 'run-stop-release-failed' }))
      .resolves.toEqual({ run_id: 'run-stop-release-failed', status: 'stopped' });
    expect(await ctx.service.status({ run_id: 'run-stop-release-failed' }))
      .toMatchObject({
        status: 'stopped',
        agents: [{ index: 0, status: 'stopped' }],
      });
    expect(activeRunCount(ctx.service)).toBe(0);
    expect((await journalEvents('run-stop-release-failed')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'result', 'end']);
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

  it('interrupts a public stop inside the grace window when shutdown is broadcast', async () => {
    const ctx = await context(['run-stop-shutdown-interrupt'], undefined, true, {
      stopGraceMs: 5_000,
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'grace interrupted by shutdown',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    const stopTask = ctx.service.stop({ run_id: 'run-stop-shutdown-interrupt' });
    await vi.waitFor(() =>
      expect(runner.sent.some((message) => message.type === 'abort')).toBe(true),
    );
    ctx.service.interruptForShutdown();
    await expect(stopTask).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // Shutdown freezes unresolved calls and persists the stopped record, but
    // leaves the not-yet-started release to the collection-wide sweep.
    expect(ctx.teammates.releaseAllAttempts).toBe(0);
    expect(ctx.teammates.releases).toEqual([]);
    expect(await ctx.service.status({ run_id: 'run-stop-shutdown-interrupt' }))
      .toMatchObject({ status: 'stopped', agents: [{ status: 'stopped' }] });
    expect((await journalEvents('run-stop-shutdown-interrupt')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'end']);
    expect(ctx.initiator.received).toHaveLength(0);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('joins a release already in progress when shutdown is broadcast during it', async () => {
    const ctx = await context(['run-stop-shutdown-joined'], undefined, true, {
      stopGraceMs: 50,
    });
    const releaseGate = deferred<void>();
    ctx.teammates.releaseAllGate = releaseGate.promise;
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    const stopTask = ctx.service.stop({ run_id: 'run-stop-shutdown-joined' });
    await vi.waitFor(() => expect(ctx.teammates.releaseAllAttempts).toBe(1));
    // The release already started; the broadcast joins it under the current
    // runtime contract instead of cancelling it.
    ctx.service.interruptForShutdown();
    releaseGate.resolve();
    await expect(stopTask).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-stop-shutdown-joined' }))
      .toMatchObject({ status: 'stopped', agents: [{ status: 'stopped' }] });
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('lets the shutdown sweep resolve a stop that previously failed pre-terminal', async () => {
    const ctx = await context(['run-stop-sweep-after-failure'], undefined, true, {
      stopGraceMs: 50,
    });
    ctx.teammates.releaseAllError = new Error('owned release failed');
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await expect(ctx.service.stop({ run_id: 'run-stop-sweep-after-failure' }))
      .rejects.toBeInstanceOf(WorkflowOwnerReleaseError);

    // The shutdown sweep must resolve without rejecting and without attempting
    // a per-run release that failed pre-terminal (the collection-wide sweep
    // owns that cleanup).
    await expect(ctx.service.stopAllForShutdown()).resolves.toBeUndefined();
    expect(await ctx.service.status({ run_id: 'run-stop-sweep-after-failure' }))
      .toMatchObject({ status: 'stopped', agents: [{ status: 'stopped' }] });
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('rolls back a failed first write inside the mutation tail so a later queued write cannot persist it', async () => {
    const ctx = await context(['run-agent-rollback-in-tail'], undefined, true, {
      stopGraceMs: 100,
    });
    const cWriteStarted = deferred<void>();
    const allowCWrite = deferred<void>();
    const bRunningWriteStarted = deferred<void>();
    const allowBRunningWrite = deferred<void>();
    const sendGate = deferred<void>();
    const aResultPersisted = deferred<void>();
    let failCWrite = true;
    let writeCalls = 0;
    const snapshotsSeen: number[][] = [];
    const originalWrite = WorkflowRunStore.prototype.write;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        writeCalls += 1;
        if (record.agents[0]?.status === 'completed') {
          aResultPersisted.resolve();
        }
        if (failCWrite && record.agents.length === 3) {
          failCWrite = false;
          cWriteStarted.resolve();
          await allowCWrite.promise;
          throw new Error('workflow state write failed');
        }
        // Snapshot every record the store is asked to write, before any gate.
        snapshotsSeen.push(record.agents.map((agent) => agent.index));
        // Writes 1-6: agent 0's queued/running/submit writes, agent 1's
        // publish write, agent 0's result write, and C's failing write. The
        // 7th is agent 1's direct running-state write — the mutation queued
        // behind C's write while agent 0 still held the semaphore slot.
        if (writeCalls === 7) {
          bRunningWriteStarted.resolve();
          await allowBRunningWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript(), max_concurrency: 1 });
    const runner = ctx.runner.latest();
    const originalSend = runner.send.bind(runner);
    vi.spyOn(runner, 'send').mockImplementation(async (message) => {
      // Agent 0's completion persists its result, then blocks on the runner
      // delivery so it still holds the semaphore slot.
      if (message.type === 'agent_result') await sendGate.promise;
      return originalSend(message);
    });
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'holds the slot',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    runner.emit({
      type: 'agent_start',
      index: 1,
      prompt: 'queued behind',
      options: {},
    });
    const settleTask = ctx.teammates.settle(0, 'completed', 'done');
    await aResultPersisted.promise;
    runner.emit({
      type: 'agent_start',
      index: 2,
      prompt: 'first write fails',
      options: {},
    });
    await cWriteStarted.promise;
    // Unblock agent 0's delivery: it releases the semaphore, agent 1 sets
    // running and queues its direct running-state store behind C's write.
    sendGate.resolve();
    await settleTask;
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    allowCWrite.resolve();
    await bRunningWriteStarted.promise;

    // The rollback is atomic with C's first write: agent 1's direct write —
    // the first mutation the tail admits after the rejection — must never
    // snapshot the not-yet-durable C.
    expect(snapshotsSeen.some((seen) => seen.includes(2))).toBe(false);
    allowBRunningWrite.resolve();
    await vi.waitFor(() => expect(activeRunCount(ctx.service)).toBe(0));
    expect((await new WorkflowRunStore(SCOPE).get('run-agent-rollback-in-tail'))
      ?.agents.map((agent) => agent.index)).toEqual([0, 1]);
  });

  it('never durably persists an agent whose first write fails, even when an earlier queued write runs after it was appended', async () => {
    const ctx = await context(['run-agent-phantom'], undefined, true, {
      stopGraceMs: 100,
    });
    const submitWriteStarted = deferred<void>();
    const allowSubmitWrite = deferred<void>();
    let gateSubmitWrite = true;
    let writeCalls = 0;
    const originalWrite = WorkflowRunStore.prototype.write;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        writeCalls += 1;
        if (gateSubmitWrite && record.agents[0]?.name !== null) {
          // Agent 0's submit write is the earlier queued mutation, gated
          // before its store snapshot.
          gateSubmitWrite = false;
          submitWriteStarted.resolve();
          await allowSubmitWrite.promise;
        }
        // Agent 1's own first store is the fourth write; fail exactly it so
        // the earlier gated submit write (without the fix) has already
        // persisted a durable phantom entry that in-memory rollback cannot
        // undo, and no later write follows while the natural attempt hangs.
        if (writeCalls === 4) {
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
      prompt: 'submitted first',
      options: {},
    });
    await submitWriteStarted.promise;
    runner.emit({
      type: 'agent_start',
      index: 1,
      prompt: 'phantom candidate',
      options: {},
    });
    allowSubmitWrite.resolve();
    await vi.waitFor(() => expect(writeCalls).toBeGreaterThanOrEqual(4));
    // The natural failed attempt now hangs draining the never-settling turn,
    // so the record read below is the final durable state.
    for (let step = 0; step < 4; step += 1) await Promise.resolve();

    const durable = await new WorkflowRunStore(SCOPE).get('run-agent-phantom');
    expect(durable?.agents.map((agent) => agent.index)).toEqual([0]);
    expect(ctx.teammates.releaseAllAttempts).toBe(0);
    expect(activeRunCount(ctx.service)).toBe(1);
  });

  it('returns the real terminal status for a run that completed before the shutdown broadcast', async () => {
    const ctx = await context(['run-stop-before-broadcast'], undefined, true, {
      stopGraceMs: 500,
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settles fast',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    // The full terminal commit (release, end, routing, eviction) completed
    // before the broadcast: the barrier was truthfully proven.
    await vi.waitFor(() => expect(activeRunCount(ctx.service)).toBe(0));
    expect(ctx.teammates.releases).toHaveLength(1);
    expect(ctx.initiator.received).toHaveLength(1);

    ctx.service.interruptForShutdown();
    await expect(ctx.service.stop({ run_id: 'run-stop-before-broadcast' }))
      .resolves.toEqual({ run_id: 'run-stop-before-broadcast', status: 'completed' });
  });

  it('rejects a public stop that cannot attach to a live finalization after the shutdown broadcast', async () => {
    const ctx = await context(['run-stop-after-takeover'], undefined, true, {
      stopGraceMs: 5_000,
    });
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));

    const first = ctx.service.stop({ run_id: 'run-stop-after-takeover' });
    await vi.waitFor(() =>
      expect(runner.sent.some((message) => message.type === 'abort')).toBe(true),
    );
    ctx.service.interruptForShutdown();
    await expect(first).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    expect(activeRunCount(ctx.service)).toBe(0);

    // A delayed public stop reads only the frozen durable record; it cannot
    // prove the release barrier, so it must reject instead of reporting
    // stopped before the collection-wide sweep releases the owner.
    await expect(ctx.service.stop({ run_id: 'run-stop-after-takeover' }))
      .rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // Internal shutdown/sweep paths and reads are unaffected.
    await expect(ctx.service.stopAllForShutdown()).resolves.toBeUndefined();
    expect(await ctx.service.status({ run_id: 'run-stop-after-takeover' }))
      .toMatchObject({ status: 'stopped' });
  });

  it('does not invisibly auto-retry a natural terminal whose owner release failed', async () => {
    const ctx = await context(['run-natural-release-once'], undefined, true, {
      stopGraceMs: 100,
    });
    ctx.teammates.releaseAllError = new Error('owned release failed');
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'natural' });

    // Exactly one finalization attempt: the release failure stays loud and
    // pre-terminal instead of re-observing the same terminal message.
    await vi.waitFor(() => expect(ctx.teammates.releaseAllAttempts).toBe(1));
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    expect(ctx.teammates.releaseAllAttempts).toBe(1);
    expect(runner.stopCount).toBe(1);
    expect(await ctx.service.status({ run_id: 'run-natural-release-once' }))
      .toMatchObject({ status: 'running', ended_at: null });
    expect((await journalEvents('run-natural-release-once')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'result']);
    expect(activeRunCount(ctx.service)).toBe(1);
    expect(ctx.initiator.received).toHaveLength(0);

    // An explicit stop retries against the original deadline.
    ctx.teammates.releaseAllError = null;
    await expect(ctx.service.stop({ run_id: 'run-natural-release-once' }))
      .resolves.toEqual({ run_id: 'run-natural-release-once', status: 'completed' });
    expect(ctx.teammates.releaseAllAttempts).toBe(2);
    expect(runner.stopCount).toBe(2);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('rolls back an agent whose first durable write fails so terminal stop never waits on orphan gates', async () => {
    const ctx = await context(['run-agent-first-write-failed'], undefined, true, {
      stopGraceMs: 100,
    });
    const originalWrite = WorkflowRunStore.prototype.write;
    let failAgentWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (failAgentWrite && record.agents.length === 2) {
          failAgentWrite = false;
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
      prompt: 'submitted first',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    runner.emit({
      type: 'agent_start',
      index: 1,
      prompt: 'first durable write fails',
      options: {},
    });
    await vi.waitFor(() => expect(failAgentWrite).toBe(false));

    // The rolled-back call must not strand the publication cutoff: the joined
    // stop bounds the remaining grace and terminalizes without hanging.
    await expect(ctx.service.stop({ run_id: 'run-agent-first-write-failed' }))
      .resolves.toEqual({ run_id: 'run-agent-first-write-failed', status: 'failed' });
    expect(ctx.teammates.spawnAttempts).toBe(1);
    expect(ctx.teammates.releases).toEqual([
      ctx.teammates.spawns[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-agent-first-write-failed' }))
      .toMatchObject({
        status: 'failed',
        error: 'workflow state write failed',
        agents: [{ index: 0, status: 'stopped' }],
      });
    expect((await journalEvents('run-agent-first-write-failed')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit', 'result', 'end']);
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('resolves a routing-detached takeover once the detached settle reaches its terminal outcome', async () => {
    const ctx = await context(['run-routing-resolve'], undefined, true, {
      stopGraceMs: 500,
    });
    const allowDelivery = deferred<void>();
    ctx.initiator.deliveryGate = allowDelivery.promise;
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'run_result',
      status: 'completed',
      result: 'done',
    });
    // Terminal routing started: the delivery is in flight.
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    ctx.service.interruptForShutdown();
    await vi.waitFor(() => expect(activeRunCount(ctx.service)).toBe(0));
    // The successful owner sweep resolves only frozen takeovers; the
    // routing-detached tombstone still rejects while the settle is unproven.
    ctx.service.clearShutdownTakeovers();
    await expect(ctx.service.stop({ run_id: 'run-routing-resolve' }))
      .rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // The router contract guarantees settle() reaches a terminal outcome;
    // once it does, the routing barrier is proven and the idempotent stop
    // returns the durable terminal status.
    allowDelivery.resolve();
    await vi.waitFor(async () => {
      await expect(ctx.service.stop({ run_id: 'run-routing-resolve' }))
        .resolves.toEqual({ run_id: 'run-routing-resolve', status: 'completed' });
    });
  });

  it('marks a delivery-interrupted public stop as shutdown takeover', async () => {
    const ctx = await context(['run-delivery-shutdown'], undefined, true, {
      stopGraceMs: 500,
    });
    const allowDelivery = deferred<void>();
    ctx.initiator.deliveryGate = allowDelivery.promise;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settles before delivery',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    // The finalization committed the durable record and is blocked at the
    // terminal routing gate.
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(await ctx.service.status({ run_id: 'run-delivery-shutdown' }))
        .toMatchObject({ status: 'completed', result: 'done' }));

    const stopTask = ctx.service.stop({ run_id: 'run-delivery-shutdown' });
    ctx.service.interruptForShutdown();
    await expect(stopTask).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    allowDelivery.resolve();
    await vi.waitFor(() => expect(activeRunCount(ctx.service)).toBe(0));
  });

  it('still resolves internal shutdown while terminal delivery is pending', async () => {
    const ctx = await context(['run-delivery-shutdown-internal'], undefined, true, {
      stopGraceMs: 500,
    });
    const allowDelivery = deferred<void>();
    ctx.initiator.deliveryGate = allowDelivery.promise;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settles before delivery',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));

    const shutdown = ctx.service.stopAllForShutdown();
    allowDelivery.resolve();
    await expect(shutdown).resolves.toBeUndefined();
    expect(await ctx.service.status({ run_id: 'run-delivery-shutdown-internal' }))
      .toMatchObject({ status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(activeRunCount(ctx.service)).toBe(0));
  });

  it('keeps a latched journal persistence failure loud through the shutdown sweep', async () => {
    const ctx = await context(['run-stop-latched-journal'], undefined, true, {
      stopGraceMs: 50,
    });
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'never settles',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.spawns).toHaveLength(1));
    const originalAppend = WorkflowJournal.prototype.append;
    let failClaimResult = true;
    vi.spyOn(WorkflowJournal.prototype, 'append').mockImplementation(
      async function (this: WorkflowJournal, event) {
        if (failClaimResult && event.kind === 'result') {
          failClaimResult = false;
          throw new Error('result journal append failed');
        }
        await originalAppend.call(this, event);
      },
    );

    // The claim's forced-result append fails: the stop rejects pre-terminal,
    // and the latched journal means no in-process retry promise — never a
    // false terminal fact.
    await expect(ctx.service.stop({ run_id: 'run-stop-latched-journal' }))
      .rejects.toThrow(/result journal append failed/);
    expect(await ctx.service.status({ run_id: 'run-stop-latched-journal' }))
      .toMatchObject({ status: 'running', ended_at: null });
    // The shutdown sweep stays fail-loud instead of persisting the latched
    // journal's false terminal state.
    await expect(ctx.service.stopAllForShutdown()).rejects.toThrow(
      /result journal append failed/,
    );
    expect(await ctx.service.status({ run_id: 'run-stop-latched-journal' }))
      .toMatchObject({ status: 'running', ended_at: null });
    expect((await journalEvents('run-stop-latched-journal')).map(
      (event) => event.kind,
    )).toEqual(['run', 'submit']);
    expect(activeRunCount(ctx.service)).toBe(1);
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
    return null;
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
    max_concurrency: 16,
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
