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
import {
  encodeFrame,
  newTransaction,
  writeRotatedWal,
} from '../src/service/channel-task-host/wal.js';
import {
  TASK_CONTAINER_MANIFEST_RECORD_VERSION,
  type TaskTargetClaimInput,
} from '../src/service/channel-task-host/types.js';
import {
  applyTestTaskManifest,
  testTaskContainer,
  testTaskManifestCandidate,
} from './helpers/task-host.js';

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
    const store = await openReadyStore(root, () => clock++);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');

    const accepted = await store.claim(claim);
    expect(accepted.created).toBe(true);
    expect(store.watermark).toBe(2);
    expect(store.replay(0).events).toEqual([
      expect.objectContaining({
        sequence: 1,
        payload: expect.objectContaining({
          kind: 'container_manifest.applied',
          revision: 1,
        }),
      }),
      expect.objectContaining({
        sequence: 2,
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
    const store = await openReadyStore(root, () => clock++);
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
    expect(store.watermark).toBe(2);
  });

  it('durably replays and checkpoints one complete container manifest', async () => {
    const store = await openStore(root, () => clock++);
    const candidate = testTaskManifestCandidate([
      testTaskContainer('container-a'),
      testTaskContainer('container-b'),
    ]);

    await expect(store.applyContainerManifest(candidate)).resolves.toMatchObject({
      changed: true,
      record: { revision: 1, entries: [{}, {}] },
    });
    expect(store.watermark).toBe(1);
    expect(store.replay(0).events).toEqual([
      expect.objectContaining({
        manifest_revision: 1,
        container_generation: null,
        payload: expect.objectContaining({
          kind: 'container_manifest.applied',
          revision: 1,
          entry_count: 2,
        }),
      }),
    ]);
    const publicState = store.containerManifestState();
    expect(publicState).toMatchObject({
      manifest: { revision: 1, entries: [{}, {}] },
      resolutions: [
        { resolution: { status: 'ready', binding_revision: 'revision-1' } },
        { resolution: { status: 'ready', binding_revision: 'revision-1' } },
      ],
    });
    expect(JSON.stringify(publicState)).not.toContain('/tmp/example-repository');
    await expect(store.applyContainerManifest(candidate)).resolves.toMatchObject({
      changed: false,
      record: { revision: 1 },
    });
    expect(store.watermark).toBe(1);

    const reopened = await openStore(root, () => clock++);
    expect(reopened.containerManifestState()).toEqual(publicState);
    await reopened.compact();
    const checkpointed = await openStore(root, () => clock++);
    expect(checkpointed.containerManifestState()).toEqual(publicState);
    expect(checkpointed.replay(0)).toEqual(reopened.replay(0));
  });

  it('requires tombstones and fences revoke and rebind generations', async () => {
    const store = await openStore(root, () => clock++);
    await applyTestTaskManifest(store, [
      testTaskContainer('container-a'),
      testTaskContainer('container-b'),
    ]);
    await expect(store.applyContainerManifest(testTaskManifestCandidate([
      testTaskContainer('container-a'),
    ]))).rejects.toThrow(/reused with different content/);
    const accepted = taskClaim('task-a', 'attempt-1', 'container-b');
    await store.claim(accepted);

    await expect(store.applyContainerManifest(testTaskManifestCandidate([
      testTaskContainer('container-a'),
    ], 2))).rejects.toThrow(/explicit revoked tombstone/);
    await applyTestTaskManifest(store, [
      testTaskContainer('container-a'),
      testTaskContainer('container-b', {
        state: 'revoked',
        tombstonedAt: 2_000,
      }),
    ], 2);
    await applyTestTaskManifest(store, [
      testTaskContainer('container-a'),
      testTaskContainer('container-b', { generation: 2 }),
    ], 3);
    await expect(store.applyContainerManifest(testTaskManifestCandidate([
      testTaskContainer('container-a'),
      testTaskContainer('container-b', {
        state: 'revoked',
        tombstonedAt: 2_000,
      }),
    ], 2))).rejects.toThrow(/older than durable Host state/);

    const duplicate = structuredClone(accepted);
    duplicate.manifestRevision = 3;
    duplicate.receipt.manifest_revision = 3;
    await expect(store.claim(duplicate)).resolves.toMatchObject({
      created: false,
      record: {
        manifest_revision: 1,
        container_generation: 1,
      },
    });
    const staleGeneration = taskClaim('task-b', 'attempt-1', 'container-b');
    staleGeneration.manifestRevision = 3;
    staleGeneration.receipt.manifest_revision = 3;
    await expect(store.claim(staleGeneration)).rejects.toThrow(
      /generation does not match/,
    );
    const rebound = taskClaim('task-c', 'attempt-1', 'container-b');
    rebound.manifestRevision = 3;
    rebound.containerGeneration = 2;
    rebound.receipt.manifest_revision = 3;
    rebound.receipt.container_generation = 2;
    await expect(store.claim(rebound)).resolves.toMatchObject({ created: true });
    await expect(store.setTerminal({
      targetId: accepted.targetId,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
      manifestRevision: 3,
      containerGeneration: 1,
    })).resolves.toMatchObject({ changed: true });
  });

  it('does not publish a manifest whose WAL append is ambiguous', async () => {
    const store = await openStore(root, () => clock++);
    await mkdir(join(root, 'transactions.wal'));

    await expect(store.applyContainerManifest(testTaskManifestCandidate([
      testTaskContainer('container-a'),
    ]))).rejects.toThrow(/writer is poisoned/);
    expect(store.appliedManifestRevision).toBe(0);
    expect(store.watermark).toBe(0);
  });

  it('fails recovery when a valid WAL frame carries a forged manifest digest', async () => {
    const store = await openStore(root, () => clock++);
    const candidate = testTaskManifestCandidate([
      testTaskContainer('container-a'),
    ]);
    const digest = '0'.repeat(64);
    const transaction = newTransaction({
      channel_id: 'remote-tasks',
      tx_index: 1,
      previous_checksum: null,
      committed_at: clock++,
      host_stream_id: store.hostStreamId,
      stream_generation: 1,
      container_manifest_delta: {
        version: TASK_CONTAINER_MANIFEST_RECORD_VERSION,
        revision: 1,
        digest,
        applied_at: clock++,
        entries: candidate.entries,
      },
      target_deltas: [],
      host_events: [{
        schema_version: 1,
        event_id: `${store.hostStreamId}:1:1`,
        sequence: 1,
        occurred_at: clock++,
        target_id: null,
        task_revision: null,
        manifest_revision: 1,
        container_generation: null,
        attempt: null,
        container: null,
        payload: {
          kind: 'container_manifest.applied',
          revision: 1,
          digest,
          entry_count: 1,
        },
      }],
      sequence_allocation: { first: 1, last: 1 },
      acknowledged_through: null,
      checkpoint: null,
    });
    await writeFile(join(root, 'transactions.wal'), encodeFrame(transaction).frame);

    await expect(openStore(root, () => clock++)).rejects.toThrow(
      /invalid task host container manifest/,
    );
  });

  it('truncates an incomplete tail but fails closed on checksum corruption', async () => {
    const store = await openReadyStore(root, () => clock++);
    await store.claim(taskClaim('task-a', 'attempt-1', 'container-a'));
    const wal = join(root, 'transactions.wal');
    const committedSize = (await stat(wal)).size;

    await appendFile(wal, Buffer.from([0, 0, 0]));
    const recovered = await openStore(root, () => clock++);
    expect(recovered.watermark).toBe(2);
    expect((await stat(wal)).size).toBe(committedSize);

    const bytes = await readFile(wal);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(wal, bytes);
    await expect(openStore(root, () => clock++)).rejects.toThrow(/checksum mismatch/);
  });

  it('does not publish failed WAL writes and poisons the writer', async () => {
    const failingRoot = join(root, 'failing');
    const store = await openReadyStore(failingRoot, () => clock++);
    await rm(join(failingRoot, 'transactions.wal'));
    await mkdir(join(failingRoot, 'transactions.wal'));
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');

    await expect(store.claim(claim)).rejects.toThrow(/writer is poisoned/);
    expect(store.get(claim.targetId)).toBeNull();
    expect(store.watermark).toBe(1);
    await expect(store.appendHostStatus('ready')).rejects.toThrow(/writer is poisoned/);
  });

  it('rejects non-JSON values before publishing live state', async () => {
    const store = await openReadyStore(root, () => clock++);
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
    const store = await openReadyStore(root, () => clock++);
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
    const store = await openReadyStore(root, () => clock++);
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
    await applyTestTaskManifest(store, [
      testTaskContainer('container-a'),
      testTaskContainer('container-b'),
      testTaskContainer('container-c'),
    ], 2);
    const page2 = snapshotPage(store, page1.next_cursor!, 1);
    expect(page2).toMatchObject({
      snapshot_id: page1.snapshot_id,
      watermark: page1.watermark,
      total_items: 2,
      complete: true,
      next_cursor: null,
      container_manifest: page1.container_manifest,
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
    expect(snapshotPage(store)).toMatchObject({
      total_items: 3,
      container_manifest: { manifest: { revision: 2 } },
    });

    await expect(store.acknowledge(store.streamGeneration, 1)).resolves.toBe(1);
    await expect(store.acknowledge(store.streamGeneration, 0)).rejects.toThrow(
      /monotonic integer prefix/,
    );
    await expect(store.acknowledge(store.streamGeneration, 6)).rejects.toThrow(
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
    const store = await openReadyStore(root, () => clock++);
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
    const store = await openReadyStore(root, () => clock++);
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
    await applyTestTaskManifest(store, [
      testTaskContainer('container-a'),
    ]);
    const claim = taskClaim('task-a', 'attempt-1', 'container-a');
    await store.claim(claim);

    await expect(store.compact()).rejects.toThrow(/writer is poisoned/);
    await expect(store.appendHostStatus('ready')).rejects.toThrow(/writer is poisoned/);
    const reopened = await openStore(root, () => clock++);
    expect(reopened.get(claim.targetId)).toMatchObject({ phase: 'received' });
  });

  it('fails closed when a multi-frame checkpoint loses its final commit frame', async () => {
    const store = await openReadyStore(root, () => clock++);
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

async function openReadyStore(
  rootDir: string,
  now: () => number,
): Promise<TaskHostStore> {
  const store = await openStore(rootDir, now);
  await applyTestTaskManifest(store, [
    testTaskContainer('container-a'),
    testTaskContainer('container-b'),
    testTaskContainer('container-c'),
  ]);
  return store;
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
    requestFingerprint: `fingerprint-${taskKey}-${attemptKey}`,
    receipt: {
      receipt_id: identity.receiptId,
      target_id: identity.targetId,
      attempt,
      revision: 1,
      accepted_at: 1_000,
      manifest_revision: 1,
      container_generation: 1,
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
