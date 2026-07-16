import type {
  ChannelTaskSnapshotResult,
} from '@excitedjs/dreamux-types';

import { publicContainerManifestState } from './container-manifest.js';
import { taskSnapshotItem } from './snapshot.js';
import {
  boundedPageLimit,
  cursorForOffset,
  MAX_CAPTURED_SNAPSHOTS,
  newSnapshotId,
  SNAPSHOT_TTL_MS,
  type CapturedTaskSnapshot,
} from './snapshot-pagination.js';
import type { TaskHostWalState } from './wal.js';

export class TaskHostSnapshotCollection {
  private readonly snapshots = new Map<string, CapturedTaskSnapshot>();

  constructor(
    private readonly hostStreamId: string,
    private readonly now: () => number,
  ) {}

  snapshot(
    state: TaskHostWalState,
    cursor?: string,
    limit = 100,
    sessionFence = 'direct-store-session',
  ): ChannelTaskSnapshotResult {
    let captured: CapturedTaskSnapshot;
    let start: number;
    if (cursor === undefined) {
      this.prune();
      captured = this.capture(state, sessionFence);
      start = 0;
    } else {
      const match = [...this.snapshots.values()].find(
        (snapshot) => snapshot.cursors.has(cursor),
      );
      if (match === undefined) return this.restart(state, 'cursor_invalid');
      if (this.now() - match.createdAt > SNAPSHOT_TTL_MS) {
        this.snapshots.delete(match.snapshotId);
        return this.restart(state, 'snapshot_expired');
      }
      if (
        match.hostStreamId !== this.hostStreamId ||
        match.streamGeneration !== state.streamGeneration
      ) {
        return this.restart(state, 'stream_changed');
      }
      if (match.sessionFence !== sessionFence) {
        return this.restart(state, 'cursor_invalid');
      }
      captured = match;
      start = captured.cursors.get(cursor)!;
    }
    return {
      status: 'page',
      page: pageFrom(captured, start, limit),
    };
  }

  private capture(
    state: TaskHostWalState,
    sessionFence: string,
  ): CapturedTaskSnapshot {
    if (this.snapshots.size >= MAX_CAPTURED_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    const captured: CapturedTaskSnapshot = {
      snapshotId: newSnapshotId(),
      sessionFence,
      createdAt: this.now(),
      hostStreamId: this.hostStreamId,
      streamGeneration: state.streamGeneration,
      watermark: state.nextSequence - 1,
      acknowledgedThrough: state.acknowledgedThrough,
      hostStatus: state.hostStatus,
      containerManifest: publicContainerManifestState(state.containerManifest),
      items: [...state.targets.values()]
        .sort((left, right) => left.target_id.localeCompare(right.target_id))
        .map(taskSnapshotItem),
      cursors: new Map(),
    };
    this.snapshots.set(captured.snapshotId, captured);
    return captured;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (now - snapshot.createdAt > SNAPSHOT_TTL_MS) this.snapshots.delete(id);
    }
  }

  private restart(
    state: TaskHostWalState,
    reason: 'cursor_invalid' | 'snapshot_expired' | 'stream_changed',
  ): ChannelTaskSnapshotResult {
    return {
      status: 'restart_required',
      reason,
      host_stream_id: this.hostStreamId,
      stream_generation: state.streamGeneration,
      watermark: state.nextSequence - 1,
    };
  }
}

function pageFrom(
  captured: CapturedTaskSnapshot,
  start: number,
  limit: number,
) {
  const bounded = boundedPageLimit(limit);
  const items = captured.items
    .slice(start, start + bounded)
    .map((item) => structuredClone(item));
  const next = start + items.length;
  return {
    schema_version: 1 as const,
    snapshot_id: captured.snapshotId,
    session_fence: captured.sessionFence,
    host_stream_id: captured.hostStreamId,
    stream_generation: captured.streamGeneration,
    watermark: captured.watermark,
    acknowledged_through: captured.acknowledgedThrough,
    host_status: captured.hostStatus,
    container_manifest: structuredClone(captured.containerManifest),
    item_offset: start,
    item_count: items.length,
    total_items: captured.items.length,
    complete: next >= captured.items.length,
    items,
    next_cursor: next < captured.items.length
      ? cursorForOffset(captured, next)
      : null,
  };
}
