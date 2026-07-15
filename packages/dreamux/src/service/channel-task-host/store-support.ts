import { createHash } from 'node:crypto';

import type { ChannelTaskHostEvent } from '@excitedjs/dreamux-types';

import type { TaskStoreEventInput, TaskTargetRecord } from './types.js';
import { canonicalJson } from './wal.js';

export function eventFor(input: {
  hostStreamId: string;
  streamGeneration: number;
  sequence: number;
  occurredAt: number;
  target: TaskTargetRecord | null;
  input: TaskStoreEventInput;
}): ChannelTaskHostEvent {
  return {
    schema_version: 1,
    event_id: `${input.hostStreamId}:${input.streamGeneration}:${input.sequence}`,
    sequence: input.sequence,
    occurred_at: input.occurredAt,
    target_id: input.target?.target_id ?? null,
    task_revision: input.target?.revision ?? null,
    attempt: input.target === null ? null : clone(input.target.attempt),
    container: input.target === null
      ? null
      : {
          container_type: input.target.container.container_type,
          container_key: input.target.container.container_key,
        },
    payload: clone(input.input.payload),
  };
}

export function deriveSubmissionView(target: TaskTargetRecord) {
  const active = target.submissions
    .filter((entry) => entry.state === 'intent' || entry.state === 'accepted')
    .map((entry) => entry.operation_id);
  const leader = [...target.submissions]
    .reverse()
    .find((entry) => entry.runtime_role === 'leader');
  return {
    active_operation_ids: active,
    last_leader_operation_id: leader?.operation_id ?? null,
    quiescent: active.length === 0 &&
      !target.submissions.some(
        (entry) =>
          entry.state === 'in_doubt' ||
          (entry.settlement !== null &&
            entry.settlement_acknowledged_revision < entry.settlement.revision),
      ),
  };
}

export function validateTargetTransition(
  previous: TaskTargetRecord,
  next: TaskTargetRecord,
): void {
  if (
    previous.target_id !== next.target_id ||
    previous.request_fingerprint !== next.request_fingerprint ||
    previous.receipt.receipt_id !== next.receipt.receipt_id ||
    previous.attempt.task_key !== next.attempt.task_key ||
    previous.attempt.attempt_key !== next.attempt.attempt_key ||
    next.revision !== previous.revision + 1
  ) {
    throw new Error('task target immutable identity or revision changed');
  }
  if (
    previous.terminal !== null &&
    canonicalJson(previous.terminal) !== canonicalJson(next.terminal)
  ) {
    throw new Error('task terminal outcome is immutable');
  }
  if (previous.terminal !== null && next.terminal === null) {
    throw new Error('task terminal outcome cannot be cleared');
  }
  const allowed: Record<TaskTargetRecord['phase'], readonly TaskTargetRecord['phase'][]> = {
    received: ['received', 'provisioning', 'blocked', 'terminal'],
    provisioning: ['provisioning', 'binding_resolved', 'blocked', 'terminal'],
    binding_resolved: ['binding_resolved', 'ready', 'blocked', 'terminal'],
    ready: ['ready', 'running', 'blocked', 'terminal'],
    running: ['running', 'blocked', 'terminal'],
    blocked: ['blocked', 'provisioning', 'binding_resolved', 'ready', 'running', 'terminal'],
    terminal: ['terminal', 'finalizing'],
    finalizing: ['finalizing', 'finalized'],
    finalized: ['finalized'],
  };
  if (!allowed[previous.phase].includes(next.phase)) {
    throw new Error(
      `invalid task phase transition from '${previous.phase}' to '${next.phase}'`,
    );
  }
  if (
    previous.terminal !== null &&
    !['terminal', 'finalizing', 'finalized'].includes(next.phase)
  ) {
    throw new Error('a terminal task cannot return to execution');
  }
  if (next.phase === 'finalized' && next.terminal === null) {
    throw new Error('a task cannot finalize without an explicit terminal outcome');
  }
  if (previous.tombstone && !next.tombstone) {
    throw new Error('a task tombstone cannot be expanded');
  }
  if (next.tombstone && previous.phase !== 'finalized') {
    throw new Error('only a finalized task can become a tombstone');
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function safeSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
