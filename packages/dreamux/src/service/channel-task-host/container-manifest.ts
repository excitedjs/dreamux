import { createHash } from 'node:crypto';

import type {
  ChannelLogicalRepositoryBinding,
  ChannelTaskContainerManifest,
  ChannelTaskContainerManifestApplyInput,
  ChannelTaskContainerManifestEntry,
  ChannelTaskContainerManifestState,
} from '@excitedjs/dreamux-types';

import type { ChannelService } from '../channel-service/index.js';
import { resolveTaskRepositoryPolicy } from './repository-policy.js';
import type {
  TaskContainerManifestApplyCandidate,
  TaskContainerManifestEntryRecord,
  TaskContainerManifestRecord,
} from './types.js';
import { TASK_CONTAINER_MANIFEST_RECORD_VERSION } from './types.js';

const MAX_MANIFEST_ENTRIES = 100;
const MAX_IDENTITY_LENGTH = 512;
const MAX_CONTAINER_KEY_LENGTH = 2_048;

export function emptyTaskContainerManifest(): TaskContainerManifestRecord {
  const manifest: ChannelTaskContainerManifest = { revision: 0, entries: [] };
  return {
    version: TASK_CONTAINER_MANIFEST_RECORD_VERSION,
    revision: 0,
    digest: containerManifestDigest(manifest),
    applied_at: 0,
    entries: [],
  };
}

export async function resolveContainerManifest(input: {
  manifest: ChannelTaskContainerManifest;
  channels: ChannelService;
  channelId: string;
}): Promise<TaskContainerManifestApplyCandidate> {
  const manifest = normalizeContainerManifest(input.manifest);
  const entries: TaskContainerManifestEntryRecord[] = [];
  for (const entry of manifest.entries) {
    if (entry.state === 'revoked') {
      entries.push({
        container: structuredClone(entry.container),
        generation: entry.generation,
        state: entry.state,
        logical_repository: structuredClone(entry.repository ?? null),
        resolved_repository: null,
        resolution: { status: 'revoked' },
        tombstoned_at: entry.tombstoned_at!,
      });
      continue;
    }
    const resolution = await resolveTaskRepositoryPolicy({
      channels: input.channels,
      channelId: input.channelId,
      logical: entry.repository,
    });
    if (resolution.status === 'resolved') {
      entries.push({
        container: structuredClone(entry.container),
        generation: entry.generation,
        state: entry.state,
        logical_repository: structuredClone(entry.repository ?? null),
        resolved_repository: structuredClone(resolution.policy),
        resolution: {
          status: 'ready',
          binding_revision: resolution.policy.binding_revision,
          fingerprint: resolution.policy.fingerprint,
        },
        tombstoned_at: null,
      });
    } else {
      entries.push({
        container: structuredClone(entry.container),
        generation: entry.generation,
        state: entry.state,
        logical_repository: structuredClone(entry.repository ?? null),
        resolved_repository: null,
        resolution: {
          status: 'unavailable',
          code: resolution.code,
          retryable: resolution.retryable,
        },
        tombstoned_at: null,
      });
    }
  }
  return { manifest, digest: containerManifestDigest(manifest), entries };
}

export function normalizeContainerManifest(
  value: ChannelTaskContainerManifest,
): ChannelTaskContainerManifest {
  exactKeys(value, ['revision', 'entries']);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('container manifest revision must be a non-negative safe integer');
  }
  if (!Array.isArray(value.entries) || value.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new Error(`container manifest exceeds ${MAX_MANIFEST_ENTRIES} entries`);
  }
  if (value.revision === 0 && value.entries.length !== 0) {
    throw new Error('container manifest revision zero must be empty');
  }
  const keys = new Set<string>();
  const entries = value.entries.map((entry) => normalizeEntry(entry));
  for (const entry of entries) {
    const key = containerManifestKey(entry.container);
    if (keys.has(key)) throw new Error('container manifest repeats a container');
    keys.add(key);
  }
  entries.sort((left, right) =>
    containerManifestKey(left.container).localeCompare(
      containerManifestKey(right.container),
    )
  );
  return { revision: value.revision, entries };
}

export function normalizeContainerManifestApplyInput(
  value: ChannelTaskContainerManifestApplyInput,
): ChannelTaskContainerManifest {
  exactKeys(value, ['manifest']);
  return normalizeContainerManifest(value.manifest);
}

export function validateContainerManifestTransition(
  previous: TaskContainerManifestRecord,
  next: TaskContainerManifestRecord,
): void {
  if (next.revision <= previous.revision) {
    throw new Error('container manifest revision must advance');
  }
  const candidates = new Map(
    next.entries.map((entry) => [containerManifestKey(entry.container), entry]),
  );
  for (const current of previous.entries) {
    const candidate = candidates.get(containerManifestKey(current.container));
    if (candidate === undefined) {
      throw new Error('container removal requires an explicit revoked tombstone');
    }
    if (candidate.generation < current.generation) {
      throw new Error('container generation cannot move backwards');
    }
    if (candidate.generation === current.generation) {
      if (current.state === 'revoked' && candidate.state !== 'revoked') {
        throw new Error('reviving a container requires a new generation');
      }
      if (!sameLogicalRepository(
        current.logical_repository,
        candidate.logical_repository,
      )) {
        throw new Error('repository rebinding requires a new generation');
      }
      if (
        current.state === 'revoked' &&
        candidate.tombstoned_at !== current.tombstoned_at
      ) {
        throw new Error('a container tombstone timestamp is immutable');
      }
    }
  }
}

export function publicContainerManifestState(
  record: TaskContainerManifestRecord,
): ChannelTaskContainerManifestState {
  return {
    manifest: {
      revision: record.revision,
      entries: record.entries.map((entry) => ({
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
    },
    digest: record.digest,
    applied_at: record.applied_at,
    resolutions: record.entries.map((entry) => ({
      container: structuredClone(entry.container),
      generation: entry.generation,
      resolution: structuredClone(entry.resolution),
    })),
  };
}

export function containerManifestKey(input: {
  container_type: string;
  container_key: string;
}): string {
  return `${input.container_type.length}:${input.container_type}${input.container_key}`;
}

function normalizeEntry(
  value: ChannelTaskContainerManifestEntry,
): ChannelTaskContainerManifestEntry {
  exactKeys(value, [
    'container',
    'generation',
    'state',
    'repository',
    'tombstoned_at',
  ]);
  exactKeys(value.container, ['container_type', 'container_key']);
  bounded(value.container.container_type, 'container_type', MAX_IDENTITY_LENGTH);
  bounded(value.container.container_key, 'container_key', MAX_CONTAINER_KEY_LENGTH);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error('container generation must be a positive safe integer');
  }
  if (!['active', 'draining', 'revoked'].includes(value.state)) {
    throw new Error('container manifest state is invalid');
  }
  if (value.repository !== undefined) {
    exactKeys(value.repository, ['repository_key', 'expected_revision']);
    bounded(value.repository.repository_key, 'repository_key', MAX_IDENTITY_LENGTH);
    if (value.repository.expected_revision !== undefined) {
      bounded(
        value.repository.expected_revision,
        'expected_revision',
        MAX_IDENTITY_LENGTH,
      );
    }
  }
  if (value.state === 'revoked') {
    if (!Number.isSafeInteger(value.tombstoned_at) || value.tombstoned_at! < 0) {
      throw new Error('revoked containers require a safe-integer tombstone timestamp');
    }
  } else if (value.tombstoned_at !== undefined) {
    throw new Error('live containers cannot carry a tombstone timestamp');
  }
  return structuredClone(value);
}

export function containerManifestDigest(
  manifest: ChannelTaskContainerManifest,
): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function sameLogicalRepository(
  left: ChannelLogicalRepositoryBinding | null,
  right: ChannelLogicalRepositoryBinding | null,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactKeys(value: unknown, allowed: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('container manifest values must be JSON objects');
  }
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error('container manifest contains an unsupported field');
  }
}

function bounded(value: unknown, label: string, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
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
