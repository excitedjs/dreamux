import { randomUUID } from 'node:crypto';

import type {
  ChannelTaskSnapshot,
  ChannelTaskSnapshotItem,
} from '@excitedjs/dreamux-types';

export const SNAPSHOT_TTL_MS = 5 * 60_000;
export const MAX_CAPTURED_SNAPSHOTS = 8;

export interface CapturedTaskSnapshot {
  snapshotId: string;
  sessionFence: string;
  createdAt: number;
  hostStreamId: string;
  streamGeneration: number;
  watermark: number;
  acknowledgedThrough: number;
  hostStatus: ChannelTaskSnapshot['host_status'];
  containerManifest: ChannelTaskSnapshot['container_manifest'];
  items: ChannelTaskSnapshotItem[];
  cursors: Map<string, number>;
}

export function newSnapshotId(): string {
  return `snapshot_${randomUUID()}`;
}

export function boundedPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('task host page limit must be a positive safe integer');
  }
  return Math.min(500, limit);
}

export function cursorForOffset(
  snapshot: CapturedTaskSnapshot,
  offset: number,
): string {
  for (const [cursor, existingOffset] of snapshot.cursors) {
    if (existingOffset === offset) return cursor;
  }
  const cursor = `snapshot_cursor_${randomUUID()}`;
  snapshot.cursors.set(cursor, offset);
  return cursor;
}
