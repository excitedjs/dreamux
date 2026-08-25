import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DreamuxLogger,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

import {
  workflowRunJournalPath,
  workflowRunRecordPath,
  type WorkflowScopePathInput,
} from '../src/platform/paths.js';
import {
  CompletionDeliveryPolicy,
  type CompletionInitiator,
  type PreparedCompletionDelivery,
  type PreparedCompletionFact,
} from '../src/service/completion-router/index.js';
import type {
  WorkflowTeammateFactory,
} from '../src/service/workflow-service/index.js';
import type {
  CreateLockedTeammateOptions,
} from '../src/service/teammate-collection/index.js';
import type { LockedTeammate } from '../src/service/teammate-service/types.js';
import type {
  Turn,
  TurnAdmission,
  TurnOutcome,
} from '../src/service/teammate-service/turn-recording.js';
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
import {
  completedCompletion,
  controllableRuntimeSubmission,
  failedCompletion,
  type ControllableRuntimeSubmission,
} from './helpers/runtime-submission.js';

const SCOPE: WorkflowScopePathInput = {
  dispatcherId: 'dispatcher-workflow-test',
  teamId: null,
};

type MaterializationInput = Parameters<WorkflowTeammateFactory['createLocked']>[0];

interface FakeMaterialization {
  input: MaterializationInput;
  options: CreateLockedTeammateOptions;
  name: string;
  submitCalls: number;
  closeCalls: number;
  unlockCalls: number;
  closed: boolean;
  unlocked: boolean;
  runtimeTurn: ControllableRuntimeSubmission | null;
  runtimeTurnReady: ReturnType<typeof deferred<void>>;
}

/**
 * The fake TeammateFactory stands in for the whole TeamMate layer, so it owns
 * the same seam `EntityTurn` owns in production: a provider settlement is
 * translated into the Turn-level outcome the WorkflowService consumes.
 * `completed`/`failed` are real native result boundaries and therefore carry a
 * completion token; `stopped` never produces one.
 */
function toSettlement(
  submission: RuntimeSubmission,
  outcome: TurnOutcome,
): RuntimeSubmissionSettlement {
  switch (outcome.status) {
    case 'completed':
      return {
        kind: 'completion',
        completion: completedCompletion(
          submission,
          outcome.resultText,
          outcome.truncated,
        ),
      };
    case 'failed':
      return {
        kind: 'completion',
        completion: failedCompletion(submission, outcome.error),
      };
    case 'stopped':
      return { kind: 'stopped' };
  }
}

function toTurnOutcome(settlement: RuntimeSubmissionSettlement): TurnOutcome {
  if (settlement.kind === 'completion') {
    return settlement.completion.status === 'completed'
      ? {
          status: 'completed',
          resultText: settlement.completion.resultText,
          truncated: settlement.completion.truncated,
        }
      : { status: 'failed', error: settlement.completion.error };
  }
  return settlement.kind === 'failed'
    ? { status: 'failed', error: settlement.error }
    : { status: 'stopped' };
}

class FakeLockedTeammates implements WorkflowTeammateFactory {
  readonly materializations: FakeMaterialization[] = [];
  readonly closes: string[] = [];
  createAttempts = 0;
  createError: Error | null = null;
  submitError: Error | null = null;
  nextAdmission: Exclude<TurnAdmission, { status: 'submitted' }> | null = null;
  autoOutcome: TurnOutcome | null = null;
  createGate: Promise<void> | null = null;
  submitGate: Promise<void> | null = null;
  closeGate: Promise<void> | null = null;
  closeError: Error | null = null;
  closeAttempts = 0;

  async createLocked(
    input: MaterializationInput,
    options: CreateLockedTeammateOptions = {},
  ): Promise<LockedTeammate> {
    this.createAttempts += 1;
    await this.createGate;
    if (this.createError !== null) throw this.createError;
    const materialization: FakeMaterialization = {
      input,
      options,
      name: input.name,
      submitCalls: 0,
      closeCalls: 0,
      unlockCalls: 0,
      closed: false,
      unlocked: false,
      runtimeTurn: null,
      runtimeTurnReady: deferred<void>(),
    };
    this.materializations.push(materialization);
    const handle: LockedTeammate = {
      name: materialization.name,
      submit: async (submitInput): Promise<TurnAdmission> => {
        materialization.submitCalls += 1;
        expect(submitInput.prompt).toBe(input.prompt);
        if (this.submitError !== null) throw this.submitError;
        if (this.nextAdmission !== null) return this.nextAdmission;
        await this.submitGate;
        const runtimeTurn = controllableRuntimeSubmission();
        materialization.runtimeTurn = runtimeTurn;
        materialization.runtimeTurnReady.resolve();
        const settled = runtimeTurn.submission.settled.then(toTurnOutcome);
        const turn: Turn = Object.freeze({
          id: `turn-${materialization.submitCalls}`,
          runtime: runtimeTurn.submission,
          origin: submitInput.turnOrigin,
          prompt: input.prompt,
          intent: input.intent ?? null,
          submittedAt: Date.now(),
          settled,
          delivery: settled.then(() => undefined),
        });
        if (this.autoOutcome !== null) {
          runtimeTurn.settle(
            toSettlement(runtimeTurn.submission, this.autoOutcome),
          );
        }
        return { status: 'submitted', turn };
      },
      close: async (): Promise<{ teammate: AgentEntityRuntimeStatus }> => {
        materialization.closeCalls += 1;
        this.closeAttempts += 1;
        materialization.runtimeTurn?.stop();
        await this.closeGate;
        if (this.closeError !== null) throw this.closeError;
        materialization.closed = true;
        if (!this.closes.includes(materialization.name)) {
          this.closes.push(materialization.name);
        }
        return { teammate: teammateStatus(materialization.name, 'closed') };
      },
      unlock: () => {
        if (!materialization.closed) {
          throw new Error(`fake TeamMate ${materialization.name} is not closed`);
        }
        if (materialization.unlocked) {
          throw new Error(`fake TeamMate ${materialization.name} already unlocked`);
        }
        materialization.unlocked = true;
        materialization.unlockCalls += 1;
      },
    };
    return Object.freeze(handle);
  }

  async settle(
    position: number,
    status: TurnOutcome['status'],
    result: string | null,
  ): Promise<boolean> {
    const materialization = this.materializations[position];
    if (materialization === undefined) {
      throw new Error(`missing fake TeamMate ${position}`);
    }
    await materialization.runtimeTurnReady.promise;
    if (materialization.runtimeTurn === null) {
      throw new Error(`fake TeamMate ${position} submitted without a Turn`);
    }
    const outcome: TurnOutcome = status === 'completed'
      ? { status, resultText: result, truncated: false }
      : status === 'failed'
        ? { status, error: new Error(result ?? 'runtime Turn failed') }
        : { status: 'stopped' };
    return materialization.runtimeTurn.settle(
      toSettlement(materialization.runtimeTurn.submission, outcome),
    );
  }
}

class FakeWorkflowRunner implements WorkflowRunnerHandle {
  readonly sent: WorkflowRunnerParentMessage[] = [];
  startCount = 0;
  stopCount = 0;
  stopError: Error | null = null;

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

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (this.stopError !== null) throw this.stopError;
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
  readonly received: PreparedCompletionFact[] = [];
  deliveryGate: Promise<void> | null = null;

  async prepareCompletion(
    completion: PreparedCompletionFact,
  ): Promise<PreparedCompletionDelivery> {
    return Object.freeze({
      submit: async () => {
        this.received.push(completion);
        if (this.deliveryGate !== null) await this.deliveryGate;
        return { status: 'accepted' as const };
      },
    });
  }
}

interface TestContext {
  service: WorkflowService;
  runner: RunnerHarness;
  teammates: FakeLockedTeammates;
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
  const teammateFakes: FakeLockedTeammates[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dreamux-workflow-service-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.env['DREAMUX_ROOT'] = home;
  });

  afterEach(async () => {
    await Promise.allSettled(services.map((service) => service.stopAll()));
    services.length = 0;
    teammateFakes.length = 0;
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    await rm(home, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function context(
    runIds: string[],
    configure?: (harness: RunnerHarness) => void,
    start = true,
    attemptTimeoutMs?: number,
  ): Promise<TestContext> {
    const runner = new RunnerHarness();
    configure?.(runner);
    const teammates = new FakeLockedTeammates();
    const initiator = new CapturingInitiator();
    const log = captureLog();
    const completionDelivery = new CompletionDeliveryPolicy({
      dispatcherId: SCOPE.dispatcherId,
      log: log.logger,
      ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
    });
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates,
      completionDelivery,
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

  it('captures terminal delivery before runner start and evicts the terminal entity', async () => {
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
      runId: 'run-register-first',
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

  it('fences runner messages received after the terminal result', async () => {
    const runId = 'run-terminal-message-fence';
    const ctx = await context([runId]);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    runner.emit({
      type: 'emit',
      kind: 'log',
      message: 'must not queue behind terminal finalization',
    });

    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(await ctx.service.status({ run_id: runId })).toMatchObject({
      status: 'completed',
      result: 'done',
      last_log: null,
    });
    expect((await journalEvents(runId)).map((event) => event.kind)).toEqual([
      'run',
      'end',
    ]);
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

  it('bounds terminal delivery so Workflow stop cannot wait forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctx = await context(
      ['run-terminal-delivery-timeout'],
      undefined,
      true,
      100,
    );
    ctx.initiator.deliveryGate = new Promise<void>(() => undefined);
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'run_result',
      status: 'completed',
      result: 'done',
    });
    await waitForEventLoop(() => ctx.initiator.received.length === 1);

    const stopping = ctx.service.stopAll();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toBeUndefined();
    expect(activeRunCount(ctx.service)).toBe(0);
    expect(ctx.initiator.received).toHaveLength(1);
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));

    const closeGate = deferred<void>();
    ctx.teammates.closeGate = closeGate.promise;
    const stopTask = ctx.service.stopAll();
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(1));
    expect(agentResults(runner)).toEqual([]);
    expect(await ctx.teammates.settle(0, 'completed', 'late result')).toBe(false);
    closeGate.resolve();
    await stopTask;
    expect(await ctx.service.status({ run_id: 'run-fenced-queue' }))
      .toMatchObject({ status: 'stopped' });
    expect(agentResults(runner)).toEqual([]);
  });

  it('captures an immediate Turn settlement without routing an intermediate completion', async () => {
    const ctx = await context(['run-fast-settle']);
    ctx.teammates.autoOutcome = {
      status: 'completed',
      resultText: 'fast result',
      truncated: false,
    };

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
      result: 'fast result',
      error: null,
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
    expect(ctx.teammates.materializations).toHaveLength(0);

    allowPhaseWrite.resolve();
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.service.status({ run_id: 'run-message-order' }))
      .toMatchObject({ agents: [{ phase: 'collect' }] });
    await ctx.teammates.settle(0, 'completed', 'done');
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
  });

  it('passes outputSchema and workflow guidance once, then rejects invalid successful JSON', async () => {
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));

    expect(ctx.teammates.materializations[0]?.options.outputSchema).toEqual(schema);
    expect(ctx.teammates.materializations[0]?.options.systemPromptAppend).toEqual([
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
    expect(ctx.teammates.materializations).toHaveLength(1);
    expect(await ctx.service.status({ run_id: 'run-schema' })).toMatchObject({
      agents: [{ status: 'failed' }],
    });
    runner.emit({
      type: 'run_result',
      status: 'failed',
      error:
        'runtime reported successful structured output that was not valid JSON',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
  });

  it('rejects an empty successful structured result', async () => {
    const ctx = await context(['run-schema-empty']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'structured prompt',
      options: { schema: { type: 'object' } },
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
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
    ctx.teammates.nextAdmission = {
      status: 'failed',
      error: new Error('runtime turn failed'),
    };
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
    expect(ctx.teammates.closes).toEqual([]);

    runner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.teammates.closes).toEqual([
      ctx.teammates.materializations[0]?.name,
    ]);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closeCalls: 1,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
  });

  it('waits for in-flight materialization and closes the returned locked handle', async () => {
    const ctx = await context(['run-agent-materializing-stop']);
    const createGate = deferred<void>();
    ctx.teammates.createGate = createGate.promise;
    await ctx.service.run({ script: validScript() });
    ctx.runner.latest().emit({
      type: 'agent_start',
      index: 0,
      prompt: 'materializing during stop',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.createAttempts).toBe(1));

    let stopped = false;
    const stop = ctx.service.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(ctx.teammates.materializations).toHaveLength(0);

    createGate.resolve();
    await stop;
    expect(ctx.teammates.materializations).toHaveLength(1);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      submitCalls: 0,
      closeCalls: 1,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
  });

  it('returns a plain locked TeamMate creation failure as null', async () => {
    const ctx = await context(['run-agent-create-failed']);
    ctx.teammates.createError = new Error('runtime could not start');
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
    expect(ctx.teammates.createAttempts).toBe(1);

    runner.emit({ type: 'run_result', status: 'completed', result: [null] });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('completed');
  });

  it('retains and closes a locked handle after its submit call throws', async () => {
    const ctx = await context(['run-agent-submit-threw']);
    ctx.teammates.submitError = new Error('runtime admission response was lost');
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();

    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'plain prompt',
      options: { label: 'retained-handle' },
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toEqual([
        { type: 'agent_result', index: 0, result: null },
      ]),
    );
    expect(ctx.teammates.closes).toEqual([]);

    runner.emit({ type: 'run_result', status: 'completed', result: [null] });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));

    expect(ctx.teammates.closes).toEqual(['retained-handle']);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      submitCalls: 1,
      closeCalls: 1,
      unlockCalls: 1,
    });
    expect(ctx.initiator.received[0]?.status).toBe('completed');
  });

  it('does not terminalize or unlock when TeamMate close fails, and retries truthfully', async () => {
    const ctx = await context(['run-cleanup-failed']);
    ctx.teammates.closeError = new Error('TeamMate termination proof failed');
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'complete before close fails',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.teammates.settle(0, 'completed', 'agent result')).toBe(true);
    await vi.waitFor(() => expect(agentResults(runner)).toHaveLength(1));

    runner.emit({
      type: 'run_result',
      status: 'completed',
      result: { answer: 42 },
    });
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(2));
    expect(ctx.initiator.received).toEqual([]);
    expect(await ctx.service.status({ run_id: 'run-cleanup-failed' }))
      .toMatchObject({
        status: 'running',
        agents: [{ status: 'completed' }],
      });
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: false,
      unlocked: false,
      unlockCalls: 0,
    });
    expect((await journalEvents('run-cleanup-failed')).some(
      (event) => event.kind === 'end',
    )).toBe(false);

    ctx.teammates.closeError = null;
    await expect(
      ctx.service.stop({ run_id: 'run-cleanup-failed' }),
    ).resolves.toEqual({ run_id: 'run-cleanup-failed', status: 'completed' });
    expect(await ctx.service.status({ run_id: 'run-cleanup-failed' }))
      .toMatchObject({ status: 'completed', result: { answer: 42 } });
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closeCalls: 3,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
    expect(ctx.initiator.received).toHaveLength(1);
  });

  it('closes members before stalled runner bookkeeping and retries an unproved runner stop', async () => {
    const runId = 'run-runner-stop-retry';
    const ctx = await context([runId]);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'cancel even when runner termination is unproved',
      options: {},
    });
    await vi.waitFor(() => {
      expect(ctx.teammates.materializations).toHaveLength(1);
      expect(ctx.teammates.materializations[0]?.submitCalls).toBe(1);
    });

    const writeStarted = deferred<void>();
    const allowWrite = deferred<void>();
    const originalWrite = WorkflowRunStore.prototype.write;
    let gateRunnerLogWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (
          gateRunnerLogWrite &&
          record.run_id === runId &&
          record.last_log === 'blocked runner bookkeeping'
        ) {
          gateRunnerLogWrite = false;
          writeStarted.resolve();
          await allowWrite.promise;
        }
        await originalWrite.call(this, record);
      },
    );
    runner.emit({
      type: 'emit',
      kind: 'log',
      message: 'blocked runner bookkeeping',
    });
    await writeStarted.promise;

    runner.stopError = new Error('runner termination proof failed');
    let firstStopSettled = false;
    const firstStop = ctx.service.stop({ run_id: runId });
    void firstStop.then(
      () => {
        firstStopSettled = true;
      },
      () => {
        firstStopSettled = true;
      },
    );
    await vi.waitFor(() =>
      expect(ctx.teammates.materializations[0]?.closeCalls).toBe(1));

    expect(firstStopSettled).toBe(false);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: true,
      unlocked: false,
      unlockCalls: 0,
    });
    expect(ctx.initiator.received).toEqual([]);
    expect((await journalEvents(runId)).some(
      (event) => event.kind === 'end',
    )).toBe(false);
    expect(activeRunCount(ctx.service)).toBe(1);

    allowWrite.resolve();
    await expect(firstStop).rejects.toThrow('runner termination proof failed');
    expect(await ctx.service.status({ run_id: runId })).toMatchObject({
      status: 'running',
      agents: [{ status: 'stopped' }],
    });
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: true,
      unlocked: false,
      unlockCalls: 0,
    });

    runner.stopError = null;
    await expect(ctx.service.stop({ run_id: runId })).resolves.toEqual({
      run_id: runId,
      status: 'stopped',
    });
    expect(runner.stopCount).toBe(2);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closeCalls: 2,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'end',
    )).toHaveLength(1);
    expect(ctx.initiator.received).toHaveLength(1);
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

  it('retains the first Agent result when its record projection retries', async () => {
    const runId = 'run-agent-result-write-retry';
    const ctx = await context([runId]);
    const originalWrite = WorkflowRunStore.prototype.write;
    let failAgentResultWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (
          failAgentResultWrite &&
          record.status === 'running' &&
          record.agents[0]?.status === 'completed'
        ) {
          failAgentResultWrite = false;
          throw new Error('Agent result record write failed');
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'commit one Agent result',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.teammates.settle(0, 'completed', 'first result')).toBe(true);

    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(await ctx.service.status({ run_id: runId })).toMatchObject({
      status: 'failed',
      agents: [{ status: 'completed', result: 'first result', error: null }],
    });
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'result',
    )).toEqual([
      expect.objectContaining({
        index: 0,
        status: 'completed',
        result: 'first result',
        error: null,
      }),
    ]);
    expect(agentResults(runner)).toEqual([]);
  });

  it('reconciles a committed Agent result before stopping an interrupted run', async () => {
    const runId = 'run-agent-result-restart';
    const ctx = await context([runId]);
    const originalWrite = WorkflowRunStore.prototype.write;
    let failAgentResultWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (
          failAgentResultWrite &&
          record.status === 'running' &&
          record.agents[0]?.status === 'completed'
        ) {
          failAgentResultWrite = false;
          throw new Error('Agent result record write failed before restart');
        }
        await originalWrite.call(this, record);
      },
    );
    const closeGate = deferred<void>();
    ctx.teammates.closeGate = closeGate.promise;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'commit result before simulated restart',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(
      await ctx.teammates.settle(0, 'completed', 'durable Agent result'),
    ).toBe(true);
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(1));
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'result',
    )).toEqual([
      expect.objectContaining({
        index: 0,
        status: 'completed',
        result: 'durable Agent result',
      }),
    ]);
    expect((await journalEvents(runId)).some(
      (event) => event.kind === 'end',
    )).toBe(false);

    const restarted = await context(['unused-after-agent-restart'], undefined, false);
    await restarted.service.recover();
    expect(await restarted.service.status({ run_id: runId })).toMatchObject({
      status: 'stopped',
      agents: [{
        status: 'completed',
        result: 'durable Agent result',
        error: null,
      }],
    });
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'result',
    )).toHaveLength(1);
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'end',
    )).toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ]);
    expect(restarted.runner.runners).toHaveLength(0);
    expect(restarted.initiator.received).toEqual([]);

    closeGate.resolve();
  });

  it('retries terminal record persistence without duplicating the end journal', async () => {
    const ctx = await context(['run-terminal-write-retry']);
    const originalWrite = WorkflowRunStore.prototype.write;
    let failTerminalWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (failTerminalWrite && record.status === 'completed') {
          throw new Error('terminal record write failed');
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settle before terminal write',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.teammates.settle(0, 'completed', 'done')).toBe(true);
    await vi.waitFor(() => expect(agentResults(runner)).toHaveLength(1));
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });

    await vi.waitFor(() => expect(ctx.log.events).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'workflow terminal transition failed',
      }),
    ));
    expect((await journalEvents('run-terminal-write-retry')).filter(
      (event) => event.kind === 'end',
    )).toHaveLength(1);
    expect(ctx.initiator.received).toEqual([]);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: true,
      unlocked: false,
      unlockCalls: 0,
    });
    expect(await ctx.service.status({ run_id: 'run-terminal-write-retry' }))
      .toMatchObject({ status: 'running' });

    failTerminalWrite = false;
    await expect(
      ctx.service.stop({ run_id: 'run-terminal-write-retry' }),
    ).resolves.toEqual({
      run_id: 'run-terminal-write-retry',
      status: 'completed',
    });
    expect((await journalEvents('run-terminal-write-retry')).filter(
      (event) => event.kind === 'end',
    )).toHaveLength(1);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      unlockCalls: 1,
      unlocked: true,
    });
    expect(ctx.initiator.received).toHaveLength(1);
  });

  it('completes a running record from its terminal journal after restart', async () => {
    const runId = 'run-terminal-restart-recovery';
    const ctx = await context([runId]);
    const originalWrite = WorkflowRunStore.prototype.write;
    let failTerminalWrite = true;
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockImplementation(
      async function (this: WorkflowRunStore, record) {
        if (failTerminalWrite && record.status === 'completed') {
          throw new Error('terminal record write failed before restart');
        }
        await originalWrite.call(this, record);
      },
    );
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    const allowSubmit = deferred<void>();
    ctx.teammates.submitGate = allowSubmit.promise;
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'persist Agent before Workflow terminal',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    let settleCompleted = false;
    const settleTask = ctx.teammates
      .settle(0, 'completed', 'agent done')
      .then((settled) => {
        settleCompleted = true;
        return settled;
      });
    await Promise.resolve();
    expect(settleCompleted).toBe(false);
    allowSubmit.resolve();
    await expect(settleTask).resolves.toBe(true);
    await vi.waitFor(() => expect(agentResults(runner)).toHaveLength(1));
    runner.emit({
      type: 'run_result',
      status: 'completed',
      result: { answer: 42 },
    });

    await vi.waitFor(() => expect(ctx.log.events).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'workflow terminal transition failed',
      }),
    ));
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'end',
    )).toEqual([
      expect.objectContaining({
        status: 'completed',
        result: { answer: 42 },
        error: null,
      }),
    ]);
    expect(await ctx.service.status({ run_id: runId }))
      .toMatchObject({ status: 'running' });

    failTerminalWrite = false;
    const restarted = await context(['unused-after-restart'], undefined, false);
    await restarted.service.recover();

    expect(restarted.runner.runners).toHaveLength(0);
    expect(restarted.initiator.received).toEqual([]);
    expect(await restarted.service.status({ run_id: runId })).toMatchObject({
      status: 'completed',
      result: { answer: 42 },
      error: null,
      agents: [{ status: 'completed', result: 'agent done' }],
    });
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'end',
    )).toHaveLength(1);
  });

  it('retries a failed terminal journal append without releasing agent locks', async () => {
    const runId = 'run-terminal-journal-retry';
    const ctx = await context([runId]);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'settle before terminal journal append',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.teammates.settle(0, 'completed', 'done')).toBe(true);
    await vi.waitFor(() => expect(agentResults(runner)).toHaveLength(1));

    const journalPath = workflowRunJournalPath({ ...SCOPE, runId });
    const journalBeforeTerminal = await readFile(journalPath, 'utf8');
    await rm(journalPath);
    await mkdir(journalPath);
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });

    await vi.waitFor(() => expect(ctx.log.events).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'workflow terminal transition failed',
      }),
    ));
    expect(ctx.initiator.received).toEqual([]);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: true,
      unlocked: false,
      unlockCalls: 0,
    });
    expect(await ctx.service.status({ run_id: runId }))
      .toMatchObject({ status: 'running' });

    await rm(journalPath, { recursive: true });
    await writeFile(journalPath, journalBeforeTerminal, { mode: 0o600 });
    await expect(ctx.service.stop({ run_id: runId })).resolves.toEqual({
      run_id: runId,
      status: 'completed',
    });
    expect((await journalEvents(runId)).filter(
      (event) => event.kind === 'end',
    )).toHaveLength(1);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      unlockCalls: 1,
      unlocked: true,
    });
    expect(ctx.initiator.received).toHaveLength(1);
  });

  it('propagates an unsupported outputSchema runtime as an agent error', async () => {
    const ctx = await context(['run-schema-unsupported']);
    const unsupported = Object.assign(
      new Error('claude-code runtime does not support per-turn outputSchema'),
      {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    );
    ctx.teammates.nextAdmission = { status: 'failed', error: unsupported };
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
    expect(ctx.teammates.createAttempts).toBe(1);
    expect(ctx.teammates.materializations).toHaveLength(1);
    expect(ctx.teammates.closes).toEqual([]);

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'claude-code runtime does not support per-turn outputSchema',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(ctx.teammates.closes).toEqual([
      ctx.teammates.materializations[0]?.name,
    ]);
  });

  it('propagates an unsupported outputSchema error thrown by createLocked', async () => {
    const ctx = await context(['run-schema-throw']);
    const unsupported = Object.assign(
      new Error('claude-code runtime does not support per-turn outputSchema'),
      {
        name: 'UnsupportedAgentRuntimeFeatureError',
        feature: 'outputSchema',
      },
    );
    ctx.teammates.createError = unsupported;
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
    expect(ctx.teammates.createAttempts).toBe(1);
    expect(ctx.teammates.materializations).toHaveLength(0);

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
    ctx.teammates.nextAdmission = {
      status: 'failed',
      error: new Error('structured turn failed'),
    };
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

  it('defaults concurrency, rejects invalid values, and queues excess starts', async () => {
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
        (item) => item.kind === 'workflow' &&
          item.runId === 'run-default-concurrency',
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(ctx.teammates.materializations[0]?.input.prompt).toBe('first');

    await ctx.teammates.settle(0, 'completed', 'one');
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(2));
    expect(ctx.teammates.materializations[1]?.input.prompt).toBe('second');
    await ctx.teammates.settle(1, 'completed', 'two');
    firstRunner.emit({ type: 'run_result', status: 'completed', result: null });
    await vi.waitFor(() =>
      expect(ctx.initiator.received.some(
        (item) => item.kind === 'workflow' &&
          item.runId === 'run-queued-concurrency',
      ))
        .toBe(true),
    );
  });

  it('accepts 1000 lifetime agent calls and rejects call 1001 before materialization', async () => {
    // This case owns the lifetime admission boundary, not record-store throughput.
    // Each accepted agent otherwise rewrites an increasingly large record, making
    // the fixed 1000/1001 assertion depend on CI disk speed rather than behavior.
    vi.spyOn(WorkflowRunStore.prototype, 'write').mockResolvedValue(undefined);
    const ctx = await context(['run-agent-limit']);
    ctx.teammates.nextAdmission = {
      status: 'failed',
      error: new Error('runtime turn failed'),
    };
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

    await vi.waitFor(() => expect(ctx.teammates.createAttempts).toBe(1000), {
      timeout: 10_000,
    });
    await vi.waitFor(() =>
      expect(agentResults(runner)).toContainEqual({
        type: 'agent_result',
        index: 1000,
        error: 'workflow agent lifecycle limit of 1000 exceeded',
      }), { timeout: 10_000 });
    expect(ctx.teammates.createAttempts).toBe(1000);

    runner.emit({
      type: 'run_result',
      status: 'failed',
      error: 'workflow agent lifecycle limit of 1000 exceeded',
    });
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
  }, 20_000);

  it('returns stop only after close selects stopped and terminal persistence completes', async () => {
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));

    const closeGate = deferred<void>();
    ctx.teammates.closeGate = closeGate.promise;
    let stopSettled = false;
    const stop = ctx.service.stop({ run_id: 'run-stop' }).then((result) => {
      stopSettled = true;
      return result;
    });
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(1));
    expect(stopSettled).toBe(false);
    expect(ctx.initiator.received).toEqual([]);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closed: false,
      unlocked: false,
    });
    expect((await journalEvents('run-stop')).some(
      (event) => event.kind === 'end',
    )).toBe(false);
    expect(await ctx.teammates.settle(0, 'completed', 'late result')).toBe(false);

    closeGate.resolve();
    await expect(stop).resolves.toEqual({
      run_id: 'run-stop',
      status: 'stopped',
    });
    await vi.waitFor(() =>
      expect(runner.sent.some((message) => message.type === 'abort')).toBe(true),
    );
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.teammates.closes).toEqual([
      ctx.teammates.materializations[0]?.name,
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
      agents: [{ status: 'stopped' }],
    });
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closeCalls: 1,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
    expect(activeRunCount(ctx.service)).toBe(0);
  });

  it('uses the same close-first terminal pipeline for stopAll', async () => {
    const ctx = await context(['run-shutdown-stop']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'close through the workflow entity',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));

    await expect(ctx.service.stopAll()).resolves.toBeUndefined();

    expect(runner.stopCount).toBeGreaterThan(0);
    expect(ctx.teammates.closes).toEqual([
      ctx.teammates.materializations[0]?.name,
    ]);
    const terminal = await ctx.service.status({ run_id: 'run-shutdown-stop' });
    expect(terminal).toMatchObject({
      status: 'stopped',
      agents: [{ status: 'stopped' }],
    });
    expect(terminal.updated_at).toBe(terminal.ended_at);
    expect(activeRunCount(ctx.service)).toBe(0);
    expect(ctx.initiator.received).toMatchObject([{ status: 'stopped' }]);
    expect((await journalEvents('run-shutdown-stop')).map((event) => event.kind))
      .toEqual(['run', 'submit', 'result', 'end']);
    expect(agentResults(runner)).toEqual([]);
    expect(ctx.teammates.materializations[0]).toMatchObject({
      closeCalls: 1,
      unlockCalls: 1,
      closed: true,
      unlocked: true,
    });
  });

  it('drains accepted pre-stop Turn outcomes before terminal commit', async () => {
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(2));

    const firstSettle = await ctx.teammates.settle(0, 'completed', 'first');
    await writeStarted.promise;
    const secondSettle = await ctx.teammates.settle(1, 'completed', 'second');
    await vi.waitFor(async () =>
      expect((await ctx.service.status({ run_id: 'run-shutdown-mutation' }))
        .agents[1]?.status).toBe('completed'));
    const shutdown = ctx.service.stopAll();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    allowWrite.resolve();
    expect(firstSettle).toBe(true);
    expect(secondSettle).toBe(true);
    await shutdown;
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

  it('keeps the close-selected stopped outcome when a RuntimeTurn completes late', async () => {
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
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(2));

    const firstSettle = await ctx.teammates.settle(0, 'completed', 'first');
    await writeStarted.promise;
    const shutdown = ctx.service.stopAll();
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(2));
    const secondSettle = await ctx.teammates.settle(1, 'completed', 'late');
    expect(secondSettle).toBe(false);
    allowWrite.resolve();
    expect(firstSettle).toBe(true);
    await shutdown;

    expect((await journalEvents('run-shutdown-late-mutation')).map((event) =>
      event.kind)).toEqual([
      'run',
      'submit',
      'submit',
      'result',
      'result',
      'end',
    ]);
    expect(await ctx.service.status({ run_id: 'run-shutdown-late-mutation' }))
      .toMatchObject({
        status: 'stopped',
        agents: [{ status: 'completed' }, { status: 'stopped' }],
      });
  });

  it('joins the same terminal close already running when stopAll begins', async () => {
    const ctx = await context(['run-shutdown-auto-close']);
    const closeGate = deferred<void>();
    ctx.teammates.closeGate = closeGate.promise;
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'complete before shutdown',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));
    expect(await ctx.teammates.settle(0, 'completed', 'done')).toBe(true);
    runner.emit({ type: 'run_result', status: 'completed', result: 'done' });
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(1));

    const shutdown = ctx.service.stopAll();
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(ctx.teammates.closeAttempts).toBe(1);

    closeGate.resolve();
    await shutdown;
    expect(ctx.teammates.closeAttempts).toBe(1);
    expect(ctx.teammates.closes).toHaveLength(1);
    expect(await ctx.service.status({ run_id: 'run-shutdown-auto-close' }))
      .toMatchObject({ status: 'completed', result: 'done' });
  });

  it('fails on runner exit through the same close-first terminal pipeline', async () => {
    const ctx = await context(['run-crash']);
    await ctx.service.run({ script: validScript() });
    const runner = ctx.runner.latest();
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'survive runner crash',
      options: {},
    });
    await vi.waitFor(() => expect(ctx.teammates.materializations).toHaveLength(1));

    const closeGate = deferred<void>();
    ctx.teammates.closeGate = closeGate.promise;
    runner.exit(7, null);
    await vi.waitFor(() => expect(ctx.teammates.closeAttempts).toBe(1));
    expect(ctx.initiator.received).toHaveLength(0);
    expect(ctx.teammates.closes).toEqual([]);

    expect(await ctx.teammates.settle(0, 'completed', 'late result')).toBe(false);
    closeGate.resolve();
    await vi.waitFor(() => expect(ctx.initiator.received).toHaveLength(1));
    expect(ctx.initiator.received[0]?.status).toBe('failed');
    expect(ctx.teammates.closes).toEqual([
      ctx.teammates.materializations[0]?.name,
    ]);
    expect(await ctx.service.status({ run_id: 'run-crash' })).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(
        'workflow runner exited before reporting a result (code=7',
      ),
    });
    expect(await ctx.service.status({ run_id: 'run-crash' })).toMatchObject({
      agents: [{ status: 'stopped' }],
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

  it('loads and discards a legacy Workflow Agent turn_id', async () => {
    const runId = 'run-legacy-agent-id';
    const path = workflowRunRecordPath({ ...SCOPE, runId });
    const raw = {
      ...workflowRecord(runId),
      agents: [{ ...agentRecord(0, 'completed'), turn_id: 'legacy-turn-id' }],
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const store = new WorkflowRunStore(SCOPE);
    const loaded = await store.get(runId);
    expect(loaded?.agents[0]).toEqual(agentRecord(0, 'completed'));
    expect(loaded?.agents[0]).not.toHaveProperty('turn_id');

    await store.write(loaded!);
    expect(await readFile(path, 'utf8')).not.toContain('turn_id');
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

async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('event-loop condition was not reached');
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
    status,
    result: null,
    error: null,
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
