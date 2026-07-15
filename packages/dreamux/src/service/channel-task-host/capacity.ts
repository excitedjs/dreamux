import type { TaskHostWalState } from './wal.js';
import type { TaskTargetRecord } from './types.js';
import { canonicalJson } from './wal.js';

const MAX_TARGET_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_TARGET_BYTES = 3 * 1024 * 1024;
const MAX_DURABLE_STATE_BYTES = 16 * 1024 * 1024;
// A legal 64 KiB UTF-8 result can occupy six bytes per input byte after JSON
// escaping (for example NUL becomes "\\u0000"). Reserves are canonical-WAL
// bytes, not raw input bytes.
const TARGET_LIFECYCLE_RESERVE_BYTES = 416 * 1024;
const OPERATION_SETTLEMENT_RESERVE_BYTES = 416 * 1024;
const MEMBER_COMPLETION_RESERVE_BYTES = 2 * OPERATION_SETTLEMENT_RESERVE_BYTES;
const ADMISSION_EVENT_RESERVE_BYTES = 16 * 1024;
const MAX_TARGETS = 10_000;

export class TaskHostBackpressureError extends Error {
  constructor(message = 'task host durable capacity is exhausted') {
    super(message);
    this.name = 'TaskHostBackpressureError';
  }
}

export function assertTargetFrameCapacity(target: TaskTargetRecord): void {
  if (serializedBytes(target) > MAX_TARGET_BYTES) {
    throw new TaskHostBackpressureError('task target exceeds the WAL frame budget');
  }
}

export function assertOperationCapacity(
  state: TaskHostWalState,
  candidate: TaskTargetRecord,
): void {
  const candidateBytes = serializedBytes(candidate);
  if (
    candidateBytes > MAX_OPERATION_TARGET_BYTES ||
    candidateBytes + TARGET_LIFECYCLE_RESERVE_BYTES +
        operationReserveBytes(candidate) > MAX_TARGET_BYTES
  ) {
    throw new TaskHostBackpressureError('task target operation budget is exhausted');
  }
  if (reservedCapacityBytes(state, withCandidate(state, candidate)) >
      MAX_DURABLE_STATE_BYTES) {
    throw new TaskHostBackpressureError();
  }
}

export function assertTaskAdmissionCapacity(
  state: TaskHostWalState,
  candidate: TaskTargetRecord,
): void {
  if (state.targets.size >= MAX_TARGETS) throw new TaskHostBackpressureError();
  if (
    serializedBytes(candidate) + TARGET_LIFECYCLE_RESERVE_BYTES >
      MAX_TARGET_BYTES ||
    reservedCapacityBytes(state, withCandidate(state, candidate)) >
      MAX_DURABLE_STATE_BYTES
  ) {
    throw new TaskHostBackpressureError();
  }
}

export function assertRecoveredCapacity(state: TaskHostWalState): void {
  if (state.targets.size > MAX_TARGETS) {
    throw new Error('task host durable target count exceeds its recovery limit');
  }
  for (const target of state.targets.values()) assertTargetFrameCapacity(target);
  if (checkpointBytes(state, state.targets.values()) > MAX_DURABLE_STATE_BYTES) {
    throw new Error('task host durable state exceeds its recovery limit');
  }
  for (const target of state.targets.values()) {
    if (
      target.phase !== 'finalized' &&
      serializedBytes(target) + TARGET_LIFECYCLE_RESERVE_BYTES +
          operationReserveBytes(target) > MAX_TARGET_BYTES
    ) {
      throw new Error('task host target cannot safely persist runtime settlement');
    }
  }
}

export function assertCheckpointCapacity(state: TaskHostWalState): void {
  if (checkpointBytes(state, state.targets.values()) > MAX_DURABLE_STATE_BYTES) {
    throw new TaskHostBackpressureError(
      'task host durable state exceeds the checkpoint budget',
    );
  }
}

export function canAcceptTask(state: TaskHostWalState): boolean {
  return state.targets.size < MAX_TARGETS &&
    reservedCapacityBytes(state, state.targets.values()) +
    TARGET_LIFECYCLE_RESERVE_BYTES + ADMISSION_EVENT_RESERVE_BYTES <=
      MAX_DURABLE_STATE_BYTES;
}

function reservedCapacityBytes(
  state: TaskHostWalState,
  targets: Iterable<TaskTargetRecord>,
): number {
  let bytes = checkpointBytes(state, targets);
  for (const target of targets) {
    if (target.phase === 'finalized') continue;
    bytes += TARGET_LIFECYCLE_RESERVE_BYTES;
    bytes += operationReserveBytes(target);
  }
  return bytes;
}

function checkpointBytes(
  state: TaskHostWalState,
  targets: Iterable<TaskTargetRecord>,
): number {
  let bytes = state.events
    .filter((event) => event.sequence > state.acknowledgedThrough)
    .reduce((total, event) => total + serializedBytes(event), 0);
  for (const target of targets) bytes += serializedBytes(target);
  return bytes;
}

function operationReserveBytes(target: TaskTargetRecord): number {
  let bytes = 0;
  for (const submission of target.submissions) {
    if (submission.state === 'intent' || submission.state === 'accepted') {
      bytes += OPERATION_SETTLEMENT_RESERVE_BYTES;
      if (submission.runtime_role === 'member') {
        bytes += MEMBER_COMPLETION_RESERVE_BYTES;
      }
      continue;
    }
    if (
      submission.state === 'settled' &&
      submission.runtime_role === 'member' &&
      !target.submissions.some((candidate) =>
        candidate.effect.kind === 'completion' &&
        candidate.effect.source_operation_id === submission.operation_id
      )
    ) {
      // The member result is already present. Reserve its future leader
      // completion delivery copy and that completion turn's settlement.
      bytes += MEMBER_COMPLETION_RESERVE_BYTES;
    }
  }
  return bytes;
}

function withCandidate(
  state: TaskHostWalState,
  candidate: TaskTargetRecord,
): TaskTargetRecord[] {
  const targets = [...state.targets.values()];
  const index = targets.findIndex((target) => target.target_id === candidate.target_id);
  if (index === -1) targets.push(candidate);
  else targets[index] = candidate;
  return targets;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
