import { createHash } from 'node:crypto';

import type {
  ChannelTaskAttemptIdentity,
  ChannelTaskSubmitInput,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

const MAX_IDENTITY_LENGTH = 512;
const MAX_CONTAINER_KEY_LENGTH = 2048;
const MAX_TITLE_LENGTH = 2000;
const MAX_TURN_TEXT_LENGTH = 256 * 1024;
const MAX_BODY_LENGTH = 512 * 1024;
const MAX_ATTACHMENTS = 64;
const MAX_ATTRIBUTES = 64;

export interface CanonicalTaskIdentity {
  targetId: string;
  targetKey: string;
  receiptId: string;
  teamName: string;
  worktreeSlug: string;
  routeClaimId: string;
}

export function validateTaskSubmitInput(input: ChannelTaskSubmitInput): void {
  exactKeys(input, [
    'attempt',
    'container',
    'manifest_revision',
    'container_generation',
    'repository',
    'turn',
    'title',
  ]);
  exactKeys(input.attempt, ['task_key', 'attempt_key']);
  exactKeys(input.container, ['container_type', 'container_key']);
  validateAttempt(input.attempt);
  bounded(input.container.container_type, 'container_type', MAX_IDENTITY_LENGTH);
  bounded(input.container.container_key, 'container_key', MAX_CONTAINER_KEY_LENGTH);
  nonNegativeSafeInteger(input.manifest_revision, 'manifest_revision');
  positiveSafeInteger(input.container_generation, 'container_generation');
  if (input.repository !== undefined) {
    exactKeys(input.repository, ['repository_key', 'expected_revision']);
    bounded(input.repository.repository_key, 'repository_key', MAX_IDENTITY_LENGTH);
    if (input.repository.expected_revision !== undefined) {
      bounded(input.repository.expected_revision, 'expected_revision', MAX_IDENTITY_LENGTH);
    }
  }
  if (input.title !== undefined) bounded(input.title, 'title', MAX_TITLE_LENGTH, true);
  validateTurn(input.turn);
}

export function validateTaskCancelInput(input: {
  attempt: ChannelTaskAttemptIdentity;
  container: { container_type: string; container_key: string };
  manifest_revision: number;
  container_generation: number;
  reason?: string;
}): void {
  exactKeys(input, [
    'attempt',
    'container',
    'manifest_revision',
    'container_generation',
    'reason',
  ]);
  exactKeys(input.attempt, ['task_key', 'attempt_key']);
  exactKeys(input.container, ['container_type', 'container_key']);
  validateAttempt(input.attempt);
  bounded(input.container.container_type, 'container_type', MAX_IDENTITY_LENGTH);
  bounded(input.container.container_key, 'container_key', MAX_CONTAINER_KEY_LENGTH);
  nonNegativeSafeInteger(input.manifest_revision, 'manifest_revision');
  positiveSafeInteger(input.container_generation, 'container_generation');
  if (input.reason !== undefined) bounded(input.reason, 'reason', 64 * 1024, true);
}

export function validateTaskLookupInput(
  attempt: ChannelTaskAttemptIdentity,
  container: { container_type: string; container_key: string },
): void {
  exactKeys(attempt, ['task_key', 'attempt_key']);
  exactKeys(container, ['container_type', 'container_key']);
  validateAttempt(attempt);
  bounded(container.container_type, 'container_type', MAX_IDENTITY_LENGTH);
  bounded(container.container_key, 'container_key', MAX_CONTAINER_KEY_LENGTH);
}

export function canonicalTaskIdentity(input: {
  dispatcherId: string;
  channelId: string;
  containerType: string;
  containerKey: string;
  attempt: ChannelTaskAttemptIdentity;
}): CanonicalTaskIdentity {
  const digest = digestFields([
    'task-attempt-v1',
    input.dispatcherId,
    input.channelId,
    input.containerType,
    input.containerKey,
    input.attempt.task_key,
    input.attempt.attempt_key,
  ]);
  const opaque = digest.toString('base64url');
  const nameHash = digest.toString('hex').slice(0, 32);
  const targetId = `task_v1_${opaque}`;
  return {
    targetId,
    targetKey: `dreamux.task-attempt.v1:${opaque}`,
    receiptId: `receipt_v1_${opaque}`,
    teamName: `task-${nameHash}`,
    worktreeSlug: `task-${nameHash}`,
    routeClaimId: `task-host:${opaque}`,
  };
}

export function taskRequestFingerprint(input: ChannelTaskSubmitInput): string {
  return createHash('sha256')
    .update(canonicalJson({
      attempt: input.attempt,
      container: {
        container_type: input.container.container_type,
        container_key: input.container.container_key,
      },
      container_generation: input.container_generation,
      turn: taskTurnForFingerprint(input.turn),
    }))
    .digest('hex');
}

export function durableSubmissionInputDigest(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function taskOperationId(input: {
  targetId: string;
  parentOperationId: string | null;
  toolCallId: string;
  toolCallOrdinal: number;
  kind: 'root' | 'completion' | 'spawn' | 'send';
}): string {
  if (!Number.isSafeInteger(input.toolCallOrdinal) || input.toolCallOrdinal < 0) {
    throw new Error('tool call ordinal must be a non-negative safe integer');
  }
  const digest = digestFields([
    'task-operation-v1',
    input.targetId,
    input.parentOperationId ?? '',
    input.toolCallId,
    String(input.toolCallOrdinal),
    input.kind,
  ]);
  return `op_v1_${digest.toString('base64url')}`;
}

function validateAttempt(attempt: ChannelTaskAttemptIdentity): void {
  bounded(attempt.task_key, 'task_key', MAX_IDENTITY_LENGTH);
  bounded(attempt.attempt_key, 'attempt_key', MAX_IDENTITY_LENGTH);
}

function validateTurn(turn: InboundTurnInput): void {
  exactKeys(turn, [
    'text',
    'sourceId',
    'source',
    'attrs',
    'body',
    'attachments',
  ]);
  bounded(turn.sourceId, 'turn.sourceId', MAX_IDENTITY_LENGTH, true);
  if (turn.source !== undefined) {
    bounded(turn.source, 'turn.source', MAX_IDENTITY_LENGTH, true);
  }
  bounded(turn.text, 'turn.text', MAX_TURN_TEXT_LENGTH, true);
  if (turn.body !== undefined) bounded(turn.body, 'turn.body', MAX_BODY_LENGTH, true);
  if ((turn.attrs?.length ?? 0) > MAX_ATTRIBUTES) {
    throw new Error(`turn.attrs exceeds ${MAX_ATTRIBUTES} entries`);
  }
  for (const attribute of turn.attrs ?? []) {
    if (!Array.isArray(attribute) || attribute.length !== 2) {
      throw new Error('turn.attrs entries must be string pairs');
    }
    const [key, value] = attribute;
    bounded(key, 'turn.attrs key', MAX_IDENTITY_LENGTH, true);
    bounded(value, 'turn.attrs value', MAX_TITLE_LENGTH, true);
  }
  if ((turn.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
    throw new Error(`turn.attachments exceeds ${MAX_ATTACHMENTS} entries`);
  }
  for (const attachment of turn.attachments ?? []) {
    exactKeys(attachment, ['kind', 'name']);
    bounded(attachment.kind, 'attachment.kind', MAX_IDENTITY_LENGTH);
    if (attachment.name !== undefined) {
      bounded(attachment.name, 'attachment.name', MAX_TITLE_LENGTH, true);
    }
  }
}

function exactKeys(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('task input objects must be JSON objects');
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('task input contains an unsupported field');
  }
}

function bounded(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim() === '') ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded ${allowEmpty ? '' : 'non-empty '}string`);
  }
}

function nonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function positiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function taskTurnForFingerprint(turn: InboundTurnInput): unknown {
  return {
    text: turn.text,
    ...(turn.source !== undefined ? { source: turn.source } : {}),
    ...(turn.attrs !== undefined ? { attrs: turn.attrs } : {}),
    ...(turn.body !== undefined ? { body: turn.body } : {}),
    ...(turn.attachments !== undefined ? { attachments: turn.attachments } : {}),
  };
}

function digestFields(fields: readonly string[]): Buffer {
  const hash = createHash('sha256');
  for (const field of fields) {
    const value = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    hash.update(length).update(value);
  }
  return hash.digest();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
