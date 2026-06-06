import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  TeamMateTaskLedger,
  TeamMateTaskTransitionError,
} from '../src/teammate/ledger.js';
import { TeamMateDeliveryService } from '../src/teammate/delivery.js';
import { DispatcherRuntime } from '../src/dispatcher/runtime.js';
import { DispatcherStore } from '../src/runtime/dispatcher-store.js';
import { resetRuntimeConfig } from '../src/runtime/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import type {
  InboundDeliveryResult,
  InboundTurnInput,
} from '../src/dispatcher/turn-manager.js';
import type {
  AgentRuntime,
  TeamMateCompletionDeliveryResult,
  TeamMateCompletionEnvelope,
} from '../src/agent-runtime/types.js';

/** A fake runtime that only implements the delivery seam, with a scripted plan. */
function deliveryRuntime(
  outcomes: ReadonlyArray<TeamMateCompletionDeliveryResult | Error>,
): AgentRuntime & { calls: TeamMateCompletionEnvelope[] } {
  const calls: TeamMateCompletionEnvelope[] = [];
  let i = 0;
  return {
    calls,
    providerRef: 'builtin:codex',
    start: async () => {},
    stop: async () => {},
    enqueueInbound: async () => ({ status: 'failed', error: new Error('n/a') }),
    injectRestartNotice: async () => {},
    getStatus: () => 'ready',
    getThreadId: () => null,
    wasThreadResumed: () => false,
    async deliverTeamMateCompletion(
      envelope: TeamMateCompletionEnvelope,
    ): Promise<TeamMateCompletionDeliveryResult> {
      calls.push(envelope);
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome as TeamMateCompletionDeliveryResult;
    },
  };
}

/** A runtime that does not expose the delivery capability at all. */
function nonDeliveringRuntime(): AgentRuntime {
  return {
    providerRef: 'builtin:codex',
    start: async () => {},
    stop: async () => {},
    enqueueInbound: async () => ({ status: 'failed', error: new Error('n/a') }),
    injectRestartNotice: async () => {},
    getStatus: () => 'ready',
    getThreadId: () => null,
    wasThreadResumed: () => false,
  };
}

describe('TeamMate completion delivery', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dreamux-tm-delivery-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(home, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(home, { recursive: true, force: true });
  });

  async function acceptedTask(
    ledger: TeamMateTaskLedger,
    taskId = 'tmtsk_1_a',
  ): Promise<void> {
    await ledger.acceptTask({
      title: 'Task',
      prompt: 'do the thing',
      callerKind: 'dispatcher',
      teammateId: 'reviewer-1',
      taskId,
      now: 1000,
    });
  }

  function service(
    runtime: AgentRuntime | null,
    overrides: Partial<{ maxAttempts: number }> = {},
  ): { svc: TeamMateDeliveryService; ledger: TeamMateTaskLedger } {
    const ledger = new TeamMateTaskLedger('flow');
    const svc = new TeamMateDeliveryService({
      ledger: () => ledger,
      resolveRuntime: () => runtime,
      backoffMs: () => 0,
      maxAttempts: overrides.maxAttempts ?? 3,
    });
    return { svc, ledger };
  }

  it('records the result and delivers it on the first attempt', async () => {
    const runtime = deliveryRuntime([{ status: 'accepted' }]);
    const { svc, ledger } = service(runtime);
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'the answer is 42',
    });

    expect(report.status).toBe('delivered');
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]).toMatchObject({
      taskId: 'tmtsk_1_a',
      teammateId: 'reviewer-1',
      status: 'completed',
      finalText: 'the answer is 42',
    });
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.status).toBe('delivered');
    expect(task?.result).toMatchObject({ outcome: 'completed', text: 'the answer is 42' });
    expect(task?.history.map((h) => h.status)).toEqual([
      'accepted',
      'completed',
      'delivered',
    ]);
  });

  it('retries with backoff and succeeds, recording the failed attempt', async () => {
    const runtime = deliveryRuntime([
      { status: 'failed', error: new Error('thread busy') },
      { status: 'accepted' },
    ]);
    const { svc, ledger } = service(runtime);
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'done',
    });

    expect(report.status).toBe('delivered');
    expect(runtime.calls).toHaveLength(2);
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.status).toBe('delivered');
    expect(task?.delivery?.attempts).toBe(2);
  });

  it('exhausts bounded retries to delivery_failed; the result stays pull-able', async () => {
    const runtime = deliveryRuntime([{ status: 'failed', error: new Error('down') }]);
    const { svc, ledger } = service(runtime, { maxAttempts: 2 });
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'retained result',
    });

    expect(report.status).toBe('delivery_failed');
    expect(runtime.calls).toHaveLength(2);
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.status).toBe('delivery_failed');
    expect(task?.delivery?.attempts).toBe(2);
    expect(task?.delivery?.last_error).toContain('down');
    // The whole point of the pull path: the result survives delivery failure.
    expect(task?.result?.text).toBe('retained result');
  });

  it('treats a runtime that is not running as a delivery failure (result retained)', async () => {
    const { svc, ledger } = service(null, { maxAttempts: 1 });
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'kept safe',
    });

    expect(report.status).toBe('delivery_failed');
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.status).toBe('delivery_failed');
    expect(task?.result?.text).toBe('kept safe');
    expect(task?.delivery?.last_error).toContain('not running');
  });

  it('treats a runtime without the delivery capability as delivery_failed', async () => {
    const { svc, ledger } = service(nonDeliveringRuntime(), { maxAttempts: 1 });
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'x',
    });
    expect(report.status).toBe('delivery_failed');
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.delivery?.last_error).toContain('does not support');
  });

  it('delivers a failed-outcome task (the failure is the delivered context)', async () => {
    const runtime = deliveryRuntime([{ status: 'accepted' }]);
    const { svc, ledger } = service(runtime);
    await acceptedTask(ledger);

    const report = await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'failed',
      finalText: 'the teammate could not finish: ...',
    });

    expect(report.status).toBe('delivered');
    expect(runtime.calls[0]?.status).toBe('failed');
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.status).toBe('delivered');
    expect(task?.result?.outcome).toBe('failed');
  });

  it('Codex delivery uses a fresh dedup id per attempt and never reports a failed submit as delivered', async () => {
    // Regression guard: the turn manager commits its dedup id before turn/start
    // and does not roll it back on failure. A retry that reused one id would
    // come back `duplicate` and be mis-counted as delivered. Each attempt must
    // use a fresh id so a failed submit stays `failed`.
    const store = new DispatcherStore(
      testDreamuxConfig([testDispatcherConfig({ id: 'flow' })]),
    );
    const row = store.get('flow');
    expect(row).not.toBeNull();
    const runtime = new DispatcherRuntime(row!, { dispatchers: store });

    const ids: Array<string | null> = [];
    (
      runtime as unknown as {
        enqueueInbound: (input: InboundTurnInput) => Promise<InboundDeliveryResult>;
      }
    ).enqueueInbound = async (input) => {
      ids.push(input.source_message_id);
      return { status: 'failed', error: new Error('turn/start failed') };
    };

    const envelope: TeamMateCompletionEnvelope = {
      taskId: 'tmtsk_1_a',
      teammateId: 'r',
      status: 'completed',
      finalText: 'x',
    };
    const first = await runtime.deliverTeamMateCompletion(envelope);
    const second = await runtime.deliverTeamMateCompletion(envelope);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed'); // NOT 'accepted' via a duplicate hit
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toContain('tmtsk_1_a');
  });

  it('rejects a duplicate completion report (idempotency / same-task race guard)', async () => {
    const runtime = deliveryRuntime([{ status: 'accepted' }]);
    const { svc, ledger } = service(runtime);
    await acceptedTask(ledger);

    await svc.reportCompletion({
      dispatcherId: 'flow',
      taskId: 'tmtsk_1_a',
      outcome: 'completed',
      finalText: 'first',
    });
    await expect(
      svc.reportCompletion({
        dispatcherId: 'flow',
        taskId: 'tmtsk_1_a',
        outcome: 'completed',
        finalText: 'second',
      }),
    ).rejects.toThrow(TeamMateTaskTransitionError);
    // The original delivered result is untouched.
    const task = await ledger.getTask('tmtsk_1_a');
    expect(task?.result?.text).toBe('first');
  });
});
