/**
 * Shared test seam for Workflow + Scheduler (coverage cell E).
 *
 * Nothing here encodes a scenario. It only builds the shapes a real caller
 * would supply: a real `DREAMUX_ROOT` so `WorkflowRunStore`/`WorkflowJournal`
 * exercise the real path builders and real file IO, a fake in-process
 * `WorkflowRunnerHandle` that stands in for the forked child so a run's own
 * orchestration (journal writes, terminal settlement, eviction) can be driven
 * deterministically without a VM sandbox, and a controllable `LockedTeammate`
 * that stands in for a materialized TeamMate. Each test still decides what
 * messages flow and when.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { CompletionDeliveryPolicy, CompletionInitiator, PreparedCompletionFact } from '../../src/service/completion-router/index.js';
import type { CreateLockedTeammateOptions } from '../../src/service/teammate-collection/index.js';
import type { SpawnTeamMateRequest } from '../../src/service/teammate-collection/types.js';
import type { Turn, TurnAdmission, TurnOutcome } from '../../src/service/teammate-service/turn-recording.js';
import type { LockedTeammate } from '../../src/service/teammate-service/types.js';
import type { WorkflowTeammateFactory } from '../../src/service/workflow-service/index.js';
import type {
  WorkflowRunnerChildMessage,
  WorkflowRunnerParentMessage,
} from '../../src/service/workflow-service/protocol.js';
import type {
  WorkflowRunnerFactory,
  WorkflowRunnerHandle,
  WorkflowRunnerHandlers,
} from '../../src/service/workflow-service/runner-process.js';
import type { CronJob, CronJobStore } from '../../src/service/scheduler/store.js';

/** A silent `DreamuxLogger` fake; individual methods can be spied by the caller. */
export function silentLog(): DreamuxLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as DreamuxLogger;
}
export interface WorkflowRootState {
  readonly dir: string;
  restore(): Promise<void>;
}

/**
 * Point every neutral path builder (`platform/paths.ts`) at a fresh temp
 * directory for the duration of one test, via the `DREAMUX_ROOT` override the
 * production loader already honors. Restores the previous value and removes
 * the directory in `restore()`, so tests can share the ordinary
 * `dispatcherDir`/`workflowRunRecordPath`/etc. builders instead of a parallel
 * path scheme that could drift from what production actually reads.
 */
export async function beginWorkflowRoot(): Promise<WorkflowRootState> {
  const dir = await mkdtemp(join(tmpdir(), 'dreamux-workflow-cell-'));
  const previous = process.env['DREAMUX_ROOT'];
  process.env['DREAMUX_ROOT'] = dir;
  return {
    dir,
    async restore() {
      if (previous === undefined) delete process.env['DREAMUX_ROOT'];
      else process.env['DREAMUX_ROOT'] = previous;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Records every fact handed to `CompletionDeliveryPolicy.deliver`. */
export interface FakeCompletionDelivery {
  readonly policy: CompletionDeliveryPolicy;
  readonly delivered: PreparedCompletionFact[];
  readonly deliverRuntimeCalls: number;
}

/**
 * A `deliver`-only double for `CompletionDeliveryPolicy`.
 *
 * Real `WorkflowService`/`WorkflowRun` code reaches only `deliver(initiator,
 * fact)` — the null-completion-token entry point documented on the real
 * class — never `deliverRuntime` with a provider token. `deliverRuntimeCalls`
 * stays observable so a test can assert it never moves off zero.
 */
export function fakeCompletionDelivery(): FakeCompletionDelivery {
  const delivered: PreparedCompletionFact[] = [];
  let deliverRuntimeCalls = 0;
  const policy = {
    async deliver(_initiator: CompletionInitiator, fact: PreparedCompletionFact) {
      delivered.push(fact);
    },
    deliverRuntime() {
      deliverRuntimeCalls += 1;
      return Promise.resolve();
    },
  } as unknown as CompletionDeliveryPolicy;
  return {
    policy,
    delivered,
    get deliverRuntimeCalls() {
      return deliverRuntimeCalls;
    },
  };
}

/** A `CompletionInitiator` double whose `prepareCompletion` records nothing further. */
export function fakeCompletionInitiator(): CompletionInitiator {
  return {
    prepareCompletion: async () => ({ submit: async () => ({ status: 'accepted' as const }) }),
  };
}

export interface ControllableTurn {
  readonly turn: Turn;
  settle(outcome: TurnOutcome): void;
}

/** A `Turn` whose `settled` promise the test resolves on its own schedule. */
export function controllableTurn(overrides: Partial<Turn> = {}): ControllableTurn {
  let settle!: (outcome: TurnOutcome) => void;
  const settled = new Promise<TurnOutcome>((resolve) => {
    settle = resolve;
  });
  const turn: Turn = {
    id: overrides.id ?? `turn-${Math.random().toString(36).slice(2)}`,
    runtime: overrides.runtime ?? ({ settled: Promise.resolve({ kind: 'stopped' }) } as Turn['runtime']),
    source: overrides.source ?? 'task',
    sourceId: overrides.sourceId ?? null,
    prompt: overrides.prompt ?? null,
    intent: overrides.intent ?? null,
    submittedAt: overrides.submittedAt ?? Date.now(),
    settled,
    delivery: overrides.delivery ?? Promise.resolve(),
  };
  return { turn, settle };
}

export interface ControllableLockedTeammate {
  readonly handle: LockedTeammate;
  readonly submitCalls: Array<{ prompt: string; source: string }>;
  /** Resolve the next (or a specific queued) `submit()` call with this admission. */
  admitNext(admission: TurnAdmission): void;
  readonly closeCalls: Array<{ note: string }>;
  readonly unlocked: boolean;
}

/**
 * A `LockedTeammate` double whose `submit()` the test drives one call at a
 * time — `WorkflowRun` never calls `submit` more than once per Agent, but the
 * queue keeps the double honest if that ever changes.
 */
export function controllableLockedTeammate(name: string): ControllableLockedTeammate {
  const submitCalls: Array<{ prompt: string; source: string }> = [];
  const closeCalls: Array<{ note: string }> = [];
  const pendingAdmissions: TurnAdmission[] = [];
  const waiters: Array<(admission: TurnAdmission) => void> = [];
  let unlocked = false;
  const handle: LockedTeammate = {
    name,
    async submit(input) {
      submitCalls.push({ prompt: input.prompt, source: input.source });
      const queued = pendingAdmissions.shift();
      if (queued !== undefined) return queued;
      return new Promise<TurnAdmission>((resolve) => {
        waiters.push(resolve);
      });
    },
    async close(input) {
      closeCalls.push({ note: input.note });
      return { teammate: { name, status: 'closed' } } as unknown as Awaited<
        ReturnType<LockedTeammate['close']>
      >;
    },
    unlock() {
      unlocked = true;
    },
  };
  return {
    handle,
    submitCalls,
    closeCalls,
    get unlocked() {
      return unlocked;
    },
    admitNext(admission) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(admission);
      else pendingAdmissions.push(admission);
    },
  };
}

export interface FakeTeammateFactory extends WorkflowTeammateFactory {
  readonly calls: Array<{
    input: SpawnTeamMateRequest;
    options: CreateLockedTeammateOptions | undefined;
  }>;
}

/**
 * A `WorkflowTeammateFactory` double built from a queue of prepared
 * `LockedTeammate`s (or a factory-per-call), one consumed per `createLocked`.
 */
export function fakeTeammateFactory(
  next: (
    input: SpawnTeamMateRequest,
    options: CreateLockedTeammateOptions | undefined,
  ) => Promise<LockedTeammate> | LockedTeammate,
): FakeTeammateFactory {
  const calls: FakeTeammateFactory['calls'] = [];
  return {
    calls,
    async createLocked(input, options) {
      calls.push({ input, options });
      return next(input, options);
    },
  };
}

/**
 * Wrap a `WorkflowTeammateFactory` in a `Proxy` that throws on any property
 * access other than `createLocked` — the runtime proof that a Team-scoped
 * `WorkflowService` never reaches for a raw `TeamService`/`TeammateCollection`
 * member (e.g. `stopAllForDissolve`, `withTeamLeaderLease`) through this
 * dependency, only the one narrow capability it was handed.
 */
export function onlyCreateLockedSurface(
  factory: WorkflowTeammateFactory,
): WorkflowTeammateFactory {
  return new Proxy(factory, {
    get(target, prop, receiver) {
      if (prop === 'createLocked' || typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver);
      }
      throw new Error(
        `workflow teammate capability surface accessed unexpected member '${String(prop)}'`,
      );
    },
  });
}

export interface FakeWorkflowRunner extends WorkflowRunnerHandle {
  readonly sent: WorkflowRunnerParentMessage[];
  readonly started: boolean;
  readonly stopped: boolean;
  /** Simulate the child process reporting a message back to `WorkflowRun`. */
  emit(message: WorkflowRunnerChildMessage): void;
  /** Simulate the child process exiting on its own (crash, forced kill, …). */
  exit(exit: { code: number | null; signal: NodeJS.Signals | null }): void;
}

export interface FakeWorkflowRunnerFactory {
  readonly factory: WorkflowRunnerFactory;
  /** Every fake runner created, in creation order — one per `WorkflowRun`. */
  readonly runners: FakeWorkflowRunner[];
}

/**
 * An in-process double for `WorkflowRunnerFactory`.
 *
 * `WorkflowService`/`WorkflowRun` only ever talk to the `WorkflowRunnerHandle`
 * surface (`start`/`send`/`stop`) and the handlers it was constructed with
 * (`onMessage`/`onExit`/`onError`); nothing here depends on the real forked
 * `runner.js` or the VM sandbox in it, which lets Workflow orchestration
 * (journal writes, terminal settlement, eviction, admission) be exercised
 * deterministically and fast.
 */
export function fakeWorkflowRunnerFactory(): FakeWorkflowRunnerFactory {
  const runners: FakeWorkflowRunner[] = [];
  const factory: WorkflowRunnerFactory = (handlers: WorkflowRunnerHandlers) => {
    const sent: WorkflowRunnerParentMessage[] = [];
    let started = false;
    let stopped = false;
    const runner: FakeWorkflowRunner = {
      sent,
      get started() {
        return started;
      },
      get stopped() {
        return stopped;
      },
      async start() {
        started = true;
      },
      async send(message) {
        sent.push(message);
      },
      async stop() {
        stopped = true;
      },
      emit(message) {
        handlers.onMessage(message);
      },
      exit(exit) {
        handlers.onExit(exit);
      },
    };
    runners.push(runner);
    return runner;
  };
  return { factory, runners };
}

/** A run id generator that returns fixed, caller-chosen ids in sequence. */
export function fixedRunIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (id === undefined) throw new Error('fixedRunIds exhausted its queue');
    return id;
  };
}

/** A monotonically increasing clock a test can advance by hand. */
export function manualClock(start = 1_000): { now: () => number; advance(ms: number): void; set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(value: number) {
      current = value;
    },
  };
}

/** A minimal, schema-valid `prompt-agent` cron job for tests to override from. */
export function testCronJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = overrides.created_at ?? 1_000;
  return {
    id: 'job-test',
    dispatcher_id: 'dispatcher-1',
    cron: '* * * * *',
    tz: 'UTC',
    recurring: true,
    action: { kind: 'prompt-agent', prompt: 'do the thing' },
    enabled: true,
    created_at: now,
    updated_at: now,
    next_run_at: now,
    last_fired_at: null,
    ...overrides,
  };
}

function cloneCronJob(job: CronJob): CronJob {
  return JSON.parse(JSON.stringify(job)) as CronJob;
}

export interface FakeCronStoreSetFiredCall {
  id: string;
  firedAt: number;
  nextRunAt: number | null;
  enabled: boolean;
}

export interface FakeCronStore {
  /** Cast to `CronJobStore` at every real call site; this is a hand-built double. */
  readonly store: CronJobStore;
  readonly jobs: Map<string, CronJob>;
  readonly getCalls: number;
  readonly setFiredCalls: readonly FakeCronStoreSetFiredCall[];
  /**
   * Make the NEXT `get()` call await `gate` before resolving. Calls queue in
   * FIFO order; a `get()` with no queued gate resolves immediately. This is
   * how a test holds the scheduler open exactly between two of its own
   * sequential `store.get()` reads (the `dispatch()` read and the
   * closer-to-submission `submitDue()` re-read) to prove the second read is a
   * real revalidation and not a formality.
   */
  queueGetGate(gate: Promise<void>): void;
}

/**
 * A hand-built `CronJobStore` double, in-memory, with per-call timing control
 * a real file-backed store cannot offer deterministically. Used only for the
 * scheduler's own lifecycle-generation and durable-revalidation timing
 * proofs; every other scheduler/store contract in this cell is proven against
 * the real `CronJobStore` and a real temp-file `cronJobsPath`.
 */
export function fakeCronStore(initialJobs: readonly CronJob[]): FakeCronStore {
  const jobs = new Map(initialJobs.map((job) => [job.id, cloneCronJob(job)]));
  const gates: Array<Promise<void>> = [];
  let getCalls = 0;
  const setFiredCalls: FakeCronStoreSetFiredCall[] = [];
  const store = {
    async assertCurrent() {},
    async list() {
      return [...jobs.values()].map(cloneCronJob);
    },
    async get(id: string) {
      getCalls += 1;
      const gate = gates.shift();
      if (gate !== undefined) await gate;
      const job = jobs.get(id);
      return job === undefined ? null : cloneCronJob(job);
    },
    async create() {
      throw new Error('fakeCronStore.create is not implemented; seed jobs via initialJobs');
    },
    async update(input: { id: string } & Partial<CronJob>) {
      const current = jobs.get(input.id);
      if (current === undefined) throw new Error(`cron job '${input.id}' does not exist`);
      const next: CronJob = { ...current, ...input, updated_at: Date.now() };
      jobs.set(input.id, next);
      return cloneCronJob(next);
    },
    async delete(id: string) {
      return jobs.delete(id);
    },
    async setFired(input: FakeCronStoreSetFiredCall) {
      setFiredCalls.push(input);
      const job = jobs.get(input.id);
      if (job === undefined) return null;
      const next: CronJob = {
        ...job,
        last_fired_at: input.firedAt,
        next_run_at: input.nextRunAt,
        enabled: input.enabled,
        updated_at: input.firedAt,
      };
      jobs.set(input.id, next);
      return cloneCronJob(next);
    },
    async deleteStoreFile() {
      jobs.clear();
    },
  } as unknown as CronJobStore;
  return {
    store,
    jobs,
    get getCalls() {
      return getCalls;
    },
    setFiredCalls,
    queueGetGate(gate) {
      gates.push(gate);
    },
  };
}

/** A promise plus its resolver, for holding an async boundary open by hand. */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Poll a predicate (sync or async) until it is true, for waiting on a real
 * `setTimeout`-scheduled scheduler fire without depending on fake timers.
 * Throws if `predicate` never becomes true within `timeoutMs`.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 2_000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
