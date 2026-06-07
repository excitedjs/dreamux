/**
 * Real Codex TeamMate worker provider tests (issue #126 PR3).
 *
 * These drive `createCodexTeamMateWorkerProvider` against the in-process fake
 * codex app-server (`tests/fake-codex.ts`) so the actual execution path — spawn
 * (stubbed), handshake, thread/start, turn/start, turn/completed — runs without
 * a real codex binary. Integration cases route through the PR1 ledger + delivery
 * and the PR2 execution service so the lifecycle lands in the server-owned
 * ledger; session-level cases drive the provider directly to assert exactly-once
 * terminal callbacks for cancel / connection-close / dispose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexProcess, type CodexProcessOptions } from '../src/codex/supervisor.js';
import { CodexWsClient } from '../src/codex/rpc.js';
import { defaultDispatcherCodexConfig } from '../src/runtime/config.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';
import { TeamMateTaskLedger } from '../src/teammate/ledger.js';
import { TeamMateDeliveryService } from '../src/teammate/delivery.js';
import {
  TeamMateWorkerExecutionService,
  type TeamMateExecutionOutcome,
} from '../src/teammate/worker-execution.js';
import { TeamMateWorkerProviderCatalog } from '../src/teammate/worker/catalog.js';
import { createCodexTeamMateWorkerProvider } from '../src/teammate/worker/codex-provider.js';
import type {
  TeamMateWorkerCallbacks,
  TeamMateWorkerHandle,
} from '../src/teammate/worker/types.js';
import { TeamMateWaitBroker } from '../src/teammate/wait-broker.js';
import { startFakeCodex, type FakeCodex } from './fake-codex.js';

const DISPATCHER = 'flow';

/** A codex child stub: the fake codex's TCP url is the real WS endpoint. */
class NoopCodexProcess extends CodexProcess {
  reapCount = 0;
  override async start(): Promise<void> {
    /* no real child */
  }
  override async reap(): Promise<void> {
    this.reapCount += 1;
  }
}

interface ProviderHarness {
  provider: ReturnType<typeof createCodexTeamMateWorkerProvider>;
  processes: NoopCodexProcess[];
}

function buildProvider(
  fake: FakeCodex,
  opts: { initializeTimeoutMs?: number; dispatcherCwd?: string } = {},
): ProviderHarness {
  const processes: NoopCodexProcess[] = [];
  const dispatcherCwd = opts.dispatcherCwd ?? '/tmp/teammate-codex-worker';
  const provider = createCodexTeamMateWorkerProvider({
    resolveBinPath: (bin) => bin,
    resolveCodexConfig: () => ({
      ...defaultDispatcherCodexConfig(),
      ...(opts.initializeTimeoutMs !== undefined
        ? { initialize_timeout_ms: opts.initializeTimeoutMs }
        : {}),
    }),
    resolveDispatcherCwd: () => dispatcherCwd,
    codexProcessFactory: (o: CodexProcessOptions) => {
      const proc = new NoopCodexProcess(o);
      processes.push(proc);
      return proc;
    },
    codexClientFactory: () => new CodexWsClient({ url: fake.url }),
  });
  return { provider, processes };
}

interface ExecHarness extends ProviderHarness {
  ledger: TeamMateTaskLedger;
  broker: TeamMateWaitBroker;
  execution: TeamMateWorkerExecutionService;
}

function buildExecHarness(
  fake: FakeCodex,
  opts: { initializeTimeoutMs?: number } = {},
): ExecHarness {
  const { provider, processes } = buildProvider(fake, opts);
  const ledger = new TeamMateTaskLedger(DISPATCHER);
  const broker = new TeamMateWaitBroker();
  const catalog = new TeamMateWorkerProviderCatalog({ providers: [provider] });
  const delivery = new TeamMateDeliveryService({
    ledger: () => ledger,
    resolveRuntime: () => null,
    backoffMs: () => 0,
    notifyEvent: (d, t) => broker.notify(d, t),
  });
  const execution = new TeamMateWorkerExecutionService({
    ledger: () => ledger,
    workers: () => catalog,
    reportCompletion: (report) => delivery.reportCompletion(report),
    notifyEvent: (d, t) => broker.notify(d, t),
  });
  return { provider, processes, ledger, broker, execution };
}

async function acceptTask(
  ledger: TeamMateTaskLedger,
  prompt: string,
): Promise<string> {
  const task = await ledger.acceptTask({
    title: 'Codex worker task',
    prompt,
    callerKind: 'dispatcher',
    providerRef: 'builtin:codex',
  });
  return task.task_id;
}

/** Poll the ledger until the task reaches a terminal lifecycle (or time out). */
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

describe('codex teammate worker provider', () => {
  let fake: FakeCodex | null = null;

  beforeEach(() => {
    resetRuntimeConfig();
  });

  afterEach(async () => {
    if (fake !== null) {
      await fake.close();
      fake = null;
    }
  });

  it('advertises steer-only capabilities for the codex runtime', async () => {
    fake = await startFakeCodex({});
    const { provider } = buildProvider(fake);
    const caps = provider.capabilities();
    expect(provider.ref).toBe('builtin:codex');
    expect(caps.worker_available).toBe(true);
    expect(caps.modes).toEqual({ steer: true, queue: false, interrupt: false });
    expect(caps.resume).toBe(false);
  });

  it('runs a task to completion and retains the real assistant result', async () => {
    fake = await startFakeCodex({ replyFor: () => 'codex worker finished' });
    const { ledger, execution } = buildExecHarness(fake);
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');
    expect((outcome as { provider_ref: string }).provider_ref).toBe(
      'builtin:codex',
    );

    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('completed');
    const task = await ledger.getTask(taskId);
    expect(task?.result?.outcome).toBe('completed');
    expect(task?.result?.text).toBe('codex worker finished');
    // The live session is dropped once the task completes.
    expect(execution.hasLiveSession(DISPATCHER, taskId)).toBe(false);
  });

  it('leaves the task accepted and retryable when the worker cannot start', async () => {
    // swallowInitialize makes the handshake hang; a short timeout fails the
    // start before onRunning, so the task stays accepted (retryable).
    fake = await startFakeCodex({ swallowInitialize: true });
    const { ledger, execution, processes } = buildExecHarness(fake, {
      initializeTimeoutMs: 150,
    });
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('provider_unavailable');
    expect((outcome as { code: string; retryable: boolean }).retryable).toBe(true);
    expect((outcome as { code: string }).code).toBe(
      'TEAMMATE_CODEX_WORKER_START_FAILED',
    );
    const task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('accepted');
    // The half-started process was reaped on the failure path.
    expect(processes.at(-1)?.reapCount).toBeGreaterThanOrEqual(1);
  });

  it('records a failed, pullable result when turn submission fails', async () => {
    fake = await startFakeCodex({ failTurnStart: true });
    const { ledger, execution } = buildExecHarness(fake);
    const taskId = await acceptTask(ledger, 'do the work');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    // onRunning landed, then turn/start failed -> the running task fails.
    expect(outcome.status).toBe('failed');
    const task = await ledger.getTask(taskId);
    expect(task?.lifecycle_status).toBe('failed');
    expect(task?.result?.outcome).toBe('failed');
    expect(task?.result?.text).toContain('turn/start failed');
  });

  it('folds a steer input onto the active turn and joins it into the result', async () => {
    // A long turn delay keeps the turn active so the steered input folds in.
    fake = await startFakeCodex({ activeTurnFolding: true, turnDelayMs: 80 });
    const { ledger, execution } = buildExecHarness(fake);
    const taskId = await acceptTask(ledger, 'first prompt');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');

    const routed = await execution.sendInput({
      dispatcherId: DISPATCHER,
      taskId,
      inputId: 'in-1',
      text: 'steer follow-up',
      mode: 'steer',
    });
    expect(routed.delivered).toBe(true);
    expect(routed.disposition?.status).toBe('accepted');

    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('completed');
    const task = await ledger.getTask(taskId);
    // The fake echoes the folded turn (prompt + steer joined).
    expect(task?.result?.text).toContain('first prompt');
    expect(task?.result?.text).toContain('steer follow-up');
  });

  it('rejects non-steer dispositions (queue/interrupt deferred)', async () => {
    fake = await startFakeCodex({ turnDelayMs: 5000 });
    const recorder = recordingCallbacks();
    const { provider, processes } = buildProvider(fake);
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_steer',
        teammateId: null,
        title: 'Steer task',
        prompt: 'work',
        target: { kind: 'path', path: '/tmp/teammate-codex-worker' },
        targetMode: null,
      },
      recorder.callbacks,
    );
    expect(outcome.status).toBe('started');
    if (outcome.status !== 'started') return;

    const queued = await outcome.session.sendInput({
      inputId: 'in-q',
      text: 'queue me',
      mode: 'queue',
    });
    expect(queued.status).toBe('rejected');

    await outcome.session.cancel('test cleanup');
    expect(recorder.cancelled).toEqual(['test cleanup']);
    expect(processes.at(-1)?.reapCount).toBeGreaterThanOrEqual(1);
  });

  it('cancel reaps the worker and fires onCancelled exactly once', async () => {
    fake = await startFakeCodex({ turnDelayMs: 5000 });
    const recorder = recordingCallbacks();
    const { provider, processes } = buildProvider(fake);
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_cancel',
        teammateId: null,
        title: 'Cancel task',
        prompt: 'work',
        target: { kind: 'path', path: '/tmp/teammate-codex-worker' },
        targetMode: null,
      },
      recorder.callbacks,
    );
    if (outcome.status !== 'started') throw new Error('expected started');

    expect(recorder.running).toHaveLength(1);
    await outcome.session.cancel('operator cancelled');
    // A second terminal call is a no-op (exactly-once terminal guarantee).
    await outcome.session.cancel('again');
    await outcome.session.dispose();
    expect(recorder.cancelled).toEqual(['operator cancelled']);
    expect(recorder.completed).toHaveLength(0);
    expect(recorder.failed).toHaveLength(0);
    expect(processes.at(-1)?.reapCount).toBeGreaterThanOrEqual(1);
  });

  it('dispose releases resources without any lifecycle callback', async () => {
    fake = await startFakeCodex({ turnDelayMs: 5000 });
    const recorder = recordingCallbacks();
    const { provider, processes } = buildProvider(fake);
    const outcome = await provider.startSession(
      {
        dispatcherId: DISPATCHER,
        taskId: 'tmtsk_1_dispose',
        teammateId: null,
        title: 'Dispose task',
        prompt: 'work',
        target: { kind: 'path', path: '/tmp/teammate-codex-worker' },
        targetMode: null,
      },
      recorder.callbacks,
    );
    if (outcome.status !== 'started') throw new Error('expected started');

    await outcome.session.dispose();
    expect(recorder.completed).toHaveLength(0);
    expect(recorder.failed).toHaveLength(0);
    expect(recorder.cancelled).toHaveLength(0);
    expect(processes.at(-1)?.reapCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses to launch when the target escapes the dispatcher dir via a symlink', async () => {
    // PR1 confined the target lexically; the worker slice owes the realpath
    // check (issue #126). A symlink whose lexical path is "inside" but resolves
    // outside must be rejected before any codex process is spawned.
    fake = await startFakeCodex({});
    const dispatcherDir = mkdtempSync(join(tmpdir(), 'dreamux-disp-'));
    const outside = mkdtempSync(join(tmpdir(), 'dreamux-outside-'));
    const escape = join(dispatcherDir, 'escape');
    symlinkSync(outside, escape);
    const { provider, processes } = buildProvider(fake, {
      dispatcherCwd: dispatcherDir,
    });
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
      // No codex process was ever constructed for the rejected task.
      expect(processes).toHaveLength(0);
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows a symlinked target that still resolves inside the dispatcher dir', async () => {
    fake = await startFakeCodex({ replyFor: () => 'inside ok' });
    const dispatcherDir = mkdtempSync(join(tmpdir(), 'dreamux-disp-'));
    const realSub = join(dispatcherDir, 'real-sub');
    mkdirSync(realSub);
    const link = join(dispatcherDir, 'linked');
    symlinkSync(realSub, link); // resolves to <dispatcherDir>/real-sub — inside
    const recorder = recordingCallbacks();
    const { provider } = buildProvider(fake, { dispatcherCwd: dispatcherDir });
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

  it('reports a failure when the connection drops before the turn completes', async () => {
    fake = await startFakeCodex({ turnDelayMs: 5000 });
    const { ledger, execution } = buildExecHarness(fake);
    const taskId = await acceptTask(ledger, 'long task');

    const outcome = await execution.execute({ dispatcherId: DISPATCHER, taskId });
    expect(outcome.status).toBe('running');

    // Drop the codex connection mid-turn; the running task must fail.
    await fake.close();
    fake = null;
    const terminal = await waitForTerminal(ledger, taskId);
    expect(terminal).toBe('failed');
    const task = await ledger.getTask(taskId);
    expect(task?.result?.text).toContain('connection closed');
  });
});
