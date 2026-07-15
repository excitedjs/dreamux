import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalTaskIdentity } from '../src/service/channel-task-host/identity.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import { writeRotatedWal } from '../src/service/channel-task-host/wal.js';
import type { TaskTargetClaimInput } from '../src/service/channel-task-host/types.js';

describe('TaskHostStore WAL and projections', () => {
  let root: string;
  let clock: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-host-store-'));
    clock = 1_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits target delta, event, and sequence atomically and replays them', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');

    const accepted = await store.claim(claim);
    expect(accepted.created).toBe(true);
    expect(store.watermark).toBe(1);
    expect(store.replay(0).events).toEqual([
      expect.objectContaining({
        sequence: 1,
        task_revision: 1,
        target_id: claim.targetId,
        payload: { kind: 'task.lifecycle', phase: 'received' },
      }),
    ]);

    const reopened = await openStore(root, () => clock++);
    expect(reopened.get(claim.targetId)).toEqual(store.get(claim.targetId));
    expect(reopened.replay(0)).toEqual(store.replay(0));
  });

  it('deduplicates the same target claim and rejects conflicting input', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);

    await expect(store.claim(structuredClone(claim))).resolves.toMatchObject({
      created: false,
      record: { target_id: claim.targetId, revision: 1 },
    });
    await expect(store.claim({
      ...claim,
      requestFingerprint: 'different',
    })).rejects.toThrow(/different input/);
    expect(store.watermark).toBe(1);
  });

  it('truncates an incomplete tail but fails closed on checksum corruption', async () => {
    const store = await openStore(root, () => clock++);
    await store.claim(taskClaim('task-a', 'attempt-1', 'container-a'));
    const wal = join(root, 'transactions.wal');
    const committedSize = (await stat(wal)).size;

    await appendFile(wal, Buffer.from([0, 0, 0]));
    const recovered = await openStore(root, () => clock++);
    expect(recovered.watermark).toBe(1);
    expect((await stat(wal)).size).toBe(committedSize);

    const bytes = await readFile(wal);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(wal, bytes);
    await expect(openStore(root, () => clock++)).rejects.toThrow(/checksum mismatch/);
  });

  it('does not publish failed WAL writes and poisons the writer', async () => {
    const failingRoot = join(root, 'failing');
    const store = await openStore(failingRoot, () => clock++);
    await mkdir(join(failingRoot, 'transactions.wal'));
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');

    await expect(store.claim(claim)).rejects.toThrow(/writer is poisoned/);
    expect(store.get(claim.targetId)).toBeNull();
    expect(store.watermark).toBe(0);
    await expect(store.appendHostStatus('ready')).rejects.toThrow(/writer is poisoned/);
  });

  it('rejects non-JSON values before publishing live state', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);

    await expect(store.updateTarget(
      claim.targetId,
      1,
      (target) => {
        target.team.route_reconciled_at = Number.NaN;
        target.phase = 'provisioning';
      },
      [{ payload: { kind: 'task.lifecycle', phase: 'provisioning' } }],
    )).rejects.toThrow(/non-finite number/);
    expect(store.get(claim.targetId)).toMatchObject({
      revision: 1,
      phase: 'received',
      team: { route_reconciled_at: null },
    });
  });

  it('enforces monotonic terminal and finalized transitions during live writes', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);
    const terminal = await store.setTerminal({
      targetId: claim.targetId,
      expectedRevision: 1,
      terminal: { outcome: 'completed', summary: 'done' },
    });
    expect(terminal.changed).toBe(true);

    const duplicate = await store.setTerminal({
      targetId: claim.targetId,
      expectedRevision: null,
      terminal: { outcome: 'failed' },
    });
    expect(duplicate).toMatchObject({
      changed: false,
      record: { terminal: { outcome: 'completed', summary: 'done' } },
    });
    await expect(store.updateTarget(
      claim.targetId,
      null,
      (target) => {
        target.phase = 'running';
      },
      [{ payload: { kind: 'task.lifecycle', phase: 'running' } }],
    )).rejects.toThrow(/invalid task phase transition/);
  });

  it('uses consecutive-prefix ACKs and stable, complete snapshot pagination', async () => {
    const store = await openStore(root, () => clock++);
    const first = taskClaim('task-a', 'attempt-1', 'container-a');
    const second = taskClaim('task-b', 'attempt-1', 'container-b');
    await store.claim(first);
    await store.claim(second);

    const page1 = snapshotPage(store, undefined, 1);
    expect(page1).toMatchObject({
      total_items: 2,
      complete: false,
      host_status: 'stopped',
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const tamperedCursor = `${page1.next_cursor!.slice(0, -1)}x`;
    expect(store.snapshot(tamperedCursor, 1)).toMatchObject({
      status: 'restart_required',
      reason: 'cursor_invalid',
    });
    expect(JSON.stringify(page1)).not.toContain('provider-private-input');
    expect(JSON.stringify(page1)).not.toContain('Execute task');
    const third = taskClaim('task-c', 'attempt-1', 'container-c');
    await store.claim(third);
    await store.acknowledge(store.streamGeneration, 1);
    const page2 = snapshotPage(store, page1.next_cursor!, 1);
    expect(page2).toMatchObject({
      snapshot_id: page1.snapshot_id,
      watermark: page1.watermark,
      total_items: 2,
      complete: true,
      next_cursor: null,
    });
    expect([...page1.items, ...page2.items].map((item) => item.receipt.target_id))
      .toEqual(
        [first.targetId, second.targetId].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
    expect(snapshotPage(store, page1.next_cursor!, 1)).toEqual(page2);
    expect(store.snapshot(page1.next_cursor!, 1, 'different-session')).toMatchObject({
      status: 'restart_required',
      reason: 'cursor_invalid',
    });
    expect(snapshotPage(store).total_items).toBe(3);

    await expect(store.acknowledge(store.streamGeneration, 1)).resolves.toBe(1);
    await expect(store.acknowledge(store.streamGeneration, 0)).rejects.toThrow(
      /monotonic integer prefix/,
    );
    await expect(store.acknowledge(store.streamGeneration, 4)).rejects.toThrow(
      /beyond the stream watermark/,
    );

    await store.appendHostStatus('ready');
    expect(snapshotPage(store, page1.next_cursor!, 1)).toEqual(page2);
    expect(() => store.snapshot(undefined, Number.NaN)).toThrow(/positive safe integer/);
    expect(() => store.replay(0, Number.POSITIVE_INFINITY)).toThrow(
      /positive safe integer/,
    );
  });

  it('losslessly checkpoints the physical WAL without changing the logical stream', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);
    await store.setTerminal({
      targetId: claim.targetId,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    await store.updateTarget(
      claim.targetId,
      null,
      (target) => {
        target.phase = 'finalizing';
        target.finalizer!.step = 'team_closed';
      },
      [{ payload: { kind: 'cleanup.lifecycle', status: 'started' } }],
    );
    await store.updateTarget(
      claim.targetId,
      null,
      (target) => {
        target.phase = 'finalized';
        target.finalizer!.step = 'completed';
        target.finalizer!.cleanup_status = 'deleted';
      },
      [{ payload: { kind: 'cleanup.lifecycle', status: 'completed' } }],
    );
    const oldIds = store.replay(0, 500).events.map((event) => event.event_id);
    const oldGeneration = store.streamGeneration;
    const oldWatermark = store.watermark;
    const oldStatus = store.hostStatus;
    await store.compact();
    expect(store.streamGeneration).toBe(oldGeneration);
    expect(store.watermark).toBe(oldWatermark);
    expect(store.hostStatus).toBe(oldStatus);
    expect(store.replay(0, 500).events.map((event) => event.event_id)).toEqual(oldIds);

    const reopened = await openStore(root, () => clock++);
    expect(reopened.streamGeneration).toBe(oldGeneration);
    expect(reopened.list()).toEqual(store.list());
    expect(reopened.replay(0, 500).events.map((event) => event.event_id)).toEqual(oldIds);

    await reopened.acknowledge(reopened.streamGeneration, reopened.watermark);
    const tombstone = reopened.get(claim.targetId)!;
    expect(tombstone).toMatchObject({
      phase: 'finalized',
      tombstone: true,
      resolved_repository: null,
      binding: null,
      submissions: [],
    });
    expect(JSON.stringify(tombstone)).not.toContain('/tmp/example-repository');
    expect(reopened.replay(oldWatermark).events).toEqual([
      expect.objectContaining({
        sequence: oldWatermark + 1,
        payload: {
          kind: 'task.lifecycle',
          phase: 'finalized',
          tombstone: true,
        },
      }),
    ]);
    await reopened.acknowledge(
      reopened.streamGeneration,
      reopened.watermark,
    );
    await reopened.compact();
    expect(reopened.replayFloor).toBe(reopened.watermark);
    expect(reopened.replay(reopened.watermark).events).toEqual([]);
  });

  it('repairs a finalized target when ACK commits before tombstoning', async () => {
    const store = await openStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);
    await store.setTerminal({
      targetId: claim.targetId,
      expectedRevision: null,
      terminal: { outcome: 'completed', summary: 'done' },
    });
    await store.updateTarget(
      claim.targetId,
      null,
      (target) => {
        target.phase = 'finalizing';
        target.finalizer!.step = 'team_closed';
      },
      [{ payload: { kind: 'cleanup.lifecycle', status: 'started' } }],
    );
    await store.updateTarget(
      claim.targetId,
      null,
      (target) => {
        target.phase = 'finalized';
        target.finalizer!.step = 'completed';
        target.finalizer!.cleanup_status = 'deleted';
      },
      [{ payload: { kind: 'cleanup.lifecycle', status: 'completed' } }],
    );
    const acknowledgedWatermark = store.watermark;
    const repair = store as unknown as {
      tombstoneAcknowledgedTargets: () => Promise<void>;
    };
    vi.spyOn(repair, 'tombstoneAcknowledgedTargets').mockRejectedValueOnce(
      new Error('simulated crash after durable ACK'),
    );

    await expect(store.acknowledge(
      store.streamGeneration,
      acknowledgedWatermark,
    )).rejects.toThrow(/simulated crash/);

    const reopened = await openStore(root, () => clock++);
    expect(reopened.acknowledgedThrough).toBe(acknowledgedWatermark);
    expect(reopened.get(claim.targetId)).toMatchObject({
      phase: 'finalized',
      tombstone: true,
      logical_repository: null,
      resolved_repository: null,
      binding: null,
      submissions: [],
    });
    expect(reopened.replay(acknowledgedWatermark).events).toEqual([
      expect.objectContaining({
        sequence: acknowledgedWatermark + 1,
        payload: {
          kind: 'task.lifecycle',
          phase: 'finalized',
          tombstone: true,
        },
      }),
    ]);
  });

  it('automatically checkpoints at the configured threshold and preserves unacked ids', async () => {
    const store = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/dreamux-task-channel',
      rootDir: root,
      now: () => clock++,
      checkpointAfterTransactions: 2,
    });
    await store.appendHostStatus('ready');
    await store.appendHostStatus('degraded');
    const ids = store.replay(0).events.map((event) => event.event_id);
    await store.drainMaintenance();

    const reopened = await openStore(root, () => clock++);
    expect(reopened.hostStatus).toBe('degraded');
    expect(reopened.replay(0).events.map((event) => event.event_id)).toEqual(ids);
    expect(reopened.streamGeneration).toBe(store.streamGeneration);
  });

  it('poisons an ambiguous checkpoint writer but recovers the renamed WAL', async () => {
    const store = await TaskHostStore.open({
      dispatcherId: 'dispatcher-a',
      channelId: 'remote-tasks',
      providerRef: 'npm:@example/dreamux-task-channel',
      rootDir: root,
      now: () => clock++,
      checkpointWriter: async (path, bytes) => {
        await writeRotatedWal(path, bytes);
        throw new Error('simulated directory sync uncertainty');
      },
    });
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);

    await expect(store.compact()).rejects.toThrow(/writer is poisoned/);
    await expect(store.appendHostStatus('ready')).rejects.toThrow(/writer is poisoned/);
    const reopened = await openStore(root, () => clock++);
    expect(reopened.get(claim.targetId)).toMatchObject({ phase: 'received' });
  });

  it('fails closed when a multi-frame checkpoint loses its final commit frame', async () => {
    const store = await openStore(root, () => clock++);
    await store.claim(taskClaim('task-a', 'attempt-1', 'container-a'));
    await store.claim(taskClaim('task-b', 'attempt-1', 'container-b'));
    await store.compact();
    const wal = join(root, 'transactions.wal');
    const bytes = await readFile(wal);
    await writeFile(wal, bytes.subarray(0, bytes.length - 10));

    await expect(openStore(root, () => clock++)).rejects.toThrow(
      /checkpoint is incomplete/,
    );
  });
});

function openStore(rootDir: string, now: () => number): Promise<TaskHostStore> {
  return TaskHostStore.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    providerRef: 'npm:@example/dreamux-task-channel',
    rootDir,
    now,
  });
}

function taskClaim(
  taskKey: string,
  attemptKey: string,
  containerKey: string,
): TaskTargetClaimInput {
  const attempt = { task_key: taskKey, attempt_key: attemptKey };
  const identity = canonicalTaskIdentity({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    containerType: 'task-space',
    containerKey,
    attempt,
  });
  return {
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: 'npm:@example/dreamux-task-channel',
    targetId: identity.targetId,
    canonicalTargetKey: identity.targetKey,
    attempt,
    container: {
      container_type: 'task-space',
      container_key: containerKey,
    },
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
    requestFingerprint: `fingerprint-${taskKey}-${attemptKey}`,
    receipt: {
      receipt_id: identity.receiptId,
      target_id: identity.targetId,
      attempt,
      revision: 1,
      accepted_at: 1_000,
    },
    title: `Task ${taskKey}`,
    turn: {
      sourceId: `delivery-${taskKey}-${attemptKey}`,
      text: `Execute ${taskKey}`,
      attachments: [{
        kind: 'artifact',
        name: 'input.txt',
        localPath: '/tmp/provider-private-input',
      }],
    },
    teamName: identity.teamName,
    worktreeSlug: identity.worktreeSlug,
    routeClaimId: identity.routeClaimId,
  };
}

function snapshotPage(
  store: TaskHostStore,
  cursor?: string,
  limit?: number,
) {
  const result = store.snapshot(cursor, limit);
  if (result.status !== 'page') throw new Error(`snapshot failed: ${result.reason}`);
  return result.page;
}
