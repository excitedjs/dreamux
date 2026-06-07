/**
 * Real Claude Code TeamMate worker provider tests (issue #126 PR4).
 *
 * These drive `createClaudeCodeTeamMateWorkerProvider` against an in-process fake
 * resident session (the `ClaudeCodeSessionFactory` seam), so the actual execution
 * path — spawn (stubbed), one stream-json turn, terminal `result` — runs without
 * a real `claude` binary. Integration cases route through the PR1 ledger +
 * delivery and the PR2 execution service so the lifecycle lands in the
 * server-owned ledger; session-level cases drive the provider directly to assert
 * exactly-once terminal callbacks for cancel / child-exit / dispose, the
 * single-turn steer rejection, and the realpath containment check.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeCodeSession,
  ClaudeCodeSessionSpec,
} from '../src/agent-runtime/claude-code-session.js';
import type { TurnOutcome } from '../src/runtime/claude-code-stream.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/runtime/config.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';
import { TeamMateTaskLedger } from '../src/teammate/ledger.js';
import { TeamMateDeliveryService } from '../src/teammate/delivery.js';
import { TeamMateWorkerExecutionService } from '../src/teammate/worker-execution.js';
import { TeamMateWorkerProviderCatalog } from '../src/teammate/worker/catalog.js';
import { createClaudeCodeTeamMateWorkerProvider } from '../src/teammate/worker/claude-code-provider.js';
import type {
  TeamMateWorkerCallbacks,
  TeamMateWorkerHandle,
} from '../src/teammate/worker/types.js';
import { TeamMateWaitBroker } from '../src/teammate/wait-broker.js';

const DISPATCHER = 'flow';

function turnOutcome(
  partial: Partial<TurnOutcome> & { text: string },
): TurnOutcome {
  return {
    isError: false,
    sessionId: 'claude-sess-1',
    subtype: 'success',
    errors: [],
    ...partial,
  };
}

interface FakeBehavior {
  failStart?: boolean;
}

/** A `claude` resident-child stub whose turn the test resolves/rejects by hand. */
class FakeClaudeCodeSession implements ClaudeCodeSession {
  started = false;
  stopped = false;
  stopCount = 0;
  lastPrompt: string | null = null;
  private resolveTurn: ((o: TurnOutcome) => void) | null = null;
  private rejectTurn: ((e: Error) => void) | null = null;
  private onExit: (() => void) | null = null;

  constructor(
    readonly spec: ClaudeCodeSessionSpec,
    private readonly behavior: FakeBehavior,
  ) {}

  async start(): Promise<void> {
    if (this.behavior.failStart === true) {
      throw new Error('claude resident child spawn failed');
    }
    this.started = true;
  }

  submitTurn(prompt: string): Promise<TurnOutcome> {
    this.lastPrompt = prompt;
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
  }

  isAlive(): boolean {
    return this.started && !this.stopped;
  }

  setOnExit(handler: () => void): void {
    this.onExit = handler;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopCount += 1;
    // Mirror the live session: stop rejects any in-flight turn.
    const reject = this.rejectTurn;
    this.resolveTurn = null;
    this.rejectTurn = null;
    reject?.(new Error('claude resident session stopped mid-turn'));
  }

  // --- test controls ---
  finishTurn(outcome: TurnOutcome): void {
    const resolve = this.resolveTurn;
    this.resolveTurn = null;
    this.rejectTurn = null;
    resolve?.(outcome);
  }

  failTurn(err: Error): void {
    const reject = this.rejectTurn;
    this.resolveTurn = null;
    this.rejectTurn = null;
    reject?.(err);
  }

  /** A mid-turn child exit: the pending turn rejects AND onExit fires. */
  emitExit(): void {
    this.failTurn(new Error('claude resident child exited mid-turn'));
    this.onExit?.();
  }
}

interface ProviderHarness {
  provider: ReturnType<typeof createClaudeCodeTeamMateWorkerProvider>;
  sessions: FakeClaudeCodeSession[];
}

function buildProvider(
  opts: { dispatcherCwd: string; failStart?: boolean } = {
    dispatcherCwd: tmpdir(),
  },
): ProviderHarness {
  const sessions: FakeClaudeCodeSession[] = [];
  const provider = createClaudeCodeTeamMateWorkerProvider({
    resolveBinPath: (bin) => bin,
    resolveClaudeCodeConfig: () => defaultDispatcherClaudeCodeConfig(),
    resolveDispatcherCwd: () => opts.dispatcherCwd,
    sessionFactory: (spec) => {
      const session = new FakeClaudeCodeSession(spec, {
        failStart: opts.failStart ?? false,
      });
      sessions.push(session);
      return session;
    },
  });
  return { provider, sessions };
}

interface ExecHarness extends ProviderHarness {
  ledger: TeamMateTaskLedger;
  broker: TeamMateWaitBroker;
  execution: TeamMateWorkerExecutionService;
  /** Await every in-flight completion delivery so the temp HOME can be removed
   *  without racing a late ledger write (the worker's terminal callback chain is
   *  fire-and-forget relative to the lifecycle status). */
  drain: () => Promise<unknown>;
}

function buildExecHarness(dispatcherCwd: string): ExecHarness {
  const { provider, sessions } = buildProvider({ dispatcherCwd });
  const ledger = new TeamMateTaskLedger(DISPATCHER);
  const broker = new TeamMateWaitBroker();
  const catalog = new TeamMateWorkerProviderCatalog({ providers: [provider] });
  const delivery = new TeamMateDeliveryService({
    ledger: () => ledger,
    resolveRuntime: () => null,
    backoffMs: () => 0,
    notifyEvent: (d, t) => broker.notify(d, t),
  });
  const deliveries: Promise<unknown>[] = [];
  const execution = new TeamMateWorkerExecutionService({
    ledger: () => ledger,
    workers: () => catalog,
    reportCompletion: (report) => {
      const p = delivery.reportCompletion(report);
      deliveries.push(p);
      return p;
    },
    notifyEvent: (d, t) => broker.notify(d, t),
  });
  return {
    provider,
    sessions,
    ledger,
    broker,
    execution,
    drain: () => Promise.allSettled(deliveries),
  };
}

async function acceptTask(
  ledger: TeamMateTaskLedger,
  prompt: string,
): Promise<string> {
  const task = await ledger.acceptTask({
    title: 'Claude Code worker task',
    prompt,
    callerKind: 'dispatcher',
    providerRef: 'builtin:claude-code',
  });
  return task.task_id;
}

async function waitForTerminal(
  ledger: TeamMateTaskLedger,
  taskId: string,
  timeoutMs = 3000,
): Promise<'completed' | 'failed' | 'cancelled'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await ledger.getTask(taskId);
    const status = task?.lifecycle_status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(`task ${taskId} did not terminate; last status=${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function recordingCallbacks(): {
  callbacks: TeamMateWorkerCallbacks;
  running: TeamMateWorkerHandle[];
  completed: string[];
  failed: string[];
  cancelled: Array<string | null>;
} {
  const running: TeamMateWorkerHandle[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const cancelled: Array<string | null> = [];
  return {
    running,
    completed,
    failed,
    cancelled,
    callbacks: {
      onRunning: async (handle) => {
        running.push(handle);
      },
      onCompleted: async (text) => {
        completed.push(text);
      },
      onFailed: async (text) => {
        failed.push(text);
      },
      onCancelled: async (reason) => {
        cancelled.push(reason);
      },
    },
  };
}

describe('claude-code teammate worker provider', () => {
  // The provider writes a per-task MCP config under the dreamux state root
  // (homedir-based), so redirect HOME to a temp dir to stay filesystem-isolated.
  let homeDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    resetRuntimeConfig();
    origHome = process.env['HOME'];
    homeDir = mkdtempSync(join(tmpdir(), 'dreamux-cc-worker-home-'));
    process.env['HOME'] = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('advertises single-turn (steer:false) capabilities for the claude-code runtime', () => {
    const { provider } = buildProvider({ dispatcherCwd: homeDir });
    const caps = provider.capabilities();
    expect(provider.ref).toBe('builtin:claude-code');
    expect(caps.worker_available).toBe(true);
    expect(caps.modes).toEqual({ steer: false, queue: false, interrupt: false });
    expect(caps.resume).toBe(false);
    expect(caps.logs).toBe(true);
  });

  it('runs a task to completion and retains the real assistant result', async () => {
    const harness = buildExecHarness(homeDir);
    const { ledger, execution, sessions } = harness;
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');
    expect((outcome as { provider_ref: string }).provider_ref).toBe(
      'builtin:claude-code',
    );
    // The worker submitted the task prompt as the single stream-json turn.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.lastPrompt).toBe('do the work');

    sessions[0]!.finishTurn(turnOutcome({ text: 'claude worker finished' }));

    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('completed');
    const task = await ledger.getTask(taskId);
    expect(task?.result?.outcome).toBe('completed');
    expect(task?.result?.text).toBe('claude worker finished');
    // The live session is dropped and the resident child reaped once it completes.
    expect(execution.hasLiveSession(DISPATCHER, taskId)).toBe(false);
    expect(sessions[0]!.stopCount).toBeGreaterThanOrEqual(1);
    await harness.drain();
  });

  it('leaves the task accepted and retryable when the worker cannot start', async () => {
    const { provider, sessions } = buildProvider({
      dispatcherCwd: homeDir,
      failStart: true,
    });
    const ledger = new TeamMateTaskLedger(DISPATCHER);
    const catalog = new TeamMateWorkerProviderCatalog({ providers: [provider] });
    const execution = new TeamMateWorkerExecutionService({
      ledger: () => ledger,
      workers: () => catalog,
      reportCompletion: async () => undefined,
    });
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('provider_unavailable');
    expect((outcome as { retryable: boolean }).retryable).toBe(true);
    expect((outcome as { code: string }).code).toBe(
      'TEAMMATE_CLAUDE_CODE_WORKER_START_FAILED',
    );
    const task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('accepted');
    // The half-started session was reaped on the failure path.
    expect(sessions.at(-1)?.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('records a failed, pullable result for an error result', async () => {
    const harness = buildExecHarness(homeDir);
    const { ledger, execution, sessions } = harness;
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');

    sessions[0]!.finishTurn(
      turnOutcome({
        isError: true,
        text: '',
        subtype: 'error_max_turns',
        errors: ['hit the turn ceiling'],
      }),
    );

    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('failed');
    const task = await ledger.getTask(taskId);
    expect(task?.result?.outcome).toBe('failed');
    expect(task?.result?.text).toContain('hit the turn ceiling');
    await harness.drain();
  });

  it('records a failure when the resident child exits mid-turn', async () => {
    const harness = buildExecHarness(homeDir);
    const { ledger, execution, sessions } = harness;
    const taskId = await acceptTask(ledger, 'long task');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');

    sessions[0]!.emitExit();

    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('failed');
    const task = await ledger.getTask(taskId);
    expect(task?.result?.text).toContain('exited mid-turn');
    await harness.drain();
  });

  it('rejects send_input to a live single-turn worker (steer/queue/interrupt deferred)', async () => {
    const { provider, sessions } = buildProvider({ dispatcherCwd: homeDir });
    const recorder = recordingCallbacks();
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_steer',
        teammateId: null,
        title: 'Steer task',
        prompt: 'work',
        target: null,
        targetMode: null,
      },
      recorder.callbacks,
    );
    expect(outcome.status).toBe('started');
    if (outcome.status !== 'started') return;
    expect(recorder.running).toHaveLength(1);

    for (const mode of ['steer', 'queue', 'interrupt'] as const) {
      const disposition = await outcome.session.sendInput({
        inputId: `in-${mode}`,
        text: 'follow-up',
        mode,
      });
      expect(disposition.status).toBe('rejected');
    }

    await outcome.session.cancel('test cleanup');
    expect(recorder.cancelled).toEqual(['test cleanup']);
    expect(sessions.at(-1)?.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('cancel reaps the worker and fires onCancelled exactly once', async () => {
    const { provider, sessions } = buildProvider({ dispatcherCwd: homeDir });
    const recorder = recordingCallbacks();
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_cancel',
        teammateId: null,
        title: 'Cancel task',
        prompt: 'work',
        target: null,
        targetMode: null,
      },
      recorder.callbacks,
    );
    if (outcome.status !== 'started') throw new Error('expected started');

    expect(recorder.running).toHaveLength(1);
    await outcome.session.cancel('operator cancelled');
    // Subsequent terminal calls are no-ops (exactly-once terminal guarantee).
    await outcome.session.cancel('again');
    await outcome.session.dispose();
    expect(recorder.cancelled).toEqual(['operator cancelled']);
    expect(recorder.completed).toHaveLength(0);
    expect(recorder.failed).toHaveLength(0);
    expect(sessions.at(-1)?.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('dispose releases resources without any lifecycle callback', async () => {
    const { provider, sessions } = buildProvider({ dispatcherCwd: homeDir });
    const recorder = recordingCallbacks();
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_dispose',
        teammateId: null,
        title: 'Dispose task',
        prompt: 'work',
        target: null,
        targetMode: null,
      },
      recorder.callbacks,
    );
    if (outcome.status !== 'started') throw new Error('expected started');

    await outcome.session.dispose();
    expect(recorder.completed).toHaveLength(0);
    expect(recorder.failed).toHaveLength(0);
    expect(recorder.cancelled).toHaveLength(0);
    expect(sessions.at(-1)?.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses to launch when the target escapes the dispatcher dir via a symlink', async () => {
    const dispatcherDir = mkdtempSync(join(tmpdir(), 'dreamux-disp-'));
    const outside = mkdtempSync(join(tmpdir(), 'dreamux-outside-'));
    const escape = join(dispatcherDir, 'escape');
    symlinkSync(outside, escape);
    const { provider, sessions } = buildProvider({ dispatcherCwd: dispatcherDir });
    try {
      await expect(
        provider.startSession(
          {
            dispatcherId: DISPATCHER,
            taskId: 'tmtsk_1_escape',
            teammateId: null,
            title: 'Escape task',
            prompt: 'work',
            // Lexically inside dispatcherDir, but the symlink resolves outside.
            target: { kind: 'path', path: escape },
            targetMode: null,
          },
          recordingCallbacks().callbacks,
        ),
      ).rejects.toThrow(/escapes the dispatcher directory/);
      // No resident session was ever constructed for the rejected task.
      expect(sessions).toHaveLength(0);
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows a symlinked target that still resolves inside the dispatcher dir', async () => {
    const dispatcherDir = mkdtempSync(join(tmpdir(), 'dreamux-disp-'));
    const realSub = join(dispatcherDir, 'real-sub');
    mkdirSync(realSub);
    const link = join(dispatcherDir, 'linked');
    symlinkSync(realSub, link); // resolves to <dispatcherDir>/real-sub — inside
    const recorder = recordingCallbacks();
    const { provider } = buildProvider({ dispatcherCwd: dispatcherDir });
    try {
      const outcome = await provider.startSession(
        {
          dispatcherId: DISPATCHER,
          taskId: 'tmtsk_1_inside',
          teammateId: null,
          title: 'Inside task',
          prompt: 'work',
          target: { kind: 'path', path: link },
          targetMode: null,
        },
        recorder.callbacks,
      );
      expect(outcome.status).toBe('started');
      expect(recorder.running).toHaveLength(1);
      if (outcome.status === 'started') await outcome.session.cancel(null);
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true });
    }
  });
});
