import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NestedTeamMateDispatchError,
  resolveTeammateTarget,
  TeamMateLedgerCompatibilityError,
  TeamMateTaskLedger,
  TeamMateTaskTransitionError,
} from '../src/teammate/ledger.js';
import {
  dispatcherTeamMateLedgerPath,
  dispatcherTeamMateTasksDir,
  resetRuntimeConfig,
} from '../src/runtime/paths.js';

describe('TeamMateTaskLedger', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-teammate-ledger-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a dispatcher-scheduled task into the per-dispatcher state layout', async () => {
    const ledger = new TeamMateTaskLedger('flow');

    const task = await ledger.acceptTask({
      title: 'Summarize issue',
      prompt: 'Read the issue and summarize the open decisions.',
      callerKind: 'dispatcher',
      teammateId: 'reviewer-1',
      now: 1000,
      taskId: 'tmtsk_k4_reviewer1',
    });

    expect(task).toMatchObject({
      version: 2,
      task_id: 'tmtsk_k4_reviewer1',
      dispatcher_id: 'flow',
      lifecycle_status: 'accepted',
      delivery_status: 'none',
      title: 'Summarize issue',
      prompt: 'Read the issue and summarize the open decisions.',
      teammate_id: 'reviewer-1',
      origin: 'dispatcher',
      scheduled_by: { kind: 'dispatcher' },
      events: [{ event_id: 1, type: 'accepted', at: 1000 }],
      inputs: [],
      target: null,
      team: null,
      created_at: 1000,
      updated_at: 1000,
    });
    const rootFile = JSON.parse(
      await readFile(dispatcherTeamMateLedgerPath('flow'), 'utf8'),
    ) as Record<string, unknown>;
    expect(rootFile).toMatchObject({
      version: 1,
      dispatcher_id: 'flow',
      created_at: 1000,
      updated_at: 1000,
    });
    const taskFile = JSON.parse(
      await readFile(
        join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_k4_reviewer1.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(taskFile).toMatchObject(task);
  });

  it('lists tasks deterministically and updates task status', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Second',
      prompt: 'second task',
      callerKind: 'dispatcher',
      now: 2000,
      taskId: 'tmtsk_1_second',
    });
    await ledger.acceptTask({
      title: 'First',
      prompt: 'first task',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_first',
    });

    expect((await ledger.listTasks()).map((task) => task.task_id)).toEqual([
      'tmtsk_1_first',
      'tmtsk_1_second',
    ]);

    const updated = await ledger.markRunning('tmtsk_1_first', { now: 3000 });
    expect(updated.lifecycle_status).toBe('running');
    expect(updated.updated_at).toBe(3000);
    expect(updated.events).toEqual([
      { event_id: 1, type: 'accepted', at: 1000 },
      { event_id: 2, type: 'running', at: 3000 },
    ]);
    expect((await ledger.getTask('tmtsk_1_first'))?.lifecycle_status).toBe(
      'running',
    );
  });

  it('rejects nested TeamMate scheduling before writing a task', async () => {
    const ledger = new TeamMateTaskLedger('flow');

    await expect(
      ledger.acceptTask({
        title: 'Nested',
        prompt: 'nested task',
        callerKind: 'teammate',
        now: 1000,
        taskId: 'tmtsk_1_nested',
      }),
    ).rejects.toThrow(NestedTeamMateDispatchError);

    expect(await ledger.listTasks()).toEqual([]);
  });

  it('fails loudly on an incompatible root ledger version', async () => {
    const path = dispatcherTeamMateLedgerPath('flow');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ version: 2, dispatcher_id: 'flow' }),
      'utf8',
    );

    const ledger = new TeamMateTaskLedger('flow');
    await expect(
      ledger.acceptTask({
        title: 'Will fail',
        prompt: 'state is incompatible',
        callerKind: 'dispatcher',
        taskId: 'tmtsk_1_fail',
      }),
    ).rejects.toThrow(TeamMateLedgerCompatibilityError);
  });

  it('fails loudly on malformed task records', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Task',
      prompt: 'task',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_task',
    });
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_task.json'),
      JSON.stringify({
        version: 1,
        task_id: 'tmtsk_1_task',
        dispatcher_id: 'flow',
        status: 'accepted',
        title: 'Task',
        prompt: 'task',
        teammate_id: null,
        scheduled_by: null,
        history: [{ status: 'accepted', at: 1000 }],
        created_at: 1000,
        updated_at: 1000,
      }),
      'utf8',
    );

    await expect(ledger.getTask('tmtsk_1_task')).rejects.toThrow(
      TeamMateLedgerCompatibilityError,
    );
  });

  it('rejects a duplicate task id (PR7 nit: exclusive create)', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Task',
      prompt: 'task',
      callerKind: 'dispatcher',
      taskId: 'tmtsk_1_dup',
    });
    await expect(
      ledger.acceptTask({
        title: 'Task again',
        prompt: 'task',
        callerKind: 'dispatcher',
        taskId: 'tmtsk_1_dup',
      }),
    ).rejects.toThrow();
  });

  it('loads a PR7-shaped v1 task that has no result/delivery fields', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Legacy',
      prompt: 'legacy',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_legacy',
    });
    // Rewrite as a strict PR7 v1 record (no result/delivery keys at all).
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_legacy.json'),
      JSON.stringify({
        version: 1,
        task_id: 'tmtsk_1_legacy',
        dispatcher_id: 'flow',
        status: 'accepted',
        title: 'Legacy',
        prompt: 'legacy',
        teammate_id: null,
        scheduled_by: { kind: 'dispatcher' },
        history: [{ status: 'accepted', at: 1000 }],
        created_at: 1000,
        updated_at: 1000,
      }),
      'utf8',
    );
    const task = await ledger.getTask('tmtsk_1_legacy');
    expect(task?.result).toBeNull();
    expect(task?.delivery).toBeNull();
  });

  it('fails loud on a present-but-malformed result field', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'T',
      prompt: 't',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_badres',
    });
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_badres.json'),
      JSON.stringify({
        version: 1,
        task_id: 'tmtsk_1_badres',
        dispatcher_id: 'flow',
        status: 'completed',
        title: 'T',
        prompt: 't',
        teammate_id: null,
        scheduled_by: { kind: 'dispatcher' },
        history: [{ status: 'accepted', at: 1000 }],
        result: { outcome: 'nonsense', text: 5 },
        created_at: 1000,
        updated_at: 1000,
      }),
      'utf8',
    );
    await expect(ledger.getTask('tmtsk_1_badres')).rejects.toThrow(
      TeamMateLedgerCompatibilityError,
    );
  });

  it('skips corrupt task files in listTasks and reports them (resilient retrieval)', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Good',
      prompt: 'good',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_good',
    });
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_corrupt.json'),
      '{ not valid json',
      'utf8',
    );

    const corrupt: string[] = [];
    const tasks = await ledger.listTasks({
      onCorrupt: (taskId) => corrupt.push(taskId),
    });
    expect(tasks.map((t) => t.task_id)).toEqual(['tmtsk_1_good']);
    expect(corrupt).toEqual(['tmtsk_1_corrupt']);
  });

  it('records a result, guards transitions, and finds the latest result', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'T',
      prompt: 't',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_res',
    });
    const completed = await ledger.recordResult('tmtsk_1_res', {
      outcome: 'completed',
      text: 'final',
      now: 2000,
    });
    expect(completed.lifecycle_status).toBe('completed');
    expect(completed.delivery_status).toBe('pending');
    expect(completed.result).toMatchObject({ outcome: 'completed', text: 'final' });

    // A second recordResult on a terminal task is rejected (transition guard).
    await expect(
      ledger.recordResult('tmtsk_1_res', { outcome: 'completed', text: 'again' }),
    ).rejects.toThrow(TeamMateTaskTransitionError);

    const latest = await ledger.latestResultTask();
    expect(latest?.task_id).toBe('tmtsk_1_res');
  });

  it('records a resolved target, queued inputs, and a monotonic event stream', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    const task = await ledger.acceptTask({
      title: 'Run task',
      prompt: 'do work',
      callerKind: 'dispatcher',
      target: { kind: 'path', path: '/workspace/example-repo' },
      targetMode: 'managed_worktree',
      providerRef: 'builtin:codex',
      now: 1000,
      taskId: 'tmtsk_1_run',
    });
    expect(task.target).toEqual({ kind: 'path', path: '/workspace/example-repo' });
    expect(task.target_mode).toBe('managed_worktree');
    expect(task.provider_ref).toBe('builtin:codex');

    const first = await ledger.appendInput('tmtsk_1_run', {
      text: 'also check lint',
      mode: 'steer',
      now: 2000,
    });
    expect(first.input.input_id).toBe('input_1');
    expect(first.input.mode).toBe('steer');
    expect(first.input.status).toBe('queued');
    const second = await ledger.appendInput('tmtsk_1_run', {
      text: 'and the types',
      mode: 'queue',
      now: 3000,
    });
    expect(second.input.input_id).toBe('input_2');
    expect(second.task.events.map((e) => e.event_id)).toEqual([1, 2, 3]);
    expect(second.task.events.map((e) => e.type)).toEqual([
      'accepted',
      'input_queued',
      'input_queued',
    ]);
    expect(second.task.events[1]?.input_id).toBe('input_1');
  });

  it('is idempotent for a repeated operation_id', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    const first = await ledger.acceptTask({
      title: 'Once',
      prompt: 'once',
      callerKind: 'dispatcher',
      operationId: 'op-123',
      now: 1000,
      taskId: 'tmtsk_1_op',
    });
    const again = await ledger.acceptTask({
      title: 'Twice',
      prompt: 'twice',
      callerKind: 'dispatcher',
      operationId: 'op-123',
      now: 2000,
      taskId: 'tmtsk_1_op2',
    });
    expect(again.task_id).toBe(first.task_id);
    expect((await ledger.listTasks()).map((t) => t.task_id)).toEqual([
      'tmtsk_1_op',
    ]);
  });

  it('records close metadata and cancels a live task', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Close me',
      prompt: 'close',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_close',
    });
    const closed = await ledger.recordClose('tmtsk_1_close', {
      status: 'abandoned',
      note: 'superseded',
      now: 2000,
    });
    expect(closed.lifecycle_status).toBe('cancelled');
    expect(closed.close).toEqual({
      status: 'abandoned',
      note: 'superseded',
      at: 2000,
    });
    expect(closed.events.at(-1)?.type).toBe('closed');
  });

  it('rejects input on a terminal task', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'T',
      prompt: 't',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_term',
    });
    await ledger.recordResult('tmtsk_1_term', {
      outcome: 'completed',
      text: 'final',
      now: 2000,
    });
    await expect(
      ledger.appendInput('tmtsk_1_term', { text: 'late', mode: 'steer' }),
    ).rejects.toThrow(TeamMateTaskTransitionError);
  });

  it('migrates a delivered v1 task losslessly into the v2 shape', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Seed',
      prompt: 'seed',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_v1del',
    });
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_v1del.json'),
      JSON.stringify({
        version: 1,
        task_id: 'tmtsk_1_v1del',
        dispatcher_id: 'flow',
        status: 'delivered',
        title: 'Seed',
        prompt: 'seed',
        teammate_id: 'reviewer-1',
        scheduled_by: { kind: 'dispatcher' },
        history: [
          { status: 'accepted', at: 1000 },
          { status: 'completed', at: 2000 },
          { status: 'delivered', at: 3000 },
        ],
        result: { outcome: 'completed', text: 'final', at: 2000 },
        delivery: { attempts: 1, last_error: null, last_attempt_at: 3000 },
        created_at: 1000,
        updated_at: 3000,
      }),
      'utf8',
    );
    const task = await ledger.getTask('tmtsk_1_v1del');
    expect(task?.version).toBe(2);
    expect(task?.lifecycle_status).toBe('completed');
    expect(task?.delivery_status).toBe('delivered');
    expect(task?.result).toMatchObject({ outcome: 'completed', text: 'final' });
    expect(task?.events.map((e) => e.type)).toEqual([
      'accepted',
      'completed',
      'delivered',
    ]);
    // Reserved Team Mode fields default to null on a migrated record.
    expect(task?.team).toBeNull();
    expect(task?.origin).toBeNull();
  });

  it('fails loud on an unknown future task version', async () => {
    const ledger = new TeamMateTaskLedger('flow');
    await ledger.acceptTask({
      title: 'Future',
      prompt: 'future',
      callerKind: 'dispatcher',
      now: 1000,
      taskId: 'tmtsk_1_future',
    });
    await writeFile(
      join(dispatcherTeamMateTasksDir('flow'), 'tmtsk_1_future.json'),
      JSON.stringify({
        version: 3,
        task_id: 'tmtsk_1_future',
        dispatcher_id: 'flow',
      }),
      'utf8',
    );
    await expect(ledger.getTask('tmtsk_1_future')).rejects.toThrow(
      TeamMateLedgerCompatibilityError,
    );
  });
});

describe('resolveTeammateTarget', () => {
  it('resolves a relative path against the dispatcher directory', () => {
    expect(resolveTeammateTarget('sub/repo', '/work/flow')).toEqual({
      kind: 'path',
      path: '/work/flow/sub/repo',
    });
  });

  it('accepts an absolute path inside the dispatcher directory', () => {
    expect(resolveTeammateTarget('/work/flow/repo', '/work/flow')).toEqual({
      kind: 'path',
      path: '/work/flow/repo',
    });
  });

  it('accepts the dispatcher directory itself', () => {
    expect(resolveTeammateTarget('.', '/work/flow')).toEqual({
      kind: 'path',
      path: '/work/flow',
    });
  });

  it('rejects a path that escapes the dispatcher directory', () => {
    expect(() => resolveTeammateTarget('../other', '/work/flow')).toThrow(
      /inside the dispatcher directory/,
    );
    expect(() => resolveTeammateTarget('/etc/passwd', '/work/flow')).toThrow(
      /inside the dispatcher directory/,
    );
  });

  it('rejects when the dispatcher directory is not configured', () => {
    expect(() => resolveTeammateTarget('repo', '')).toThrow(
      /not configured/,
    );
  });
});
