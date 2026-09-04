/**
 * Coverage cell E — Workflow half.
 *
 * `WorkflowService`/`WorkflowRun` are driven through the real durable-file
 * boundary (`DREAMUX_ROOT` pointed at a temp dir, real `WorkflowRunStore` +
 * `WorkflowJournal`) with an in-process fake runner standing in for the
 * forked child — see `tests/helpers/workflow-harness.ts` for why.
 */
import { readFile, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CompletionDeliveryPolicy } from '../src/service/completion-router/index.js';
import {
  workflowRunDir,
  workflowRunJournalPath,
  workflowRunRecordPath,
} from '../src/platform/paths.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from '../src/service/workflow-service/agent-policy.js';
import { WorkflowService } from '../src/service/workflow-service/index.js';
import type { WorkflowRunRecord } from '../src/service/workflow-service/types.js';
import type { LockedTeammate } from '../src/service/teammate-service/types.js';
import {
  beginWorkflowRoot,
  controllableLockedTeammate,
  controllableTurn,
  fakeCompletionDelivery,
  fakeCompletionInitiator,
  fakeTeammateFactory,
  fakeWorkflowRunnerFactory,
  fixedRunIds,
  onlyCreateLockedSurface,
  silentLog,
  waitUntil,
  type WorkflowRootState,
} from './helpers/workflow-harness.js';

let root: WorkflowRootState;

beforeEach(async () => {
  root = await beginWorkflowRoot();
});

afterEach(async () => {
  await root.restore();
});

const SCOPE = { dispatcherId: 'dispatcher-1', teamId: null as string | null };

function recordPath(runId: string): string {
  return workflowRunRecordPath({ ...SCOPE, runId });
}

function journalPath(runId: string): string {
  return workflowRunJournalPath({ ...SCOPE, runId });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function writeJournalLines(path: string, lines: readonly unknown[]): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    mode: 0o600,
  });
}

function baseRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    version: 1,
    run_id: 'run-a',
    dispatcher_id: SCOPE.dispatcherId,
    team_id: SCOPE.teamId,
    caller_kind: 'dispatcher',
    script_hash: 'hash',
    status: 'running',
    max_concurrency: 4,
    phase: null,
    last_log: null,
    agents: [],
    result: null,
    error: null,
    created_at: 1,
    updated_at: 1,
    ended_at: null,
    ...overrides,
  };
}

function neverCreateRunner(): never {
  throw new Error(
    'createRunner must not be called: start() reads committed durable facts only, it never resurrects a runner',
  );
}

describe('WorkflowService.start() reads committed durable facts only', () => {
  it('converges a running record with no committed terminal journal to stopped, backfilling the journal, without creating a runner', async () => {
    await writeJson(recordPath('run-a'), baseRecord({
      agents: [
        {
          index: 0,
          name: 'agent-1',
          label: null,
          phase: null,
          status: 'running',
          result: null,
          error: null,
          created_at: 1,
          settled_at: null,
        },
      ],
    }));
    await writeJournalLines(journalPath('run-a'), [
      {
        kind: 'run',
        version: 1,
        run_id: 'run-a',
        script_hash: 'hash',
        caller: { kind: 'dispatcher' },
        dispatcher_id: SCOPE.dispatcherId,
        team_id: SCOPE.teamId,
        created_at: 1,
      },
    ]);

    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agent should be created during recovery');
      }),
      completionDelivery: fakeCompletionDelivery().policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: neverCreateRunner,
      now: () => 5_000,
    });

    await service.start();

    const status = await service.status({ run_id: 'run-a' });
    expect(status.status).toBe('stopped');
    expect(status.error).toMatch(/Dreamux stopped before the workflow reached a terminal result/);
    expect(status.ended_at).toBe(5_000);
    expect(status.agents[0]?.status).toBe('stopped');
    expect(status.agents[0]?.settled_at).toBe(5_000);

    // Durably written, not only held in memory.
    const onDisk = JSON.parse(await readFile(recordPath('run-a'), 'utf8')) as WorkflowRunRecord;
    expect(onDisk.status).toBe('stopped');

    const journalLines = (await readFile(journalPath('run-a'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; status?: string });
    expect(journalLines.filter((line) => line.kind === 'result')).toEqual([
      expect.objectContaining({ kind: 'result', index: 0, status: 'stopped' }),
    ]);
    expect(journalLines.filter((line) => line.kind === 'end')).toEqual([
      expect.objectContaining({ kind: 'end', status: 'stopped' }),
    ]);
  });

  it('converges a running record whose journal already committed a terminal event, without creating a runner', async () => {
    await writeJson(recordPath('run-a'), baseRecord({
      agents: [
        {
          index: 0,
          name: 'agent-1',
          label: null,
          phase: null,
          status: 'completed',
          result: { answer: 42 },
          error: null,
          created_at: 1,
          settled_at: 2,
        },
      ],
      // Stale: the process crashed after the journal committed the terminal
      // event but before the record.json write landed.
      status: 'running',
      result: null,
      ended_at: null,
    }));
    await writeJournalLines(journalPath('run-a'), [
      {
        kind: 'run',
        version: 1,
        run_id: 'run-a',
        script_hash: 'hash',
        caller: { kind: 'dispatcher' },
        dispatcher_id: SCOPE.dispatcherId,
        team_id: SCOPE.teamId,
        created_at: 1,
      },
      {
        kind: 'result',
        index: 0,
        status: 'completed',
        result: { answer: 42 },
        error: null,
        settled_at: 2,
      },
      {
        kind: 'end',
        status: 'completed',
        result: { answer: 42 },
        error: null,
        ended_at: 3,
      },
    ]);

    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agent should be created during recovery');
      }),
      completionDelivery: fakeCompletionDelivery().policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: neverCreateRunner,
      now: () => 9_999,
    });

    await service.start();

    const status = await service.status({ run_id: 'run-a' });
    expect(status.status).toBe('completed');
    expect(status.result).toEqual({ answer: 42 });
    expect(status.ended_at).toBe(3);
    expect(status.updated_at).toBe(3);
  });

  it('needs no synthesis for an empty scope: start() succeeds and list() is empty, without creating a runner', async () => {
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agent should be created');
      }),
      completionDelivery: fakeCompletionDelivery().policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: neverCreateRunner,
    });

    await service.start();
    expect(await service.list()).toEqual({ runs: [] });
  });
});

describe('journal + terminal settlement: exactly one terminal outcome', () => {
  it('ignores a runner message that arrives after the run is already durably terminal', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agents in this script');
      }),
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a'),
    });

    await service.start();
    const accepted = await service.run({ script: 'noop' });
    expect(accepted.run_id).toBe('run-a');

    const stopped = await service.stop({ run_id: 'run-a' });
    expect(stopped.status).toBe('stopped');

    // A late run_result from a runner that is already being torn down must
    // not reopen or re-terminate an already-terminal run.
    const runner = runnerFactory.runners[0]!;
    runner.emit({ type: 'run_result', status: 'completed', result: { ok: true } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const status = await service.status({ run_id: 'run-a' });
    expect(status.status).toBe('stopped');
    expect(status.result).toBeNull();

    const journalLines = (await readFile(journalPath('run-a'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; status?: string });
    const terminalRows = journalLines.filter((line) => line.kind === 'end');
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]?.status).toBe('stopped');
    expect(delivery.delivered).toHaveLength(1);
  });
});

describe('owner-side exact-instance eviction', () => {
  it('a stale run instance settling late cannot evict a newer live replacement of the same id', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    let deliverCalls = 0;
    let releaseDeliverGate!: () => void;
    const deliverGate = new Promise<void>((resolve) => {
      releaseDeliverGate = resolve;
    });
    const completionDelivery = {
      async deliver() {
        deliverCalls += 1;
        await deliverGate;
      },
    } as unknown as CompletionDeliveryPolicy;

    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agents in this script');
      }),
      completionDelivery,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      // Both runs are forced to the same id; the second create only succeeds
      // once run A's on-disk directory (deleted below) is gone.
      generateRunId: fixedRunIds('run-x', 'run-x'),
    });
    await service.start();

    const acceptedA = await service.run({ script: 'noop' });
    expect(acceptedA.run_id).toBe('run-x');
    const runnerA = runnerFactory.runners[0]!;
    runnerA.emit({ type: 'run_result', status: 'completed', result: null });
    // Run A has reached finalize()'s deliverTerminal call and is now blocked
    // there — durably terminal is not yet true (the record write already
    // landed, but `settled`, and therefore eviction, has not fired).
    await waitUntil(() => deliverCalls >= 1);

    await rm(workflowRunDir({ ...SCOPE, runId: 'run-x' }), { recursive: true, force: true });

    const acceptedB = await service.run({ script: 'noop' });
    expect(acceptedB.run_id).toBe('run-x');
    // B has not reached run_result — it is still live, status 'running'.
    // Delete B's own durable record so the only place a correct answer can
    // come from is the live in-memory instance, never the store.
    await rm(recordPath('run-x'));

    // Release A's blocked delivery. A's `settled` now resolves and the
    // owner's `run.settled.then(() => evict(id, thatInstance))` fires with
    // A's own identity — which must no longer match what the map holds.
    releaseDeliverGate();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // If eviction is exact-instance (correct): B is still the live entry and
    // answers from its own snapshot. If eviction were keyed on run_id alone
    // (bug): A's stale settlement would have deleted 'run-x' from the map,
    // and this call would fall through to the store and throw "does not
    // exist" because B's record.json was deleted above.
    await expect(service.status({ run_id: 'run-x' })).resolves.toMatchObject({
      run_id: 'run-x',
      status: 'running',
    });
  });

  it('WorkflowRun itself never calls an eviction callback — eviction is the Collection/Service concern alone', async () => {
    // Absence-is-the-contract: `WorkflowRunDeps` (run.ts) carries no evict/
    // onSettled-shaped callback member, and nothing in the run's own
    // orchestration files ever calls one — `run.ts`'s own doc comment states
    // the boundary in prose ("the owner reads it to evict"), which this only
    // checks for an actual call/field, not the word appearing in a comment.
    // Only `WorkflowService` (index.ts) performs the exact-instance eviction.
    const { readFile: read } = await import('node:fs/promises');
    for (const file of ['run.ts', 'run-terminal.ts', 'run-support.ts', 'runner-process.ts']) {
      const source = await read(
        new URL(`../src/service/workflow-service/${file}`, import.meta.url),
        'utf8',
      );
      expect(source).not.toMatch(/\bevict\w*\s*[(:]/i);
    }
  });
});

describe('workflow.stop and failure delivery use the null-completion-token entry point', () => {
  it('stop() converges already-accepted work: it waits for a submitted turn to settle before finalizing', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const agent = controllableLockedTeammate('agent-1');
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => agent.handle),
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a'),
    });
    await service.start();
    await service.run({ script: 'noop' });

    const runner = runnerFactory.runners[0]!;
    runner.emit({ type: 'agent_start', index: 0, prompt: 'do it', options: {} });
    await waitUntil(() => agent.submitCalls.length >= 1);

    const turn = controllableTurn();
    agent.admitNext({ status: 'submitted', turn: turn.turn });

    const stopPromise = service.stop({ run_id: 'run-a' });
    let resolved = false;
    void stopPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false); // still converging the accepted turn

    turn.settle({ status: 'completed', resultText: JSON.stringify({ done: true }) });
    const stopResult = await stopPromise;
    expect(stopResult.status).toBe('stopped');

    expect(delivery.delivered).toHaveLength(1);
    expect(delivery.delivered[0]).toMatchObject({ kind: 'workflow', status: 'stopped' });
    expect(delivery.deliverRuntimeCalls).toBe(0); // null-token entry point only
  });

  it('a failed run delivers its failure through the null-completion-token entry point', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agents in this script');
      }),
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a'),
    });
    await service.start();
    await service.run({ script: 'noop' });

    const runner = runnerFactory.runners[0]!;
    runner.emit({ type: 'run_result', status: 'failed', error: 'boom' });
    await waitUntil(() => delivery.delivered.length >= 1);

    expect(delivery.delivered[0]).toMatchObject({ kind: 'workflow', status: 'failed' });
    expect(String(delivery.delivered[0]?.result)).toContain('boom');
    expect(delivery.deliverRuntimeCalls).toBe(0);
  });
});

describe('team-scoped Workflow member creation: a narrow createLocked capability, never a raw collection', () => {
  it('reaches only createLocked on the teammates dependency and holds the lock until terminal cleanup releases it', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const order: string[] = [];
    const turn = controllableTurn();
    const handle: LockedTeammate = {
      name: 'agent-1',
      async submit(input) {
        order.push(`submit:${input.source}`);
        return { status: 'submitted', turn: turn.turn };
      },
      async close(input) {
        order.push(`close:${input.note}`);
        return { teammate: { name: 'agent-1' } } as unknown as Awaited<
          ReturnType<LockedTeammate['close']>
        >;
      },
      unlock() {
        order.push('unlock');
      },
    };
    const rawFactory = fakeTeammateFactory(() => handle);
    const guarded = onlyCreateLockedSurface(rawFactory);

    const service = new WorkflowService({
      ...SCOPE,
      teamId: 'team-1',
      callerKind: 'team_leader',
      teammates: guarded,
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a'),
    });
    await service.start();
    await service.run({ script: 'noop' });

    const runner = runnerFactory.runners[0]!;
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'do it',
      options: { schema: { type: 'object' } },
    });
    await waitUntil(() => order.length >= 1);
    // The handle stays locked while the workflow still owns it.
    expect(order).toEqual(['submit:task']);

    turn.settle({ status: 'completed', resultText: JSON.stringify({ ok: true }) });
    runner.emit({ type: 'run_result', status: 'completed', result: null });
    await waitUntil(() => order.includes('unlock'));

    // The lock is released only by terminal cleanup, and only after the
    // handle is closed — never before, never independently of a spawn.
    expect(order).toEqual(['submit:task', 'close:Workflow run-a completed', 'unlock']);

    // The one call this made against the teammates capability carried the
    // operation-owned system-prompt fragment and the requested schema,
    // regardless of which provider `agentType` a step asks for — Workflow
    // never preflights or branches on provider capability.
    expect(rawFactory.calls).toHaveLength(1);
    expect(rawFactory.calls[0]?.options?.systemPromptAppend).toEqual([
      WORKFLOW_AGENT_SYSTEM_PROMPT,
    ]);
    expect(rawFactory.calls[0]?.options?.outputSchema).toEqual({ type: 'object' });
  });

  it('contributes the schema and the system-prompt fragment identically across different agentType steps', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const teammates = fakeTeammateFactory((input) => controllableLockedTeammate(input.name).handle);
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates,
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a'),
    });
    await service.start();
    await service.run({ script: 'noop', max_concurrency: 4 });
    const runner = runnerFactory.runners[0]!;

    const schema = { type: 'object', properties: {} } as const;
    runner.emit({
      type: 'agent_start',
      index: 0,
      prompt: 'p0',
      options: { schema, agentType: 'codex' },
    });
    runner.emit({
      type: 'agent_start',
      index: 1,
      prompt: 'p1',
      options: { schema, agentType: 'claude-code' },
    });
    runner.emit({
      type: 'agent_start',
      index: 2,
      prompt: 'p2',
      options: { schema },
    });
    await waitUntil(() => teammates.calls.length >= 3);

    for (const call of teammates.calls) {
      expect(call.options?.outputSchema).toEqual(schema);
      expect(call.options?.systemPromptAppend).toEqual([WORKFLOW_AGENT_SYSTEM_PROMPT]);
    }
  });

  it('never imports team-collection or team-service — the only path to Team ownership is the narrow capability it is handed', async () => {
    const { readdir: list, readFile: read } = await import('node:fs/promises');
    const dir = new URL('../src/service/workflow-service/', import.meta.url);
    const entries = await list(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const source = await read(new URL(entry, dir), 'utf8');
      expect(source).not.toMatch(/from ['"].*team-collection/);
      expect(source).not.toMatch(/from ['"].*\/team-service/);
    }
  });

  it('has no per-spawn Team-generation revalidation as a second lifecycle mechanism', async () => {
    const { readdir: list, readFile: read } = await import('node:fs/promises');
    const dir = new URL('../src/service/workflow-service/', import.meta.url);
    const entries = await list(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const source = await read(new URL(entry, dir), 'utf8');
      expect(source.toLowerCase()).not.toContain('generation');
    }
  });
});

describe('WorkflowService.stopAll() owns shutdown convergence', () => {
  it('resolves only once every live run has reached a terminal record', async () => {
    const runnerFactory = fakeWorkflowRunnerFactory();
    const delivery = fakeCompletionDelivery();
    const service = new WorkflowService({
      ...SCOPE,
      callerKind: 'dispatcher',
      teammates: fakeTeammateFactory(() => {
        throw new Error('no agents in this script');
      }),
      completionDelivery: delivery.policy,
      completionInitiator: () => fakeCompletionInitiator(),
      log: silentLog(),
      createRunner: runnerFactory.factory,
      generateRunId: fixedRunIds('run-a', 'run-b'),
    });
    await service.start();
    await service.run({ script: 'noop' });
    await service.run({ script: 'noop' });
    expect(runnerFactory.runners).toHaveLength(2);

    await service.stopAll();

    const listed = await service.list();
    expect(listed.runs.map((run) => run.status).sort()).toEqual(['stopped', 'stopped']);
    for (const runner of runnerFactory.runners) {
      expect(runner.stopped).toBe(true);
    }
  });
});
