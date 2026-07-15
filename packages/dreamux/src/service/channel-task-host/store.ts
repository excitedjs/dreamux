import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ChannelTaskHostEventBatch,
  ChannelHostStatusCode,
  ChannelTaskSnapshotResult,
} from '@excitedjs/dreamux-types';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import type {
  TaskStoreEventInput,
  TaskTargetClaimInput,
  TaskTargetRecord,
} from './types.js';
import {
  TASK_TARGET_RECORD_VERSION,
  TaskTargetConflictError,
  TaskTargetRevisionError,
} from './types.js';
import {
  appendFrame,
  applyTransaction,
  encodeFrame,
  newTransaction,
  readTaskHostWal,
  validateTransaction,
  writeRotatedWal,
  type TaskHostTransaction,
  type TaskHostWalState,
} from './wal.js';
import { buildTaskHostCheckpoint } from './checkpoint.js';
import {
  assertCheckpointCapacity,
  assertOperationCapacity,
  assertRecoveredCapacity,
  assertTaskAdmissionCapacity,
  assertTargetFrameCapacity,
  canAcceptTask,
  TaskHostBackpressureError,
} from './capacity.js';
import {
  taskSnapshotItem,
} from './snapshot.js';
import {
  defaultTaskHostRoot,
  ensureTaskHostManifest,
} from './manifest.js';
import {
  clone,
  deriveSubmissionView,
  eventFor,
  safeSegment,
  validateTargetTransition,
} from './store-support.js';
import {
  boundedPageLimit,
  cursorForOffset,
  MAX_CAPTURED_SNAPSHOTS,
  newSnapshotId,
  SNAPSHOT_TTL_MS,
  type CapturedTaskSnapshot,
} from './snapshot-pagination.js';

const STORE_WRITES = new KeyedAsyncQueue();

export interface TaskHostStoreOptions {
  dispatcherId: string;
  channelId: string;
  providerRef: string;
  rootDir?: string;
  now?: () => number;
  onProjectionError?: (error: unknown) => void;
  checkpointAfterTransactions?: number;
  checkpointWriter?: typeof writeRotatedWal;
}

export class TaskHostStore {
  readonly hostStreamId: string;
  private readonly rootDir: string;
  private readonly walPath: string;
  private readonly projectionDir: string;
  private readonly now: () => number;
  private state: TaskHostWalState;
  private poisoned: Error | null = null;
  private onCommitted: (() => void) | null = null;
  private readonly snapshots = new Map<string, CapturedTaskSnapshot>();
  private readonly checkpointAfterTransactions: number;
  private commitsSinceCheckpoint: number;
  private maintenance: Promise<void> | null = null;

  private constructor(
    private readonly opts: TaskHostStoreOptions,
    state: TaskHostWalState,
  ) {
    this.rootDir = opts.rootDir ?? defaultTaskHostRoot(opts.dispatcherId, opts.channelId);
    this.walPath = join(this.rootDir, 'transactions.wal');
    this.projectionDir = join(this.rootDir, 'projections');
    this.hostStreamId = state.hostStreamId;
    this.now = opts.now ?? Date.now;
    this.state = state;
    this.checkpointAfterTransactions = Math.max(
      1,
      Math.trunc(opts.checkpointAfterTransactions ?? 512),
    );
    this.commitsSinceCheckpoint = state.checkpointFinalized ? 0 : state.txIndex;
  }

  static async open(opts: TaskHostStoreOptions): Promise<TaskHostStore> {
    const rootDir = opts.rootDir ?? defaultTaskHostRoot(opts.dispatcherId, opts.channelId);
    await mkdir(rootDir, { recursive: true });
    const manifest = await ensureTaskHostManifest({
      rootDir,
      dispatcherId: opts.dispatcherId,
      channelId: opts.channelId,
      providerRef: opts.providerRef,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    const streamId = manifest.host_stream_id;
    const loaded = await readTaskHostWal(join(rootDir, 'transactions.wal'), {
      channelId: opts.channelId,
      hostStreamId: streamId,
    });
    assertRecoveredCapacity(loaded);
    const store = new TaskHostStore(opts, { ...loaded, hostStreamId: streamId });
    await store.repairAcknowledgedTombstones();
    try {
      await store.rebuildProjections();
    } catch (error) {
      opts.onProjectionError?.(error);
    }
    return store;
  }

  get streamGeneration(): number {
    return this.state.streamGeneration;
  }

  get watermark(): number {
    return this.state.nextSequence - 1;
  }

  get acknowledgedThrough(): number {
    return this.state.acknowledgedThrough;
  }

  get replayFloor(): number {
    return this.state.replayFloor;
  }

  get hostStatus() {
    return this.state.hostStatus;
  }

  get hostStatusCode() {
    return this.state.hostStatusCode;
  }

  setCommitListener(listener: (() => void) | null): void {
    this.onCommitted = listener;
  }

  get(targetId: string): TaskTargetRecord | null {
    return clone(this.state.targets.get(targetId) ?? null);
  }

  list(): TaskTargetRecord[] {
    return [...this.state.targets.values()].map((record) => clone(record));
  }

  canAcceptTask(): boolean {
    return canAcceptTask(this.state);
  }

  assertOperationCapacity(candidate: TaskTargetRecord): void {
    assertOperationCapacity(this.state, candidate);
  }

  async claim(input: TaskTargetClaimInput): Promise<{
    created: boolean;
    record: TaskTargetRecord;
  }> {
    return this.write(async () => {
      const existing = this.state.targets.get(input.targetId);
      if (existing !== undefined) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new TaskTargetConflictError(
            `task attempt '${input.targetId}' was already received with different input`,
          );
        }
        return { created: false, record: clone(existing) };
      }
      if (!canAcceptTask(this.state)) throw new TaskHostBackpressureError();
      const now = this.now();
      const record: TaskTargetRecord = {
        version: TASK_TARGET_RECORD_VERSION,
        dispatcher_id: input.dispatcherId,
        channel_id: input.channelId,
        provider: input.provider,
        target_id: input.targetId,
        canonical_target_key: input.canonicalTargetKey,
        attempt: clone(input.attempt),
        container: clone(input.container),
        logical_repository: clone(input.logicalRepository),
        resolved_repository: clone(input.resolvedRepository),
        repository_binding: {
          source: input.resolvedRepository.source,
          logical_key: input.resolvedRepository.logical_key,
          binding_revision: input.resolvedRepository.binding_revision,
          fingerprint: input.resolvedRepository.fingerprint,
        },
        request_fingerprint: input.requestFingerprint,
        receipt: clone(input.receipt),
        title: input.title,
        turn: clone(input.turn),
        phase: 'received',
        revision: 1,
        binding: null,
        team: {
          team_name: input.teamName,
          leader_name: null,
          worktree_slug: input.worktreeSlug,
          route_claim_id: input.routeClaimId,
          route_reconciled_at: null,
        },
        submissions: [],
        submission_view: {
          active_operation_ids: [],
          last_leader_operation_id: null,
          quiescent: true,
        },
        terminal: null,
        terminal_revision: 0,
        blocked: null,
        finalizer: null,
        created_at: now,
        updated_at: now,
        last_host_sequence: 0,
        tombstone: false,
      };
      assertTaskAdmissionCapacity(this.state, record);
      await this.commit([record], [{
        payload: { kind: 'task.lifecycle', phase: 'received' },
        occurredAt: now,
      }]);
      return { created: true, record: clone(record) };
    });
  }

  async updateTarget(
    targetId: string,
    expectedRevision: number | null,
    mutate: (record: TaskTargetRecord) => void | boolean,
    events:
      | readonly TaskStoreEventInput[]
      | ((record: TaskTargetRecord) => readonly TaskStoreEventInput[]),
  ): Promise<TaskTargetRecord> {
    return this.write(async () => {
      const current = this.state.targets.get(targetId);
      if (current === undefined) throw new Error(`unknown task target '${targetId}'`);
      if (expectedRevision !== null && current.revision !== expectedRevision) {
        throw new TaskTargetRevisionError(expectedRevision, current.revision);
      }
      const next = clone(current);
      if (mutate(next) === false) return clone(current);
      next.revision = current.revision + 1;
      next.updated_at = this.now();
      next.submission_view = deriveSubmissionView(next);
      validateTargetTransition(current, next);
      const resolvedEvents = typeof events === 'function'
        ? events(clone(next))
        : events;
      if (resolvedEvents.length === 0) {
        throw new Error('task target transitions require at least one host event');
      }
      await this.commit([next], resolvedEvents);
      return clone(next);
    });
  }

  async setTerminal(input: {
    targetId: string;
    expectedRevision: number | null;
    terminal: NonNullable<TaskTargetRecord['terminal']>;
  }): Promise<{ changed: boolean; record: TaskTargetRecord }> {
    return this.write(async () => {
      const current = this.state.targets.get(input.targetId);
      if (current === undefined) throw new Error(`unknown task target '${input.targetId}'`);
      if (
        input.expectedRevision !== null &&
        current.revision !== input.expectedRevision
      ) {
        throw new TaskTargetRevisionError(input.expectedRevision, current.revision);
      }
      if (current.terminal !== null) {
        return { changed: false, record: clone(current) };
      }
      const next = clone(current);
      next.terminal = clone(input.terminal);
      next.terminal_revision = current.terminal_revision + 1;
      next.phase = 'terminal';
      next.blocked = null;
      next.finalizer = {
        step: 'pending',
        attempts: 0,
        last_error_code: null,
      };
      next.revision = current.revision + 1;
      next.updated_at = this.now();
      validateTargetTransition(current, next);
      const events: TaskStoreEventInput[] = [{
        payload: {
          kind: 'task.lifecycle',
          phase: 'terminal',
          outcome: input.terminal.outcome,
          ...(input.terminal.summary !== undefined
            ? { summary: input.terminal.summary }
            : {}),
        },
      }];
      if (input.terminal.outcome === 'cancelled') {
        for (const submission of current.submissions) {
          if (submission.state !== 'intent' && submission.state !== 'accepted') continue;
          events.push({
            payload: {
              kind: 'turn.lifecycle',
              turn_key: submission.operation_id,
              status: 'stopped',
            },
          });
        }
      }
      await this.commit([next], events);
      return { changed: true, record: clone(next) };
    });
  }

  async appendHostStatus(
    status: 'recovering' | 'ready' | 'degraded' | 'stopping' | 'stopped',
    code?: ChannelHostStatusCode,
  ): Promise<void> {
    await this.write(() => this.commit([], [{
      payload: {
        kind: 'host.lifecycle',
        status,
        ...(code !== undefined ? { code } : {}),
      },
    }]));
  }

  replay(afterSequence: number, limit = 100): ChannelTaskHostEventBatch {
    const bounded = boundedPageLimit(limit);
    const events = this.state.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, bounded)
      .map((event) => clone(event));
    const lastAvailable = events.at(-1)?.sequence ?? afterSequence;
    return {
      schema_version: 1,
      host_stream_id: this.hostStreamId,
      stream_generation: this.state.streamGeneration,
      first_sequence: events[0]?.sequence ?? null,
      last_sequence: events.at(-1)?.sequence ?? null,
      events,
      has_more: lastAvailable < this.watermark,
    };
  }

  async acknowledge(streamGeneration: number, through: number): Promise<number> {
    return this.write(async () => {
      if (streamGeneration !== this.state.streamGeneration) {
        throw new Error('host event acknowledgement has the wrong stream generation');
      }
      if (!Number.isSafeInteger(through) || through < this.state.acknowledgedThrough) {
        throw new Error('host event acknowledgement must be a monotonic integer prefix');
      }
      if (through > this.watermark) {
        throw new Error('host event acknowledgement is beyond the stream watermark');
      }
      if (through !== this.state.acknowledgedThrough) {
        await this.commit([], [], through);
      }
      await this.tombstoneAcknowledgedTargets();
      return through;
    });
  }

  snapshot(
    cursor?: string,
    limit = 100,
    sessionFence = 'direct-store-session',
  ): ChannelTaskSnapshotResult {
    let captured: CapturedTaskSnapshot;
    let start: number;
    if (cursor === undefined) {
      this.pruneSnapshots();
      captured = this.captureSnapshot(sessionFence);
      start = 0;
    } else {
      const match = [...this.snapshots.values()].find(
        (snapshot) => snapshot.cursors.has(cursor),
      );
      if (match === undefined) return this.snapshotRestart('cursor_invalid');
      if (this.now() - match.createdAt > SNAPSHOT_TTL_MS) {
        this.snapshots.delete(match.snapshotId);
        return this.snapshotRestart('snapshot_expired');
      }
      if (
        match.hostStreamId !== this.hostStreamId ||
        match.streamGeneration !== this.state.streamGeneration
      ) {
        return this.snapshotRestart('stream_changed');
      }
      if (match.sessionFence !== sessionFence) {
        return this.snapshotRestart('cursor_invalid');
      }
      captured = match;
      start = captured.cursors.get(cursor)!;
    }
    const bounded = boundedPageLimit(limit);
    const page = captured.items.slice(start, start + bounded).map((item) => clone(item));
    const next = start + page.length;
    const nextCursor = next < captured.items.length
      ? cursorForOffset(captured, next)
      : null;
    return {
      status: 'page',
      page: {
        schema_version: 1,
        snapshot_id: captured.snapshotId,
        session_fence: captured.sessionFence,
        host_stream_id: captured.hostStreamId,
        stream_generation: captured.streamGeneration,
        watermark: captured.watermark,
        acknowledged_through: captured.acknowledgedThrough,
        host_status: captured.hostStatus,
        item_offset: start,
        item_count: page.length,
        total_items: captured.items.length,
        complete: next >= captured.items.length,
        items: page,
        next_cursor: nextCursor,
      },
    };
  }

  private captureSnapshot(sessionFence: string): CapturedTaskSnapshot {
    if (this.snapshots.size >= MAX_CAPTURED_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    const captured: CapturedTaskSnapshot = {
      snapshotId: newSnapshotId(),
      sessionFence,
      createdAt: this.now(),
      hostStreamId: this.hostStreamId,
      streamGeneration: this.state.streamGeneration,
      watermark: this.watermark,
      acknowledgedThrough: this.state.acknowledgedThrough,
      hostStatus: this.state.hostStatus,
      items: [...this.state.targets.values()]
        .sort((left, right) => left.target_id.localeCompare(right.target_id))
        .map(taskSnapshotItem),
      cursors: new Map(),
    };
    this.snapshots.set(captured.snapshotId, captured);
    return captured;
  }

  private pruneSnapshots(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(id);
    }
  }

  private snapshotRestart(
    reason: 'cursor_invalid' | 'snapshot_expired' | 'stream_changed',
  ): ChannelTaskSnapshotResult {
    return {
      status: 'restart_required',
      reason,
      host_stream_id: this.hostStreamId,
      stream_generation: this.state.streamGeneration,
      watermark: this.watermark,
    };
  }

  /** Losslessly rewrite physical WAL history without changing the logical stream. */
  async compact(): Promise<void> {
    await this.write(async () => {
      assertCheckpointCapacity(this.state);
      const checkpoint = buildTaskHostCheckpoint({
        channelId: this.opts.channelId,
        hostStreamId: this.hostStreamId,
        state: this.state,
        committedAt: this.now(),
      });
      try {
        await (this.opts.checkpointWriter ?? writeRotatedWal)(
          this.walPath,
          checkpoint.bytes,
        );
      } catch (error) {
        this.poisoned = new Error(
          'task host WAL checkpoint failed; writer is poisoned until restart',
          { cause: error },
        );
        throw this.poisoned;
      }
      this.state = checkpoint.state;
      this.commitsSinceCheckpoint = 0;
      await this.rebuildProjections();
      this.onCommitted?.();
    });
  }

  async drainMaintenance(): Promise<void> {
    while (this.maintenance !== null) await this.maintenance;
  }

  private async write<T>(task: () => Promise<T>): Promise<T> {
    if (this.poisoned !== null) throw this.poisoned;
    return STORE_WRITES.run(this.walPath, async () => {
      if (this.poisoned !== null) throw this.poisoned;
      return task();
    });
  }

  private async commit(
    deltas: readonly TaskTargetRecord[],
    eventInputs: readonly TaskStoreEventInput[],
    acknowledgedThrough: number | null = null,
  ): Promise<void> {
    const first = this.state.nextSequence;
    if (deltas.length === 1 && eventInputs.length > 0) {
      deltas[0]!.last_host_sequence = first + eventInputs.length - 1;
    }
    for (const delta of deltas) assertTargetFrameCapacity(delta);
    const events = eventInputs.map((input, index) => {
      const target =
        input.payload.kind !== 'host.lifecycle' && deltas.length === 1
          ? deltas[0]!
          : null;
      return eventFor({
        hostStreamId: this.hostStreamId,
        streamGeneration: this.state.streamGeneration,
        sequence: first + index,
        occurredAt: input.occurredAt ?? this.now(),
        target,
        input,
      });
    });
    const tx: TaskHostTransaction = newTransaction({
      channel_id: this.opts.channelId,
      tx_index: this.state.txIndex + 1,
      previous_checksum: this.state.tailChecksum,
      committed_at: this.now(),
      host_stream_id: this.hostStreamId,
      stream_generation: this.state.streamGeneration,
      target_deltas: deltas.map((target) => clone(target)),
      host_events: events,
      sequence_allocation:
        events.length === 0
          ? null
          : { first, last: first + events.length - 1 },
      acknowledged_through: acknowledgedThrough,
      checkpoint: null,
    });
    const encoded = encodeFrame(tx);
    validateTransaction(
      encoded.transaction,
      this.state,
      this.opts.channelId,
      this.hostStreamId,
    );
    try {
      await appendFrame(this.walPath, encoded.frame);
    } catch (error) {
      this.poisoned = new Error('task host WAL commit failed; writer is poisoned', {
        cause: error,
      });
      throw this.poisoned;
    }
    applyTransaction(this.state, encoded.transaction, encoded.checksum);
    this.commitsSinceCheckpoint += 1;
    this.onCommitted?.();
    try {
      await this.writeProjections(deltas);
    } catch (error) {
      this.opts.onProjectionError?.(error);
    }
    if (this.commitsSinceCheckpoint >= this.checkpointAfterTransactions) {
      this.scheduleCheckpoint();
    }
  }

  private async tombstoneAcknowledgedTargets(): Promise<void> {
    const eligible = [...this.state.targets.values()].filter(
      (target) =>
        target.phase === 'finalized' &&
        !target.tombstone &&
        target.last_host_sequence <= this.state.acknowledgedThrough,
    );
    for (const current of eligible) {
      const next = clone(current);
      next.logical_repository = null;
      next.resolved_repository = null;
      next.title = null;
      next.turn = null;
      next.binding = null;
      next.submissions = [];
      next.submission_view = {
        active_operation_ids: [],
        last_leader_operation_id: null,
        quiescent: true,
      };
      next.team.leader_name = null;
      next.team.route_reconciled_at = null;
      next.blocked = null;
      next.tombstone = true;
      next.revision = current.revision + 1;
      next.updated_at = this.now();
      validateTargetTransition(current, next);
      await this.commit([next], [{
        payload: {
          kind: 'task.lifecycle',
          phase: 'finalized',
          tombstone: true,
        },
      }]);
    }
  }

  private repairAcknowledgedTombstones(): Promise<void> {
    return this.write(() => this.tombstoneAcknowledgedTargets());
  }

  private scheduleCheckpoint(): void {
    if (this.maintenance !== null || this.poisoned !== null) return;
    const maintenance = Promise.resolve()
      .then(() => this.compact())
      .finally(() => {
        if (this.maintenance === maintenance) this.maintenance = null;
      });
    this.maintenance = maintenance;
    void maintenance.catch((error) => this.opts.onProjectionError?.(error));
  }

  private async rebuildProjections(): Promise<void> {
    await mkdir(join(this.projectionDir, 'targets'), { recursive: true });
    await Promise.all([
      ...[...this.state.targets.values()].map((target) =>
        this.writeTargetProjection(target),
      ),
      this.writeStreamProjection(),
    ]);
  }

  private async writeProjections(deltas: readonly TaskTargetRecord[]): Promise<void> {
    await mkdir(join(this.projectionDir, 'targets'), { recursive: true });
    await Promise.all([
      ...deltas.map((target) => this.writeTargetProjection(target)),
      this.writeStreamProjection(),
    ]);
  }

  private writeTargetProjection(target: TaskTargetRecord): Promise<void> {
    return writeFileAtomic(
      join(this.projectionDir, 'targets', `${safeSegment(target.target_id)}.json`),
      `${JSON.stringify({
        schema: 'task_host_target_projection_v1',
        channel_id: this.opts.channelId,
        tx_index: this.state.txIndex,
        tail_checksum: this.state.tailChecksum,
        target,
      }, null, 2)}\n`,
    );
  }

  private writeStreamProjection(): Promise<void> {
    return writeFileAtomic(
      join(this.projectionDir, 'stream.json'),
      `${JSON.stringify({
        schema: 'task_host_stream_projection_v1',
        channel_id: this.opts.channelId,
        tx_index: this.state.txIndex,
        tail_checksum: this.state.tailChecksum,
        host_stream_id: this.hostStreamId,
        stream_generation: this.state.streamGeneration,
        watermark: this.watermark,
        acknowledged_through: this.state.acknowledgedThrough,
        replay_floor: this.state.replayFloor,
      }, null, 2)}\n`,
    );
  }
}
