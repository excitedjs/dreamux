import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeDurableSubmissionInput,
  AgentRuntimeDurableSubmissionRecord,
  AgentRuntimeDurableTaskSubmissions,
} from '@excitedjs/dreamux-types';

import {
  canonicalTaskIdentity,
  durableSubmissionInputDigest,
  taskOperationId,
} from '../src/service/channel-task-host/identity.js';
import { RuntimeSubmissionIndex } from '../src/service/channel-task-host/runtime-submission-index.js';
import { TaskRuntimeExecutor } from '../src/service/channel-task-host/runtime-execution.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import type { TaskTargetClaimInput } from '../src/service/channel-task-host/types.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { applyTestTaskManifest, testTaskContainer } from './helpers/task-host.js';

describe('durable task runtime submission recovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-runtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('derives stable operation ids from every identity component', () => {
    const rootOperation = operationId('root', null, 'root', 0);
    expect(operationId('root', null, 'root', 0)).toBe(rootOperation);
    expect(operationId('completion', rootOperation, 'tool-a', 0)).not.toBe(
      operationId('spawn', rootOperation, 'tool-a', 0),
    );
    expect(operationId('send', rootOperation, 'tool-a', 0)).not.toBe(
      operationId('send', rootOperation, 'tool-a', 1),
    );
    expect(operationId('send', rootOperation, 'tool-a', 0)).not.toBe(
      operationId('send', rootOperation, 'tool-b', 0),
    );
  });

  it('commits one operation intent under concurrent identical calls', async () => {
    const store = await readyStore(root);
    const target = store.list()[0]!;
    const index = new RuntimeSubmissionIndex(store);
    const operation = operationId('send', 'parent', 'tool-a', 3);
    const delivery = { kind: 'text' as const, input: { text: 'next' } };
    const intent = {
      targetId: target.target_id,
      kind: 'send' as const,
      operationId: operation,
      inputDigest: durableSubmissionInputDigest(delivery),
      parentOperationId: 'parent',
      toolCallId: 'tool-a',
      toolCallOrdinal: 3,
      runtimeId: 'leader-runtime',
      runtimeRole: 'leader' as const,
      durabilityNamespace: 'namespace-a',
      delivery,
      effect: { kind: 'send' as const, teammate_name: null, intent: null },
    };

    const [left, right] = await Promise.all([
      index.recordIntent(intent),
      index.recordIntent(intent),
    ]);
    expect(left.operation_id).toBe(operation);
    expect(right.operation_id).toBe(operation);
    expect(store.get(target.target_id)?.submissions).toHaveLength(1);
    expect(
      store.replay(0, 500).events.filter(
        (event) => event.payload.kind === 'resource.lifecycle' &&
          event.payload.resource.kind === 'turn',
      ),
    ).toHaveLength(1);

    await expect(index.recordIntent({
      ...intent,
      inputDigest: durableSubmissionInputDigest({ text: 'different' }),
    })).rejects.toThrow(/reused for a different task submission/);
  });

  it('submits once, recovers settlement, and persists settlement ACK', async () => {
    let store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    let executor = executorFor(store, runtime);
    const targetId = store.list()[0]!.target_id;

    await executor.executeRoot(targetId);
    await executor.executeRoot(targetId);
    expect(runtime.submitCount).toBe(1);
    expect(store.get(targetId)).toMatchObject({
      phase: 'running',
      submission_view: { quiescent: false },
      submissions: [{ state: 'accepted', turn_id: 'turn-1' }],
    });

    runtime.settleFirst('completed', 'result text');
    await executor.reconcileExisting(targetId);
    expect(runtime.acknowledgeCount).toBe(1);
    expect(store.get(targetId)).toMatchObject({
      submission_view: { active_operation_ids: [], quiescent: true },
      submissions: [{
        state: 'settled',
        settlement: { revision: 2, status: 'completed', result: 'result text' },
        settlement_acknowledged_revision: 2,
      }],
    });

    store = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/dreamux-task-channel',
      rootDir: root,
    });
    executor = executorFor(store, runtime);
    await executor.reconcileExisting(targetId);
    expect(runtime.submitCount).toBe(1);
    expect(runtime.acknowledgeCount).toBe(1);
  });

  it('recovers a committed intent before performing the runtime side effect', async () => {
    const store = await readyStore(root);
    const target = store.list()[0]!;
    const operation = operationId('root', null, 'root', 0, target.target_id);
    await new RuntimeSubmissionIndex(store).recordIntent({
      targetId: target.target_id,
      kind: 'root',
      operationId: operation,
      inputDigest: durableSubmissionInputDigest({
        kind: 'channel',
        input: target.turn,
      }),
      parentOperationId: null,
      toolCallId: 'root',
      toolCallOrdinal: 0,
      runtimeId: 'leader-runtime',
      runtimeRole: 'leader',
      durabilityNamespace: 'namespace-a',
      delivery: { kind: 'channel', input: target.turn! },
      effect: { kind: 'root' },
    });
    const runtime = new DurableRuntime('namespace-a');

    await executorFor(store, runtime).reconcileExisting(target.target_id);
    expect(runtime.submitCount).toBe(1);
    expect(store.get(target.target_id)?.submissions[0]).toMatchObject({
      operation_id: operation,
      state: 'accepted',
    });
  });

  it('never submits a persisted intent after task cancellation', async () => {
    const store = await readyStore(root);
    const target = store.list()[0]!;
    const operation = operationId('root', null, 'root', 0, target.target_id);
    await new RuntimeSubmissionIndex(store).recordIntent({
      targetId: target.target_id,
      kind: 'root',
      operationId: operation,
      inputDigest: durableSubmissionInputDigest({
        kind: 'channel',
        input: target.turn,
      }),
      parentOperationId: null,
      toolCallId: 'root',
      toolCallOrdinal: 0,
      runtimeId: null,
      runtimeRole: 'leader',
      durabilityNamespace: null,
      delivery: { kind: 'channel', input: target.turn! },
      effect: { kind: 'root' },
    });
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    const runtime = new DurableRuntime('namespace-a');

    await executorFor(store, runtime).reconcileExisting(target.target_id);
    expect(runtime.submitCount).toBe(0);
    expect(store.get(target.target_id)?.submissions[0]?.state).toBe('intent');
  });

  it('fails closed when the runtime durability namespace changes', async () => {
    const store = await readyStore(root);
    const target = store.list()[0]!;
    const operation = operationId('root', null, 'root', 0, target.target_id);
    await new RuntimeSubmissionIndex(store).recordIntent({
      targetId: target.target_id,
      kind: 'root',
      operationId: operation,
      inputDigest: durableSubmissionInputDigest({
        kind: 'channel',
        input: target.turn,
      }),
      parentOperationId: null,
      toolCallId: 'root',
      toolCallOrdinal: 0,
      runtimeId: 'leader-runtime',
      runtimeRole: 'leader',
      durabilityNamespace: 'old-namespace',
      delivery: { kind: 'channel', input: target.turn! },
      effect: { kind: 'root' },
    });
    const runtime = new DurableRuntime('new-namespace');

    await executorFor(store, runtime).reconcileExisting(target.target_id);
    expect(runtime.submitCount).toBe(0);
    expect(store.get(target.target_id)).toMatchObject({
      phase: 'blocked',
      blocked: { code: 'TASK_SUBMISSION_IN_DOUBT', retryable: false },
      submissions: [{ state: 'in_doubt' }],
    });
  });

  it('marks a persisted intent in-doubt when runtime capability disappears', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    vi.spyOn(runtime, 'getCapabilities').mockReturnValue({
      resume: { supported: false },
    });
    const executor = executorFor(store, runtime);
    const targetId = store.list()[0]!.target_id;

    await expect(executor.executeRoot(targetId)).rejects.toMatchObject({
      name: 'TaskRuntimeCapabilityUnavailableError',
    });
    expect(store.get(targetId)).toMatchObject({
      submissions: [{ state: 'intent' }],
    });

    await executor.reconcileExisting(targetId);
    expect(runtime.submitCount).toBe(0);
    expect(store.get(targetId)).toMatchObject({
      phase: 'blocked',
      blocked: { code: 'TASK_SUBMISSION_IN_DOUBT', retryable: false },
      submissions: [{ state: 'in_doubt' }],
    });
  });

  it('rejects a non-durable child runtime before intent or identity side effects', async () => {
    const prepareSpawn = vi.fn();
    const dispatcher = testDispatcherConfig({
      id: 'dispatcher-a',
      agentRuntime: 'non-durable-runtime',
      runtimeProvider: 'npm:@example/non-durable-runtime',
    });
    const collection = new TeammateCollection({
      dispatcherId: 'dispatcher-a',
      teamScope: 'task-team-a',
      config: testDreamuxConfig([dispatcher]),
      agentRuntimeProviders: {
        resolve: () => ({
          getCapabilities: () => ({ resume: { supported: false } }),
        }),
      } as unknown as AgentRuntimeProviderCatalog,
      worktrees: {} as never,
      identities: {} as never,
      turnsStore: {} as never,
      taskSubmissionBridge: {
        prepareSpawn,
        prepareSend: vi.fn(),
        submitPrepared: vi.fn(),
        observeSettlement: vi.fn(),
      } as never,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    });

    await expect(collection.spawn({
      name: 'worker',
      prompt: 'child task',
      agentRuntime: 'non-durable-runtime',
      intent: 'child task',
      sharedWorkspace: {
        sourceCwd: '/repo',
        sourceRepo: '/repo',
        runtimeCwd: '/worktree',
        worktree: {
          mode: 'managed',
          slug: 'task-worktree',
          path: '/worktree',
          branch: 'dreamux/task-worktree',
          base_ref: null,
          cleanup: 'delete-on-close',
          cleanup_state: 'managed-active',
          cleanup_error: null,
        },
      },
      taskInvocation: {
        parentOperationId: 'parent-operation',
        callId: 'spawn-call',
        ordinal: 0,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
      },
    })).rejects.toMatchObject({ name: 'TaskRuntimeCapabilityUnavailableError' });
    expect(prepareSpawn).not.toHaveBeenCalled();
  });

  it('bounds an ambiguous submit call and persists an in-doubt outcome', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    vi.spyOn(runtime.durableTaskSubmissions, 'submitOnce')
      .mockImplementation(() => new Promise(() => {}));
    const executor = executorFor(
      store,
      runtime,
      runtime,
      () => {},
      async (_targetId, task) => task(),
      5,
    );
    const targetId = store.list()[0]!.target_id;

    await executor.executeRoot(targetId);
    expect(store.get(targetId)).toMatchObject({
      phase: 'blocked',
      blocked: { code: 'TASK_SUBMISSION_IN_DOUBT', retryable: false },
      submissions: [{ state: 'in_doubt' }],
    });
  });

  it('rejects malformed runtime receipts without publishing acceptance', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    runtime.malformedRevision = true;
    const targetId = store.list()[0]!.target_id;

    await expect(executorFor(store, runtime).executeRoot(targetId)).rejects.toThrow(
      /invalid durable submission record/,
    );
    expect(store.get(targetId)).toMatchObject({
      submissions: [{ state: 'intent', turn_id: null }],
    });
    const snapshot = store.snapshot();
    expect(snapshot.status).toBe('page');
    if (snapshot.status !== 'page') throw new Error('snapshot unavailable');
    expect(snapshot.page.items[0]?.resources.find(
      (resource) => resource.kind === 'turn',
    )).toEqual(expect.objectContaining({ state: 'submitted' }));
  });

  it('deduplicates stable tool operations and fences parent identity before effects', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    const executor = executorFor(store, runtime);
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;
    const invocation = {
      callId: 'tool-call-a',
      ordinal: 2,
      parentOperationId: parent.operation_id,
      runtimeId: 'leader-runtime',
      durabilityNamespace: 'namespace-a',
    };
    const first = await executor.prepareSend({
      teamId: target.team.team_name,
      invocation,
      prompt: 'Continue the task',
      intent: 'continue',
      runtimeRole: 'leader',
      teammateName: null,
    });
    const duplicate = await executor.prepareSend({
      teamId: target.team.team_name,
      invocation,
      prompt: 'Continue the task',
      intent: 'continue',
      runtimeRole: 'leader',
      teammateName: null,
    });
    expect(duplicate.operationId).toBe(first.operationId);
    await executor.submitPrepared(target.team.team_name, first);
    await executor.submitPrepared(target.team.team_name, duplicate);
    expect(runtime.submitCount).toBe(2);
    expect(store.get(target.target_id)?.submissions).toHaveLength(2);

    await expect(executor.prepareSend({
      teamId: target.team.team_name,
      invocation,
      prompt: 'Conflicting retry body',
      intent: 'continue',
      runtimeRole: 'leader',
      teammateName: null,
    })).rejects.toThrow(/reused for a different task submission/);
    await expect(executor.prepareSend({
      teamId: target.team.team_name,
      invocation: { ...invocation, durabilityNamespace: 'wrong-namespace' },
      prompt: 'Must not persist',
      intent: null,
      runtimeRole: 'leader',
      teammateName: null,
    })).rejects.toThrow(/matching durable parent turn/);
    expect(store.get(target.target_id)?.submissions).toHaveLength(2);
  });

  it('rejects an operation intent when terminal wins the concurrent store race', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    const executor = executorFor(store, runtime);
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;
    const entered = deferred();
    const release = deferred();
    const updateTarget = store.updateTarget.bind(store);
    let intercept = true;
    vi.spyOn(store, 'updateTarget').mockImplementation(async (...args) => {
      if (intercept) {
        intercept = false;
        entered.resolve();
        await release.promise;
      }
      return updateTarget(...args);
    });

    const preparing = executor.prepareSend({
      teamId: target.team.team_name,
      invocation: {
        callId: 'racing-tool-call',
        ordinal: 0,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
      },
      prompt: 'Must not become durable after terminal',
      intent: null,
      runtimeRole: 'leader',
      teammateName: null,
    });
    void preparing.catch(() => {});
    await entered.promise;
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    release.resolve();

    await expect(preparing).rejects.toThrow(/already terminal/);
    expect(store.get(target.target_id)?.submissions).toHaveLength(1);
    expect(runtime.submitCount).toBe(1);
  });

  it('fences a prepared runtime side effect behind a winning cancel', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    const lifecycle = new KeyedAsyncQueue();
    const executor = executorFor(
      store,
      runtime,
      runtime,
      () => {},
      (targetId, task) => lifecycle.run(targetId, task),
    );
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;
    const prepared = await executor.prepareSend({
      teamId: target.team.team_name,
      invocation: {
        callId: 'prepared-before-cancel',
        ordinal: 0,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
      },
      prompt: 'Prepared but not submitted',
      intent: null,
      runtimeRole: 'leader',
      teammateName: null,
    });
    const entered = deferred();
    const release = deferred();
    const held = lifecycle.run(target.target_id, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const cancelling = lifecycle.run(target.target_id, () => store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    }));
    const submitting = executor.submitPrepared(target.team.team_name, prepared);
    void submitting.catch(() => {});
    release.resolve();
    await held;
    await cancelling;

    await expect(submitting).rejects.toThrow(/already terminal/);
    expect(runtime.submitCount).toBe(1);
    expect(store.get(target.target_id)?.submissions).toMatchObject([
      { kind: 'root', state: 'accepted' },
      { kind: 'send', state: 'intent' },
    ]);
  });

  it('drains a prepared intent after a completed business terminal', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    const executor = executorFor(store, runtime);
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;
    const prepared = await executor.prepareSend({
      teamId: target.team.team_name,
      invocation: {
        callId: 'prepared-before-finish',
        ordinal: 0,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
      },
      prompt: 'Persisted before the business terminal',
      intent: null,
      runtimeRole: 'leader',
      teammateName: null,
    });
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'completed', summary: 'business result' },
    });

    await expect(executor.submitPrepared(target.team.team_name, prepared))
      .resolves.toMatchObject({ status: 'submitted' });
    const operations = store.get(target.target_id)!.submissions;
    for (const operation of operations) {
      runtime.settle(operation.operation_id, 'completed', 'runtime result');
    }
    await executor.reconcileExisting(target.target_id);

    expect(store.get(target.target_id)).toMatchObject({
      terminal: { outcome: 'completed' },
      submission_view: { active_operation_ids: [], quiescent: true },
      submissions: [{ state: 'settled' }, { state: 'settled' }],
    });
  });

  it('reserves terminal WAL capacity when an operation intent is too large', async () => {
    const store = await readyStore(root);
    const runtime = new DurableRuntime('namespace-a');
    const executor = executorFor(store, runtime);
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;

    await expect(executor.prepareSend({
      teamId: target.team.team_name,
      invocation: {
        callId: 'oversized-operation',
        ordinal: 0,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
      },
      prompt: 'x'.repeat(3 * 1024 * 1024 + 128 * 1024),
      intent: null,
      runtimeRole: 'leader',
      teammateName: null,
    })).rejects.toMatchObject({ name: 'TaskHostBackpressureError' });
    expect(runtime.submitCount).toBe(1);
    expect(store.get(target.target_id)?.submissions).toHaveLength(1);
    await expect(store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'failed', summary: 'operation capacity exhausted' },
    })).resolves.toMatchObject({ changed: true });
  });

  it('reserves enough target capacity for every accepted maximum settlement', async () => {
    const store = await readyStore(root);
    const target = store.list()[0]!;
    const index = new RuntimeSubmissionIndex(store);
    const operations: Array<{ operationId: string; inputDigest: string }> = [];

    for (let ordinal = 0; ordinal < 200; ordinal += 1) {
      const operationId = operationIdForCapacity(target.target_id, ordinal);
      const delivery = {
        kind: 'text' as const,
        input: { sourceId: `task:${operationId}`, text: `operation-${ordinal}` },
      };
      const inputDigest = durableSubmissionInputDigest(delivery);
      try {
        await index.recordIntent({
          targetId: target.target_id,
          kind: 'send',
          operationId,
          inputDigest,
          parentOperationId: 'capacity-parent',
          toolCallId: `capacity-call-${ordinal}`,
          toolCallOrdinal: ordinal,
          runtimeId: null,
          runtimeRole: 'member',
          durabilityNamespace: null,
          delivery,
          effect: { kind: 'send', teammate_name: 'capacity-worker', intent: null },
        });
        operations.push({ operationId, inputDigest });
      } catch (error) {
        expect(error).toMatchObject({ name: 'TaskHostBackpressureError' });
        break;
      }
    }
    expect(operations.length).toBeGreaterThan(1);
    expect(operations.length).toBeLessThan(200);

    const maximumResult = '\0'.repeat(64 * 1024);
    for (const [indexValue, operation] of operations.entries()) {
      await index.bindRuntime({
        targetId: target.target_id,
        operationId: operation.operationId,
        runtimeId: 'member-runtime',
        runtimeRole: 'member',
        durabilityNamespace: 'namespace-a',
      });
      await index.recordAccepted({
        targetId: target.target_id,
        operationId: operation.operationId,
        runtime: {
          operation_id: operation.operationId,
          input_digest: operation.inputDigest,
          turn_id: `capacity-turn-${indexValue}`,
          revision: 1,
          settlement: null,
          settlement_acknowledged_revision: 0,
        },
      });
    }
    for (const operation of operations) {
      await expect(index.recordSettlement({
        targetId: target.target_id,
        operationId: operation.operationId,
        settlement: {
          revision: 2,
          status: 'completed',
          result: maximumResult,
        },
      })).resolves.toMatchObject({ state: 'settled' });
      await index.recordSettlementAcknowledged({
        targetId: target.target_id,
        operationId: operation.operationId,
        revision: 2,
      });

      const completionId = operationId(
        'completion',
        operation.operationId,
        'member-completion',
        0,
        target.target_id,
      );
      const completionDelivery = {
        kind: 'text' as const,
        input: { sourceId: `task:${completionId}`, text: maximumResult },
      };
      const completionDigest = durableSubmissionInputDigest(completionDelivery);
      await index.recordIntent({
        targetId: target.target_id,
        kind: 'completion',
        operationId: completionId,
        inputDigest: completionDigest,
        parentOperationId: operation.operationId,
        toolCallId: 'member-completion',
        toolCallOrdinal: 0,
        runtimeId: null,
        runtimeRole: 'leader',
        durabilityNamespace: null,
        delivery: completionDelivery,
        effect: {
          kind: 'completion',
          source_operation_id: operation.operationId,
        },
      });
      await index.bindRuntime({
        targetId: target.target_id,
        operationId: completionId,
        runtimeId: 'leader-runtime',
        runtimeRole: 'leader',
        durabilityNamespace: 'namespace-a',
      });
      await index.recordAccepted({
        targetId: target.target_id,
        operationId: completionId,
        runtime: {
          operation_id: completionId,
          input_digest: completionDigest,
          turn_id: `completion-${operation.operationId}`,
          revision: 1,
          settlement: null,
          settlement_acknowledged_revision: 0,
        },
      });
      await index.recordSettlement({
        targetId: target.target_id,
        operationId: completionId,
        settlement: {
          revision: 2,
          status: 'completed',
          result: maximumResult,
        },
      });
      await index.recordSettlementAcknowledged({
        targetId: target.target_id,
        operationId: completionId,
        revision: 2,
      });
    }
    expect(store.get(target.target_id)?.submission_view.quiescent).toBe(true);
  });

  it('retries an early settlement signal and creates one durable child completion', async () => {
    const store = await readyStore(root);
    const leader = new DurableRuntime('leader-namespace');
    const member = new DurableRuntime('member-namespace');
    let progressCount = 0;
    const executor = executorFor(store, leader, member, () => {
      progressCount += 1;
    });
    const target = store.list()[0]!;
    await executor.executeRoot(target.target_id);
    const parent = store.get(target.target_id)!.submissions[0]!;
    const prepared = await executor.prepareSpawn({
      teamId: target.team.team_name,
      invocation: {
        callId: 'spawn-call-a',
        ordinal: 0,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'leader-namespace',
      },
      requestedName: 'worker',
      prompt: 'Handle the child task',
      agentRuntime: 'npm:@example/durable-runtime',
      intent: 'child task',
      identity: null,
      skillSources: [],
    });
    const beforeSubmit = store.snapshot();
    if (beforeSubmit.status !== 'page') throw new Error('snapshot unavailable');
    const provisionalMember = beforeSubmit.page.items[0]?.resources.find(
      (resource) => resource.kind === 'member',
    );
    expect(provisionalMember).toMatchObject({
      kind: 'member',
      state: 'provisioning',
    });
    expect(JSON.stringify(beforeSubmit.page)).not.toContain(prepared.teammateName);
    await executor.submitPrepared(target.team.team_name, prepared);
    const child = store.get(target.target_id)!.submissions.find(
      (submission) => submission.operation_id === prepared.operationId,
    )!;

    await executor.notifySettlement({
      teamId: target.team.team_name,
      runtimeId: 'member-runtime',
      durabilityNamespace: 'member-namespace',
      turnId: child.turn_id!,
    });
    member.settle(prepared.operationId, 'completed', 'child result');
    await waitFor(() => {
      const latest = store.get(target.target_id)!;
      return latest.submissions.some(
        (submission) => submission.kind === 'completion',
      ) && latest.submissions.find(
        (submission) => submission.operation_id === prepared.operationId,
      )?.settlement_acknowledged_revision === 2 && progressCount === 1;
    });

    const submissions = store.get(target.target_id)!.submissions;
    expect(submissions.filter((submission) => submission.kind === 'completion'))
      .toHaveLength(1);
    expect(member.acknowledgeCount).toBe(1);
    expect(leader.submitCount).toBe(2);
    expect(progressCount).toBe(1);

    await executor.prepareSend({
      teamId: target.team.team_name,
      invocation: {
        callId: 'member-send-call',
        ordinal: 1,
        parentOperationId: parent.operation_id,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'leader-namespace',
      },
      prompt: 'Continue the child task',
      intent: null,
      runtimeRole: 'member',
      teammateName: prepared.teammateName,
    });
    const afterSend = store.snapshot();
    if (afterSend.status !== 'page') throw new Error('snapshot unavailable');
    const members = afterSend.page.items[0]?.resources.filter(
      (resource) => resource.kind === 'member',
    ) ?? [];
    expect(members).toHaveLength(1);
    expect(members[0]?.resource_id).toBe(provisionalMember?.resource_id);
    expect(members[0]?.state).toBe('ready');
    expect(JSON.stringify(afterSend.page)).not.toContain(prepared.teammateName);
    expect(JSON.stringify(afterSend.page)).not.toContain('member-runtime');

    const reopened = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/dreamux-task-channel',
      rootDir: root,
    });
    const recovered = reopened.snapshot();
    if (recovered.status !== 'page') throw new Error('snapshot unavailable');
    expect(recovered.page.items[0]?.resources.map((resource) => resource.resource_id))
      .toEqual(afterSend.page.items[0]?.resources.map(
        (resource) => resource.resource_id,
      ));
    executor.stop();
  });
});

class DurableRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/durable-runtime';
  readonly records = new Map<string, AgentRuntimeDurableSubmissionRecord>();
  submitCount = 0;
  acknowledgeCount = 0;
  malformedRevision = false;

  readonly durableTaskSubmissions: AgentRuntimeDurableTaskSubmissions;

  constructor(namespace: string) {
    this.durableTaskSubmissions = {
      namespace,
      submitOnce: (input) => this.submitOnce(input),
      lookupSubmission: async (operationId) => {
        const submission = this.records.get(operationId);
        return submission === undefined
          ? { status: 'absent' as const }
          : { status: 'found' as const, submission: structuredClone(submission) };
      },
      acknowledgeSettlement: async (input) => {
        this.acknowledgeCount += 1;
        const submission = this.records.get(input.operation_id);
        if (submission === undefined) throw new Error('unknown operation');
        submission.settlement_acknowledged_revision = input.settlement_revision;
        return { acknowledged_revision: input.settlement_revision };
      },
    };
  }

  private async submitOnce(input: AgentRuntimeDurableSubmissionInput) {
    const existing = this.records.get(input.operation_id);
    if (existing !== undefined) {
      return { status: 'accepted' as const, submission: structuredClone(existing) };
    }
    this.submitCount += 1;
    const submission: AgentRuntimeDurableSubmissionRecord = {
      operation_id: input.operation_id,
      input_digest: input.input_digest,
      turn_id: `turn-${this.submitCount}`,
      revision: this.malformedRevision ? Number.NaN : 1,
      settlement: null,
      settlement_acknowledged_revision: 0,
    };
    this.records.set(input.operation_id, submission);
    return { status: 'accepted' as const, submission: structuredClone(submission) };
  }

  settleFirst(status: 'completed' | 'failed' | 'stopped', result: string): void {
    const submission = this.records.values().next().value;
    if (submission === undefined) throw new Error('no submitted operation');
    submission.revision = 2;
    submission.settlement = { revision: 2, status, result };
  }

  settle(
    operationId: string,
    status: 'completed' | 'failed' | 'stopped',
    result: string,
  ): void {
    const submission = this.records.get(operationId);
    if (submission === undefined) throw new Error('unknown submitted operation');
    submission.revision = 2;
    submission.settlement = { revision: 2, status, result };
  }

  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> {}
  async channelInput() { return { status: 'submitted' as const, turnId: 'legacy' }; }
  async completionInput() { return { status: 'submitted' as const, turnId: 'legacy' }; }
  getStatus() { return 'ready' as const; }
  getCheckpoint() { return null; }
  wasCheckpointResumed() { return false; }
  async getLast() { return null; }
  async getContext() { return null; }
  getCapabilities(): AgentRuntimeCapabilities {
    return {
      resume: { supported: false },
      durableTaskSubmission: {
        supported: true as const,
        protocol: 'durable_task_submission_v1' as const,
      },
      durableTaskToolInvocation: {
        supported: true as const,
        protocol: 'durable_task_mcp_invocation_v1' as const,
      },
    };
  }
}

function executorFor(
  store: TaskHostStore,
  runtime: AgentRuntime,
  memberRuntime: AgentRuntime = runtime,
  onSettlementProgress: (targetId: string) => void = () => {},
  runExclusive: <T>(targetId: string, task: () => Promise<T>) => Promise<T> =
    async (_targetId, task) => task(),
  runtimeCallTimeoutMs?: number,
): TaskRuntimeExecutor {
  const teams = {
    get: async () => ({
      durableTaskRuntime: async () => ({
        runtime,
        runtimeId: 'leader-runtime',
        role: 'leader' as const,
      }),
      ensureTaskSubmissionRuntime: async (input: { runtimeRole: 'leader' | 'member' }) =>
        input.runtimeRole === 'leader'
          ? {
              runtime,
              runtimeId: 'leader-runtime',
              role: 'leader' as const,
            }
          : {
              runtime: memberRuntime,
              runtimeId: 'member-runtime',
              role: 'member' as const,
            },
    }),
  } as unknown as TeamCollection;
  const sink = () => {};
  return new TaskRuntimeExecutor({
    store,
    teams,
    log: { error: sink, warn: sink, info: sink, debug: sink, trace: sink },
    runExclusive,
    onSettlementProgress,
    settlementRetryDelayMs: () => 1,
    ...(runtimeCallTimeoutMs !== undefined ? { runtimeCallTimeoutMs } : {}),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for settlement');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readyStore(rootDir: string): Promise<TaskHostStore> {
  const store = await TaskHostStore.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    providerRef: 'npm:@example/dreamux-task-channel',
    rootDir,
  });
  const claim = taskClaim();
  await applyTestTaskManifest(store, [testTaskContainer('space-a')]);
  await store.claim(claim);
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'provisioning';
    },
    [{ payload: { kind: 'task.lifecycle', phase: 'provisioning' } }],
  );
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'binding_resolved';
      target.binding = {
        space_name: 'space-a',
        generation: 1,
        repository: structuredClone(target.resolved_repository!),
        leader_agent_runtime: 'leader-runtime',
        identity: null,
      };
    },
    [{ payload: { kind: 'task.lifecycle', phase: 'binding_resolved' } }],
  );
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'ready';
      target.team.leader_name = 'task-leader';
    },
    [{
      payload: {
        kind: 'resource.lifecycle',
        resource: {
          kind: 'team',
          resource_id: 'thr_test_team',
          revision: 1,
          state: 'ready',
        },
      },
    }],
  );
  return store;
}

function taskClaim(): TaskTargetClaimInput {
  const attempt = { task_key: 'task-a', attempt_key: 'attempt-1' };
  const identity = canonicalTaskIdentity({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    containerType: 'task-space',
    containerKey: 'space-a',
    attempt,
  });
  return {
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: 'npm:@example/dreamux-task-channel',
    targetId: identity.targetId,
    canonicalTargetKey: identity.targetKey,
    attempt,
    container: { container_type: 'task-space', container_key: 'space-a' },
    manifestRevision: 1,
    containerGeneration: 1,
    logicalRepository: { repository_key: 'repository-a' },
    resolvedRepository: {
      source: 'channel',
      logical_key: 'repository-a',
      binding_revision: 'revision-1',
      fingerprint: 'fingerprint-1',
      repo_cwd: '/tmp/example-repository',
      base_ref: null,
      base_commit: '0000000000000000000000000000000000000000',
    },
    requestFingerprint: 'request-fingerprint',
    receipt: {
      receipt_id: identity.receiptId,
      target_id: identity.targetId,
      attempt,
      revision: 1,
      accepted_at: 1,
      manifest_revision: 1,
      container_generation: 1,
    },
    title: 'Task A',
    turn: { sourceId: 'delivery-a', text: 'Execute task A' },
    teamName: identity.teamName,
    worktreeSlug: identity.worktreeSlug,
    routeClaimId: identity.routeClaimId,
  };
}

function operationId(
  kind: 'root' | 'completion' | 'spawn' | 'send',
  parentOperationId: string | null,
  toolCallId: string,
  ordinal: number,
  targetId = 'target-a',
): string {
  return taskOperationId({
    targetId,
    parentOperationId,
    toolCallId,
    toolCallOrdinal: ordinal,
    kind,
  });
}

function operationIdForCapacity(targetId: string, ordinal: number): string {
  return operationId(
    'send',
    'capacity-parent',
    `capacity-call-${ordinal}`,
    ordinal,
    targetId,
  );
}
