import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherDir } from '../../platform/paths.js';

const MANIFEST_SCHEMA = 'dreamux_task_host_manifest_v1';
const MANIFEST_FILE = 'manifest.json';

export interface TaskHostManifest {
  schema: typeof MANIFEST_SCHEMA;
  dispatcher_id: string;
  channel_id: string;
  provider_ref: string;
  host_stream_id: string;
  created_at: number;
}

export interface DiscoveredTaskHostManifest {
  rootDir: string;
  manifest: TaskHostManifest;
}

export async function ensureTaskHostManifest(input: {
  rootDir: string;
  dispatcherId: string;
  channelId: string;
  providerRef: string;
  now?: () => number;
}): Promise<TaskHostManifest> {
  await mkdir(input.rootDir, { recursive: true });
  const path = join(input.rootDir, MANIFEST_FILE);
  const existing = await readManifestOrNull(path);
  if (existing !== null) {
    assertManifestOwner(existing, input);
    return existing;
  }
  const manifest: TaskHostManifest = {
    schema: MANIFEST_SCHEMA,
    dispatcher_id: input.dispatcherId,
    channel_id: input.channelId,
    provider_ref: input.providerRef,
    host_stream_id: `ths_${randomUUID()}`,
    created_at: (input.now ?? Date.now)(),
  };
  validateManifest(manifest);
  await writeDurableJson(path, manifest);
  // A concurrent creator may have won the rename. Re-read and require one
  // stable owner/stream identity before any receipt can be committed.
  const durable = await readManifest(path);
  assertManifestOwner(durable, input);
  return durable;
}

export async function discoverTaskHostManifests(
  dispatcherId: string,
  parentDir = taskHostParent(dispatcherId),
): Promise<DiscoveredTaskHostManifest[]> {
  let entries;
  try {
    entries = await readdir(parentDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const discovered: DiscoveredTaskHostManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rootDir = join(parentDir, entry.name);
    const manifest = await readManifest(join(rootDir, MANIFEST_FILE));
    if (manifest.dispatcher_id !== dispatcherId) {
      throw new Error('task host manifest belongs to a different dispatcher');
    }
    if (entry.name !== channelStorageSegment(manifest.channel_id)) {
      throw new Error('task host manifest channel does not match its storage directory');
    }
    discovered.push({ rootDir, manifest });
  }
  return discovered;
}

export function defaultTaskHostRoot(dispatcherId: string, channelId: string): string {
  return join(taskHostParent(dispatcherId), channelStorageSegment(channelId));
}

/** Internal test/recovery helper for an explicitly selected durable parent. */
export function taskHostRootUnder(parentDir: string, channelId: string): string {
  return join(parentDir, channelStorageSegment(channelId));
}

function taskHostParent(dispatcherId: string): string {
  return join(dispatcherDir(dispatcherId), 'task-channel');
}

function channelStorageSegment(channelId: string): string {
  return createHash('sha256').update(channelId).digest('hex');
}

async function readManifestOrNull(path: string): Promise<TaskHostManifest | null> {
  try {
    return await readManifest(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readManifest(path: string): Promise<TaskHostManifest> {
  const bytes = await readFile(path, 'utf8');
  if (Buffer.byteLength(bytes, 'utf8') > 16 * 1024) {
    throw new Error('task host manifest exceeds its size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`invalid task host manifest JSON: ${basename(dirname(path))}`);
  }
  validateManifest(value);
  return value;
}

function validateManifest(value: unknown): asserts value is TaskHostManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('task host manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expected = [
    'channel_id',
    'created_at',
    'dispatcher_id',
    'host_stream_id',
    'provider_ref',
    'schema',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error('task host manifest has unknown or missing fields');
  }
  if (
    manifest['schema'] !== MANIFEST_SCHEMA ||
    !boundedIdentifier(manifest['dispatcher_id'], 128) ||
    !boundedIdentifier(manifest['channel_id'], 128) ||
    !boundedIdentifier(manifest['provider_ref'], 512) ||
    typeof manifest['host_stream_id'] !== 'string' ||
    !/^ths_[0-9a-f-]{36}$/.test(manifest['host_stream_id']) ||
    !Number.isSafeInteger(manifest['created_at']) ||
    (manifest['created_at'] as number) < 0
  ) {
    throw new Error('task host manifest fields are invalid');
  }
}

function boundedIdentifier(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function assertManifestOwner(
  manifest: TaskHostManifest,
  expected: { dispatcherId: string; channelId: string; providerRef: string },
): void {
  if (
    manifest.dispatcher_id !== expected.dispatcherId ||
    manifest.channel_id !== expected.channelId
  ) {
    throw new Error('task host manifest identity does not match the configured channel');
  }
  if (manifest.provider_ref !== expected.providerRef) {
    throw new Error('task host manifest provider does not match the configured channel');
  }
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true });
  let published = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await rm(temporary, { force: true });
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null &&
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'EEXIST';
}
