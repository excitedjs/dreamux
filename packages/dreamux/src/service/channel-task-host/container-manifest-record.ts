import type {
  ChannelLogicalRepositoryBinding,
  ChannelTaskContainerManifest,
  ChannelTaskRepositoryResolution,
} from '@excitedjs/dreamux-types';

import {
  containerManifestDigest,
  containerManifestKey,
  normalizeContainerManifest,
  validateContainerManifestTransition,
} from './container-manifest.js';
import type {
  TaskContainerManifestEntryRecord,
  TaskContainerManifestRecord,
  TaskRepositoryPolicy,
} from './types.js';
import { TASK_CONTAINER_MANIFEST_RECORD_VERSION } from './types.js';

const MAX_IDENTITY_BYTES = 512;
const MAX_CONTAINER_KEY_BYTES = 2_048;
const MAX_PATH_BYTES = 8_192;

export function validatePersistedContainerManifest(
  value: unknown,
  channelId: string,
): asserts value is TaskContainerManifestRecord {
  if (!record(value) || !exactKeys(value, [
    'version',
    'revision',
    'digest',
    'applied_at',
    'entries',
  ])) {
    invalidManifest(channelId);
  }
  if (
    value['version'] !== TASK_CONTAINER_MANIFEST_RECORD_VERSION ||
    !nonNegativeInteger(value['revision']) ||
    !nonNegativeInteger(value['applied_at']) ||
    typeof value['digest'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['digest']) ||
    !Array.isArray(value['entries']) ||
    value['entries'].length > 100
  ) {
    invalidManifest(channelId);
  }
  const entries = value['entries'].map((entry) =>
    validateEntry(entry, channelId));
  const manifest = publicManifest(value['revision'], entries);
  let normalized: ChannelTaskContainerManifest;
  try {
    normalized = normalizeContainerManifest(manifest);
  } catch {
    invalidManifest(channelId);
  }
  if (
    canonicalJson(normalized) !== canonicalJson(manifest) ||
    containerManifestDigest(normalized) !== value['digest']
  ) {
    invalidManifest(channelId);
  }
}

export function validatePersistedContainerManifestTransition(
  previous: TaskContainerManifestRecord,
  next: TaskContainerManifestRecord,
): void {
  validateContainerManifestTransition(previous, next);
  const nextByKey = new Map(next.entries.map((entry) => [
    containerManifestKey(entry.container),
    entry,
  ]));
  for (const current of previous.entries) {
    const candidate = nextByKey.get(containerManifestKey(current.container));
    if (
      candidate === undefined ||
      candidate.generation !== current.generation ||
      candidate.state === 'revoked' ||
      current.resolved_repository === null
    ) {
      continue;
    }
    if (
      canonicalJson(candidate.resolved_repository) !==
        canonicalJson(current.resolved_repository) ||
      canonicalJson(candidate.resolution) !== canonicalJson(current.resolution)
    ) {
      throw new Error('task host resolved repository policy changed within a generation');
    }
  }
}

function validateEntry(
  value: unknown,
  channelId: string,
): TaskContainerManifestEntryRecord {
  if (!record(value) || !exactKeys(value, [
    'container',
    'generation',
    'state',
    'logical_repository',
    'resolved_repository',
    'resolution',
    'tombstoned_at',
  ])) {
    return invalidEntry(channelId);
  }
  const container = value['container'];
  if (
    !record(container) ||
    !exactKeys(container, ['container_type', 'container_key']) ||
    !bounded(container['container_type'], MAX_IDENTITY_BYTES) ||
    !bounded(container['container_key'], MAX_CONTAINER_KEY_BYTES) ||
    !positiveInteger(value['generation']) ||
    !['active', 'draining', 'revoked'].includes(String(value['state']))
  ) {
    return invalidEntry(channelId);
  }
  const state = value['state'] as TaskContainerManifestEntryRecord['state'];
  const logical = validateLogicalRepository(value['logical_repository'], channelId);
  const resolved = validateResolvedRepository(value['resolved_repository'], channelId);
  const resolution = validateResolution(value['resolution'], channelId);
  const tombstonedAt = value['tombstoned_at'];
  if (
    (state === 'revoked') !== nonNegativeInteger(tombstonedAt) ||
    (state === 'revoked') !== (resolution.status === 'revoked') ||
    (resolution.status === 'ready') !== (resolved !== null) ||
    (state !== 'revoked' && resolution.status === 'revoked') ||
    (resolved !== null && (
      resolution.status !== 'ready' ||
      resolved.binding_revision !== resolution.binding_revision ||
      resolved.fingerprint !== resolution.fingerprint ||
      resolved.logical_key !== (resolved.source === 'static'
        ? '@static'
        : logical?.repository_key)
    ))
  ) {
    return invalidEntry(channelId);
  }
  return value as unknown as TaskContainerManifestEntryRecord;
}

function validateLogicalRepository(
  value: unknown,
  channelId: string,
): ChannelLogicalRepositoryBinding | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !onlyKeys(value, ['repository_key', 'expected_revision']) ||
    !bounded(value['repository_key'], MAX_IDENTITY_BYTES) ||
    !(value['expected_revision'] === undefined ||
      bounded(value['expected_revision'], MAX_IDENTITY_BYTES))
  ) {
    return invalidEntry(channelId);
  }
  return value as unknown as ChannelLogicalRepositoryBinding;
}

function validateResolvedRepository(
  value: unknown,
  channelId: string,
): TaskRepositoryPolicy | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !exactKeys(value, [
      'source',
      'logical_key',
      'binding_revision',
      'fingerprint',
      'repo_cwd',
      'base_ref',
      'base_commit',
    ]) ||
    !['static', 'channel'].includes(String(value['source'])) ||
    !bounded(value['logical_key'], MAX_IDENTITY_BYTES) ||
    !bounded(value['binding_revision'], MAX_IDENTITY_BYTES) ||
    typeof value['fingerprint'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['fingerprint']) ||
    !bounded(value['repo_cwd'], MAX_PATH_BYTES) ||
    !(value['base_ref'] === null || bounded(value['base_ref'], MAX_PATH_BYTES)) ||
    typeof value['base_commit'] !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value['base_commit'])
  ) {
    return invalidEntry(channelId);
  }
  return value as unknown as TaskRepositoryPolicy;
}

function validateResolution(
  value: unknown,
  channelId: string,
): ChannelTaskRepositoryResolution {
  if (!record(value) || typeof value['status'] !== 'string') {
    return invalidEntry(channelId);
  }
  if (value['status'] === 'revoked' && exactKeys(value, ['status'])) {
    return value as unknown as ChannelTaskRepositoryResolution;
  }
  if (
    value['status'] === 'ready' &&
    exactKeys(value, ['status', 'binding_revision', 'fingerprint']) &&
    bounded(value['binding_revision'], MAX_IDENTITY_BYTES) &&
    typeof value['fingerprint'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['fingerprint'])
  ) {
    return value as unknown as ChannelTaskRepositoryResolution;
  }
  if (
    value['status'] === 'unavailable' &&
    exactKeys(value, ['status', 'code', 'retryable']) &&
    [
      'TASK_DEFAULT_BINDING_DISABLED',
      'TASK_REPOSITORY_BINDING_MISSING',
      'TASK_REPOSITORY_BINDING_MISMATCH',
      'TASK_REPOSITORY_NOT_MANAGED',
    ].includes(String(value['code'])) &&
    typeof value['retryable'] === 'boolean'
  ) {
    return value as unknown as ChannelTaskRepositoryResolution;
  }
  return invalidEntry(channelId);
}

function publicManifest(
  revision: number,
  entries: readonly TaskContainerManifestEntryRecord[],
): ChannelTaskContainerManifest {
  return {
    revision,
    entries: entries.map((entry) => ({
      container: structuredClone(entry.container),
      generation: entry.generation,
      state: entry.state,
      ...(entry.logical_repository !== null
        ? { repository: structuredClone(entry.logical_repository) }
        : {}),
      ...(entry.tombstoned_at !== null
        ? { tombstoned_at: entry.tombstoned_at }
        : {}),
    })),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim() !== '' &&
    Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function invalidManifest(channelId: string): never {
  throw new Error(`invalid task host container manifest for '${channelId}'`);
}

function invalidEntry(channelId: string): never {
  throw new Error(`invalid task host container manifest entry for '${channelId}'`);
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
