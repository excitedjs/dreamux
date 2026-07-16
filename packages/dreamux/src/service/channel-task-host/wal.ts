import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  truncate,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  ChannelHostStatusCode,
  ChannelTaskHostEvent,
} from '@excitedjs/dreamux-types';

import { isNotFound } from '../../platform/fs-errors.js';
import type {
  RuntimeSubmissionRecord,
  TaskContainerManifestRecord,
  TaskTargetRecord,
} from './types.js';
import {
  TASK_TARGET_RECORD_VERSION,
} from './types.js';
import { emptyTaskContainerManifest } from './container-manifest.js';
import {
  validatePersistedContainerManifest,
  validatePersistedContainerManifestTransition,
} from './container-manifest-record.js';
import { assertJsonDomain, canonicalJson } from './canonical-json.js';
import {
  validateHostEventEnvelope,
  validateManifestTransaction,
  validateNewTargetManifestFence,
} from './wal-domain-validation.js';

const WAL_SCHEMA = 'task_host_tx_v1';
const COMMIT_MARKER = 'task_host_commit_v1';
const FRAME_HEADER_BYTES = 36;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface TaskHostTransaction {
  schema: typeof WAL_SCHEMA;
  commit_marker: typeof COMMIT_MARKER;
  channel_id: string;
  tx_index: number;
  transaction_id: string;
  previous_checksum: string | null;
  committed_at: number;
  host_stream_id: string;
  stream_generation: number;
  container_manifest_delta: TaskContainerManifestRecord | null;
  target_deltas: TaskTargetRecord[];
  host_events: ChannelTaskHostEvent[];
  sequence_allocation: null | { first: number; last: number };
  acknowledged_through: number | null;
  checkpoint: TaskHostCheckpoint | null;
}

export type TaskHostCheckpoint =
  | { checkpoint_id: string; final: false }
  | {
      checkpoint_id: string;
      final: true;
      next_sequence: number;
      acknowledged_through: number;
      replay_floor: number;
      host_status: TaskHostWalState['hostStatus'];
      host_status_code: ChannelHostStatusCode | null;
    };

export interface TaskHostWalState {
  hostStreamId: string;
  txIndex: number;
  tailChecksum: string | null;
  streamGeneration: number;
  nextSequence: number;
  acknowledgedThrough: number;
  replayFloor: number;
  hostStatus: 'recovering' | 'ready' | 'degraded' | 'stopping' | 'stopped';
  hostStatusCode: ChannelHostStatusCode | null;
  containerManifest: TaskContainerManifestRecord;
  targets: Map<string, TaskTargetRecord>;
  events: ChannelTaskHostEvent[];
  checkpointId: string | null;
  checkpointFinalized: boolean;
  checkpointFirstEventSequence: number | null;
  checkpointLastEventSequence: number | null;
}

export function newTransaction(input: Omit<
  TaskHostTransaction,
  'schema' | 'commit_marker' | 'transaction_id'
>): TaskHostTransaction {
  return {
    schema: WAL_SCHEMA,
    commit_marker: COMMIT_MARKER,
    transaction_id: randomUUID(),
    ...input,
  };
}

export function emptyWalState(): TaskHostWalState {
  return {
    hostStreamId: '',
    txIndex: 0,
    tailChecksum: null,
    streamGeneration: 1,
    nextSequence: 1,
    acknowledgedThrough: 0,
    replayFloor: 0,
    hostStatus: 'stopped',
    hostStatusCode: null,
    containerManifest: emptyTaskContainerManifest(),
    targets: new Map(),
    events: [],
    checkpointId: null,
    checkpointFinalized: false,
    checkpointFirstEventSequence: null,
    checkpointLastEventSequence: null,
  };
}

export async function readTaskHostWal(
  path: string,
  expected: { channelId: string; hostStreamId: string },
): Promise<TaskHostWalState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return emptyWalState();
    throw error;
  }
  const state = emptyWalState();
  state.hostStreamId = expected.hostStreamId;
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < FRAME_HEADER_BYTES) {
      await truncateTail(path, offset);
      break;
    }
    const length = bytes.readUInt32BE(offset);
    if (length <= 0 || length > MAX_FRAME_BYTES) {
      throw new Error(`invalid task host WAL frame length at byte ${offset}`);
    }
    const end = offset + FRAME_HEADER_BYTES + length;
    if (end > bytes.length) {
      await truncateTail(path, offset);
      break;
    }
    const expectedChecksum = bytes.subarray(offset + 4, offset + FRAME_HEADER_BYTES);
    const payload = bytes.subarray(offset + FRAME_HEADER_BYTES, end);
    const actualChecksum = createHash('sha256').update(payload).digest();
    if (!actualChecksum.equals(expectedChecksum)) {
      throw new Error(`task host WAL checksum mismatch at byte ${offset}`);
    }
    const tx = JSON.parse(payload.toString('utf8')) as TaskHostTransaction;
    validateTransaction(tx, state, expected.channelId, expected.hostStreamId);
    applyTransaction(state, tx, actualChecksum.toString('hex'));
    offset = end;
  }
  if (state.checkpointId !== null && !state.checkpointFinalized) {
    throw new Error('task host WAL checkpoint is incomplete');
  }
  return state;
}

export function validateTransaction(
  tx: TaskHostTransaction,
  state: TaskHostWalState,
  channelId: string,
  hostStreamId: string,
): void {
  if (tx === null || typeof tx !== 'object' || Array.isArray(tx)) {
    throw new Error('task host WAL transaction payload is invalid');
  }
  if (
    tx.schema !== WAL_SCHEMA ||
    tx.commit_marker !== COMMIT_MARKER ||
    tx.channel_id !== channelId ||
    tx.host_stream_id !== hostStreamId ||
    tx.tx_index !== state.txIndex + 1 ||
    tx.previous_checksum !== state.tailChecksum ||
    !Number.isSafeInteger(tx.tx_index) ||
    !Number.isSafeInteger(tx.committed_at) ||
    typeof tx.transaction_id !== 'string' ||
    tx.transaction_id.length === 0 ||
    !(tx.checkpoint === null || isRecord(tx.checkpoint))
  ) {
    throw new Error('task host WAL transaction chain is invalid');
  }
  if (
    state.txIndex > 0 &&
    tx.stream_generation !== state.streamGeneration
  ) {
    throw new Error('task host WAL stream generation changed without rotation');
  }
  validateCheckpointEnvelope(tx, state);
  if (
    !(tx.container_manifest_delta === null || isRecord(tx.container_manifest_delta)) ||
    !Array.isArray(tx.target_deltas) ||
    !Array.isArray(tx.host_events)
  ) {
    throw new Error('task host WAL transaction payload is invalid');
  }
  if (tx.container_manifest_delta !== null) {
    validatePersistedContainerManifest(tx.container_manifest_delta, channelId);
    if (tx.checkpoint === null) {
      validatePersistedContainerManifestTransition(
        state.containerManifest,
        tx.container_manifest_delta,
      );
    } else if (state.containerManifest.revision !== 0) {
      throw new Error('task host WAL checkpoint repeats the container manifest');
    }
  }
  validateManifestTransaction(tx);
  const targetIds = new Set<string>();
  for (const target of tx.target_deltas) {
    validateTarget(target, channelId);
    if (targetIds.has(target.target_id)) {
      throw new Error('task host WAL transaction repeats a target delta');
    }
    targetIds.add(target.target_id);
    const previous = state.targets.get(target.target_id);
    if (target.manifest_revision > state.containerManifest.revision) {
      throw new Error('task host target is ahead of its durable container manifest');
    }
    if (tx.checkpoint !== null) continue;
    if (previous === undefined) {
      if (target.revision !== 1) {
        throw new Error('new task host target must start at revision 1');
      }
      validateNewTargetManifestFence(target, state.containerManifest);
    } else {
      validatePersistedTargetTransition(previous, target);
    }
  }
  for (const event of tx.host_events) {
    validateHostEventEnvelope(event, tx, state);
  }
  if (tx.checkpoint !== null) {
    validateCheckpointEvents(tx, state, hostStreamId);
  } else if (tx.host_events.length === 0) {
    if (tx.sequence_allocation !== null) {
      throw new Error('empty host-event transaction allocated sequence numbers');
    }
  } else {
    const first = tx.host_events[0]!.sequence;
    const last = tx.host_events.at(-1)!.sequence;
    if (
      tx.sequence_allocation?.first !== first ||
      tx.sequence_allocation.last !== last ||
      first !== state.nextSequence ||
      tx.host_events.some(
        (event, index) =>
          event.sequence !== first + index ||
          event.schema_version !== 1 ||
          event.event_id !== `${hostStreamId}:${tx.stream_generation}:${event.sequence}`,
      )
    ) {
      throw new Error('task host WAL event sequence is not consecutive');
    }
  }
  if (
    tx.checkpoint === null &&
    tx.acknowledged_through !== null &&
    (!Number.isSafeInteger(tx.acknowledged_through) ||
      tx.acknowledged_through < state.acknowledgedThrough ||
      tx.acknowledged_through > state.nextSequence - 1)
  ) {
    throw new Error('task host WAL acknowledgement is invalid');
  }
  if (tx.checkpoint !== null && tx.acknowledged_through !== null) {
    throw new Error('task host WAL checkpoint cannot use an ordinary acknowledgement');
  }
}

function validateCheckpointEnvelope(
  tx: TaskHostTransaction,
  state: TaskHostWalState,
): void {
  const checkpoint = tx.checkpoint;
  if (checkpoint === null) {
    if (state.checkpointId !== null && !state.checkpointFinalized) {
      throw new Error('task host WAL checkpoint is incomplete');
    }
    return;
  }
  if (
    typeof checkpoint.checkpoint_id !== 'string' ||
    checkpoint.checkpoint_id.length === 0 ||
    checkpoint.checkpoint_id.length > 128 ||
    typeof checkpoint.final !== 'boolean' ||
    (state.checkpointId !== null &&
      (state.checkpointFinalized || state.checkpointId !== checkpoint.checkpoint_id))
  ) {
    throw new Error('task host WAL checkpoint chain is invalid');
  }
  if (!checkpoint.final) return;
  if (
    !Number.isSafeInteger(checkpoint.next_sequence) ||
    checkpoint.next_sequence < 1 ||
    !Number.isSafeInteger(checkpoint.acknowledged_through) ||
    checkpoint.acknowledged_through < 0 ||
    !Number.isSafeInteger(checkpoint.replay_floor) ||
    checkpoint.replay_floor !== checkpoint.acknowledged_through ||
    checkpoint.acknowledged_through > checkpoint.next_sequence - 1 ||
    !['recovering', 'ready', 'degraded', 'stopping', 'stopped'].includes(
      checkpoint.host_status,
    ) ||
    !(
      checkpoint.host_status_code === null ||
      checkpoint.host_status_code === 'TASK_FINALIZER_RETRY_REQUIRED'
    ) ||
    (state.checkpointLastEventSequence !== null &&
      state.checkpointLastEventSequence !== checkpoint.next_sequence - 1) ||
    (state.checkpointFirstEventSequence === null
      ? checkpoint.next_sequence !== checkpoint.acknowledged_through + 1
      : state.checkpointFirstEventSequence !== checkpoint.acknowledged_through + 1)
  ) {
    throw new Error('task host WAL checkpoint metadata is invalid');
  }
}

function validateCheckpointEvents(
  tx: TaskHostTransaction,
  state: TaskHostWalState,
  hostStreamId: string,
): void {
  if (tx.sequence_allocation !== null) {
    throw new Error('task host WAL checkpoint cannot allocate new event sequences');
  }
  let previous = state.checkpointLastEventSequence;
  for (const event of tx.host_events) {
    if (
      event.schema_version !== 1 ||
      event.event_id !== `${hostStreamId}:${tx.stream_generation}:${event.sequence}` ||
      !Number.isSafeInteger(event.sequence) ||
      (previous !== null && event.sequence !== previous + 1)
    ) {
      throw new Error('task host WAL checkpoint event sequence is invalid');
    }
    previous = event.sequence;
  }
}

export function applyTransaction(
  state: TaskHostWalState,
  tx: TaskHostTransaction,
  checksum: string,
): void {
  state.txIndex = tx.tx_index;
  state.tailChecksum = checksum;
  state.streamGeneration = tx.stream_generation;
  if (tx.container_manifest_delta !== null) {
    state.containerManifest = structuredClone(tx.container_manifest_delta);
  }
  for (const target of tx.target_deltas) {
    state.targets.set(target.target_id, structuredClone(target));
  }
  state.events.push(...tx.host_events.map((event) => structuredClone(event)));
  if (tx.checkpoint !== null) {
    state.checkpointId = tx.checkpoint.checkpoint_id;
    const first = tx.host_events[0]?.sequence;
    if (first !== undefined && state.checkpointFirstEventSequence === null) {
      state.checkpointFirstEventSequence = first;
    }
    const last = tx.host_events.at(-1)?.sequence;
    if (last !== undefined) state.checkpointLastEventSequence = last;
    if (tx.checkpoint.final) {
      state.nextSequence = tx.checkpoint.next_sequence;
      state.acknowledgedThrough = tx.checkpoint.acknowledged_through;
      state.replayFloor = tx.checkpoint.replay_floor;
      state.hostStatus = tx.checkpoint.host_status;
      state.hostStatusCode = tx.checkpoint.host_status_code;
      state.checkpointFinalized = true;
    }
    return;
  }
  if (state.checkpointFinalized) {
    state.checkpointId = null;
    state.checkpointFinalized = false;
    state.checkpointFirstEventSequence = null;
    state.checkpointLastEventSequence = null;
  }
  for (const event of tx.host_events) {
    if (event.payload.kind === 'host.lifecycle') {
      state.hostStatus = event.payload.status;
      state.hostStatusCode = event.payload.code ?? null;
    }
  }
  state.nextSequence += tx.host_events.length;
  if (tx.acknowledged_through !== null) {
    state.acknowledgedThrough = tx.acknowledged_through;
  }
}

export function encodeFrame(
  tx: TaskHostTransaction,
): { frame: Buffer; checksum: string; transaction: TaskHostTransaction } {
  assertJsonDomain(tx);
  const canonical = canonicalJson(tx);
  const transaction = JSON.parse(canonical) as TaskHostTransaction;
  const payload = Buffer.from(canonical, 'utf8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`task host WAL transaction exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  const digest = createHash('sha256').update(payload).digest();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  digest.copy(header, 4);
  return {
    frame: Buffer.concat([header, payload]),
    checksum: digest.toString('hex'),
    transaction,
  };
}

export async function appendFrame(path: string, frame: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function writeRotatedWal(path: string, frame: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

function validateTarget(target: TaskTargetRecord, channelId: string): void {
  if (
    target.version !== TASK_TARGET_RECORD_VERSION ||
    target.channel_id !== channelId ||
    target.target_id === '' ||
    target.receipt.target_id !== target.target_id ||
    target.receipt.manifest_revision !== target.manifest_revision ||
    target.receipt.container_generation !== target.container_generation ||
    !Number.isSafeInteger(target.manifest_revision) ||
    target.manifest_revision < 0 ||
    !Number.isSafeInteger(target.container_generation) ||
    target.container_generation < 1 ||
    !Number.isSafeInteger(target.revision) ||
    target.revision < 1 ||
    !Number.isSafeInteger(target.created_at) ||
    !Number.isSafeInteger(target.updated_at) ||
    !Number.isSafeInteger(target.terminal_revision) ||
    !Number.isSafeInteger(target.last_host_sequence) ||
    target.last_host_sequence < 0 ||
    !Array.isArray(target.submissions)
  ) {
    throw new Error(`invalid task host target '${String(target.target_id)}'`);
  }
  if (target.tombstone) {
    if (
      target.phase !== 'finalized' ||
      target.terminal === null ||
      target.logical_repository !== null ||
      target.resolved_repository !== null ||
      target.title !== null ||
      target.turn !== null ||
      target.binding !== null ||
      target.submissions.length !== 0
    ) {
      throw new Error(`invalid task host tombstone '${target.target_id}'`);
    }
  } else if (target.resolved_repository === null) {
    throw new Error(`task host target '${target.target_id}' has no repository policy`);
  }
  const operationIds = new Set<string>();
  for (const submission of target.submissions) {
    if (
      typeof submission.operation_id !== 'string' ||
      submission.operation_id === '' ||
      operationIds.has(submission.operation_id) ||
      typeof submission.input_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(submission.input_digest) ||
      !['leader', 'member'].includes(submission.runtime_role) ||
      (submission.runtime_id !== null &&
        (typeof submission.runtime_id !== 'string' || submission.runtime_id === '')) ||
      (submission.durability_namespace !== null &&
        (typeof submission.durability_namespace !== 'string' ||
          submission.durability_namespace === '')) ||
      (submission.state !== 'intent' && submission.state !== 'in_doubt' &&
        (submission.runtime_id === null || submission.durability_namespace === null)) ||
      !validSubmissionDelivery(submission.delivery) ||
      !validSubmissionEffect(submission.kind, submission.effect) ||
      !Number.isSafeInteger(submission.runtime_revision) ||
      !Number.isSafeInteger(submission.settlement_acknowledged_revision) ||
      !Number.isSafeInteger(submission.created_at) ||
      !Number.isSafeInteger(submission.updated_at)
    ) {
      throw new Error(`invalid task host submission '${String(submission.operation_id)}'`);
    }
    operationIds.add(submission.operation_id);
  }
}

function validSubmissionDelivery(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value['input'])) return false;
  if (value['kind'] === 'channel') {
    return typeof value['input']['text'] === 'string' &&
      typeof value['input']['sourceId'] === 'string';
  }
  if (value['kind'] === 'text') {
    return typeof value['input']['text'] === 'string' &&
      (value['input']['sourceId'] === undefined ||
        typeof value['input']['sourceId'] === 'string');
  }
  return false;
}

function validSubmissionEffect(
  kind: RuntimeSubmissionRecord['kind'],
  value: unknown,
): boolean {
  if (!isRecord(value) || value['kind'] !== kind) return false;
  switch (kind) {
    case 'root':
      return true;
    case 'completion':
      return typeof value['source_operation_id'] === 'string' &&
        value['source_operation_id'] !== '';
    case 'spawn':
      return typeof value['teammate_name'] === 'string' &&
        value['teammate_name'] !== '' &&
        typeof value['agent_runtime'] === 'string' &&
        value['agent_runtime'] !== '' &&
        typeof value['intent'] === 'string' &&
        (value['identity'] === null || typeof value['identity'] === 'string') &&
        Array.isArray(value['skill_sources']);
    case 'send':
      return (value['teammate_name'] === null ||
        typeof value['teammate_name'] === 'string') &&
        (value['intent'] === null || typeof value['intent'] === 'string');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePersistedTargetTransition(
  previous: TaskTargetRecord,
  next: TaskTargetRecord,
): void {
  if (
    next.revision !== previous.revision + 1 ||
    next.target_id !== previous.target_id ||
    next.request_fingerprint !== previous.request_fingerprint ||
    next.receipt.receipt_id !== previous.receipt.receipt_id ||
    next.canonical_target_key !== previous.canonical_target_key ||
    next.attempt.task_key !== previous.attempt.task_key ||
    next.attempt.attempt_key !== previous.attempt.attempt_key ||
    canonicalJson(next.repository_binding) !==
      canonicalJson(previous.repository_binding) ||
    (!next.tombstone && canonicalJson(next.resolved_repository) !==
      canonicalJson(previous.resolved_repository)) ||
    next.last_host_sequence < previous.last_host_sequence ||
    canonicalJson(next.terminal) !== canonicalJson(previous.terminal) &&
      previous.terminal !== null
  ) {
    throw new Error('task host WAL target transition is invalid');
  }
  if (
    previous.terminal !== null &&
    (next.terminal === null ||
      !['terminal', 'finalizing', 'finalized'].includes(next.phase))
  ) {
    throw new Error('task host WAL terminal latch regressed');
  }
  if (previous.phase === 'finalized' && next.phase !== 'finalized') {
    throw new Error('task host WAL finalized target regressed');
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
    throw new Error('task host WAL target phase transition is invalid');
  }
}

async function truncateTail(path: string, length: number): Promise<void> {
  await truncate(path, length);
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
