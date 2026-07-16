import type { ChannelTaskHostEvent } from '@excitedjs/dreamux-types';

import { canonicalJson } from './canonical-json.js';
import type { TaskContainerManifestRecord, TaskTargetRecord } from './types.js';
import type { TaskHostTransaction, TaskHostWalState } from './wal.js';

export function validateNewTargetManifestFence(
  target: TaskTargetRecord,
  manifest: TaskContainerManifestRecord,
): void {
  const entry = manifest.entries.find((candidate) =>
    candidate.container.container_type === target.container.container_type &&
    candidate.container.container_key === target.container.container_key
  );
  if (
    target.manifest_revision !== manifest.revision ||
    entry === undefined ||
    entry.state !== 'active' ||
    entry.generation !== target.container_generation ||
    entry.resolved_repository === null ||
    canonicalJson(entry.logical_repository) !==
      canonicalJson(target.logical_repository) ||
    canonicalJson(entry.resolved_repository) !==
      canonicalJson(target.resolved_repository)
  ) {
    throw new Error('new task host target is outside the applied manifest fence');
  }
}

export function validateHostEventEnvelope(
  event: ChannelTaskHostEvent,
  tx: TaskHostTransaction,
  state: TaskHostWalState,
): void {
  if (
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !Number.isSafeInteger(event.occurred_at) ||
    event.occurred_at < 0 ||
    !Number.isSafeInteger(event.manifest_revision) ||
    event.manifest_revision < 0
  ) {
    throw new Error('task host WAL event envelope is invalid');
  }
  if (
    event.payload.kind === 'host.lifecycle' ||
    event.payload.kind === 'container_manifest.applied'
  ) {
    validateHostWideEvent(event);
    return;
  }
  if (
    event.target_id === null ||
    !Number.isSafeInteger(event.task_revision) ||
    event.task_revision! < 1 ||
    !Number.isSafeInteger(event.container_generation) ||
    event.container_generation! < 1 ||
    event.attempt === null ||
    event.container === null
  ) {
    throw new Error('task host WAL target event omits target identity');
  }
  const target = tx.checkpoint === null
    ? tx.target_deltas.find((candidate) => candidate.target_id === event.target_id)
    : state.targets.get(event.target_id);
  if (
    target === undefined ||
    (tx.checkpoint === null
      ? event.task_revision !== target.revision
      : event.task_revision! > target.revision) ||
    event.manifest_revision !== target.manifest_revision ||
    event.container_generation !== target.container_generation ||
    event.attempt.task_key !== target.attempt.task_key ||
    event.attempt.attempt_key !== target.attempt.attempt_key ||
    event.container.container_type !== target.container.container_type ||
    event.container.container_key !== target.container.container_key
  ) {
    throw new Error('task host WAL event target fence is invalid');
  }
  validateTaskLifecycleEvent(event, target, tx.checkpoint !== null);
}

export function validateManifestTransaction(tx: TaskHostTransaction): void {
  const events = tx.host_events.filter(
    (event) => event.payload.kind === 'container_manifest.applied',
  );
  if (tx.checkpoint !== null) return;
  const manifest = tx.container_manifest_delta;
  if (manifest === null) {
    if (events.length !== 0) {
      throw new Error('task host WAL manifest event has no durable manifest delta');
    }
    return;
  }
  const event = events[0];
  if (
    tx.target_deltas.length !== 0 ||
    events.length !== 1 ||
    tx.host_events.length !== 1 ||
    event === undefined ||
    event.payload.kind !== 'container_manifest.applied' ||
    event.manifest_revision !== manifest.revision ||
    event.payload.revision !== manifest.revision ||
    event.payload.digest !== manifest.digest ||
    event.payload.entry_count !== manifest.entries.length
  ) {
    throw new Error('task host WAL manifest transaction is not atomic');
  }
  validateHostWideEvent(event);
}

function validateHostWideEvent(event: ChannelTaskHostEvent): void {
  if (
    event.target_id !== null ||
    event.task_revision !== null ||
    event.container_generation !== null ||
    event.attempt !== null ||
    event.container !== null
  ) {
    throw new Error('task host WAL host-wide event carries target identity');
  }
}

function validateTaskLifecycleEvent(
  event: ChannelTaskHostEvent,
  target: TaskTargetRecord,
  historical: boolean,
): void {
  const payload = event.payload;
  if (payload.kind !== 'task.lifecycle') return;
  if (payload.phase === 'terminal') {
    if (
      payload.outcome === undefined ||
      (!historical && (
        target.phase !== 'terminal' ||
        target.terminal?.outcome !== payload.outcome ||
        target.terminal.summary !== payload.summary
      ))
    ) {
      throw new Error('task host terminal lifecycle is not authoritative');
    }
    return;
  }
  if (payload.phase === 'blocked') {
    if (
      payload.blocked_code === undefined ||
      payload.retryable === undefined ||
      (!historical && (
        target.phase !== 'blocked' ||
        target.blocked?.code !== payload.blocked_code ||
        target.blocked.retryable !== payload.retryable
      ))
    ) {
      throw new Error('task host blocked lifecycle is not authoritative');
    }
    return;
  }
  if (!historical && payload.phase !== target.phase) {
    throw new Error('task host lifecycle phase does not match its target');
  }
}
