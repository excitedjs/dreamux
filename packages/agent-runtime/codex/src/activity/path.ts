import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';
import {
  ActivityError,
  createScanBudget,
  isPathWithin,
  type ScanBudget,
} from '@excitedjs/dreamux-utils';

import { resolveCodexHomeDir } from '../paths.js';
import { openCodexRollout, type CodexOpenedRollout } from './opened-file.js';

const ROLLOUT_FILENAME =
  /^rollout-[^/]+-[0-9a-f-]{36}(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const MAX_METADATA_BYTES = 1_048_576;
const SCAN_BUDGET_EXCEEDED_MESSAGE =
  'Codex activity read exceeded its bounded limit';

/** The default bounded budget for a Codex activity discovery scan. */
export function createCodexScanBudget(
  input: {
    maxEntries?: number;
    maxElapsedMs?: number;
  } = {},
): ScanBudget {
  return createScanBudget({
    ...input,
    limitError: () =>
      new ActivityError('scan_unsupported', SCAN_BUDGET_EXCEEDED_MESSAGE),
  });
}

export interface CodexRolloutRoots {
  home: string;
  sessions: string;
  archived: string;
}

export interface CodexValidatedRollout {
  path: string;
  root: string;
  sessionId: string;
  rolloutId: string;
  historyBase: CodexHistoryBase | null;
  dev: number | bigint;
  ino: number | bigint;
}

export interface CodexHistoryBase {
  rolloutId: string;
  endByteOffset: number;
}

export async function resolveCodexRolloutRoots(
  env: DreamuxEnvironment,
): Promise<CodexRolloutRoots> {
  const configured = env['CODEX_HOME'];
  if (
    configured === undefined &&
    (env['HOME'] === undefined || env['HOME'] === '')
  ) {
    throw new ActivityError('not_found', 'Codex home directory is unavailable');
  }
  // resolveCodexHomeDir is pure/non-throwing (it also backs the doctor, which
  // has no missing-HOME failure mode of its own); the guard above preserves
  // this reader's own typed-error contract for that case.
  const candidate = resolveCodexHomeDir(env);
  let home: string;
  if (configured !== undefined) {
    if (!isAbsolute(candidate)) {
      throw new ActivityError(
        'invalid',
        'Explicit Codex home must be an absolute directory',
      );
    }
    let info;
    try {
      info = await stat(candidate);
    } catch (error) {
      throw classifyRootError(error);
    }
    if (!info.isDirectory()) {
      throw new ActivityError(
        'invalid',
        'Explicit Codex home must be a directory',
      );
    }
    home = await realpath(candidate).catch((error: unknown) => {
      throw classifyRootError(error);
    });
  } else {
    home = await realpath(candidate).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return resolve(candidate);
      }
      throw classifyRootError(error);
    });
  }
  return {
    home,
    sessions: join(home, 'sessions'),
    archived: join(home, 'archived_sessions'),
  };
}

export async function validateCodexRolloutPath(
  candidate: string,
  expectedSessionId: string,
  roots: CodexRolloutRoots,
): Promise<CodexValidatedRollout> {
  return validateCodexRollout({
    candidate,
    roots,
    expectedSessionId,
  });
}

export async function locateCodexRollout(
  locator: string | null | undefined,
  expectedSessionId: string,
  roots: CodexRolloutRoots,
  budget: ScanBudget = createCodexScanBudget(),
): Promise<CodexValidatedRollout> {
  if (locator !== null && locator !== undefined) {
    try {
      return await validateCodexRolloutPath(locator, expectedSessionId, roots);
    } catch (error) {
      if (!(error instanceof ActivityError) || error.detail !== 'not_found') {
        throw error;
      }
    }
  }
  const candidates = await discoverRollouts(roots, expectedSessionId, budget);
  for (const candidate of candidates) {
    try {
      return await validateCodexRolloutPath(
        candidate,
        expectedSessionId,
        roots,
      );
    } catch (error) {
      if (
        error instanceof ActivityError &&
        (error.detail === 'session_mismatch' || error.detail === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new ActivityError(
    'not_found',
    'Codex activity is unavailable for this session',
  );
}

export async function findCodexRolloutById(
  roots: CodexRolloutRoots,
  rolloutId: string,
  budget: ScanBudget = createCodexScanBudget(),
): Promise<CodexValidatedRollout> {
  const candidates = await discoverRollouts(roots, rolloutId, budget);
  for (const candidate of candidates) {
    if (!basename(candidate).toLowerCase().includes(rolloutId.toLowerCase())) {
      continue;
    }
    try {
      return await validateCodexRollout({
        candidate,
        roots,
        expectedRolloutId: rolloutId,
      });
    } catch (error) {
      if (
        error instanceof ActivityError &&
        (error.detail === 'session_mismatch' || error.detail === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new ActivityError('not_found', 'Codex activity history is unavailable');
}

export async function readCodexRolloutText(
  opened: CodexOpenedRollout,
  maxDecodedBytes: number,
): Promise<string> {
  if (opened.path.endsWith('.zst') && opened.size > maxDecodedBytes) {
    throw new ActivityError(
      'scan_unsupported',
      'Codex activity requires a native read index',
    );
  }
  const source = opened.handle.createReadStream({
    autoClose: false,
    start: 0,
  });
  const stream = opened.path.endsWith('.zst')
    ? source.pipe(createZstdDecompress())
    : source;
  const chunks: Buffer[] = [];
  let decodedBytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      decodedBytes += buffer.length;
      if (decodedBytes > maxDecodedBytes) {
        throw new ActivityError(
          'scan_unsupported',
          'Codex activity exceeds the bounded limit',
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ActivityError) throw error;
    throw new ActivityError('unreadable', 'Codex activity is unreadable', {
      cause: error,
    });
  } finally {
    stream.destroy();
    source.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readCodexSessionMetadata(
  opened: CodexOpenedRollout,
): Promise<{ sessionId: string; historyBase: CodexHistoryBase | null }> {
  const source = opened.handle.createReadStream({
    autoClose: false,
    start: 0,
  });
  const stream = opened.path.endsWith('.zst')
    ? source.pipe(createZstdDecompress())
    : source;
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length > MAX_METADATA_BYTES) {
        throw metadataTooLarge();
      }
      let newline;
      while ((newline = buffered.indexOf(0x0a)) >= 0) {
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        const metadata = metadataFromLine(line);
        if (metadata !== null) return metadata;
      }
    }
    if (buffered.length > 0) {
      const metadata = metadataFromLine(buffered.toString('utf8'));
      if (metadata !== null) return metadata;
    }
  } catch (error) {
    if (error instanceof ActivityError) throw error;
    throw new ActivityError(
      'unreadable',
      'Codex activity metadata is unreadable',
      { cause: error },
    );
  } finally {
    stream.destroy();
    source.destroy();
  }
  throw new ActivityError('invalid', 'Codex activity metadata is invalid');
}

async function discoverRollouts(
  roots: CodexRolloutRoots,
  id: string,
  budget: ScanBudget,
): Promise<string[]> {
  const matches: string[] = [];
  for (const root of [roots.sessions, roots.archived]) {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      let opened;
      try {
        opened = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new ActivityError(
          'unreadable',
          'Codex activity source is unreadable',
          { cause: error },
        );
      }
      try {
        for await (const entry of opened) {
          budget.inspect();
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            stack.push(path);
          } else if (
            ROLLOUT_FILENAME.test(entry.name) &&
            entry.name.toLowerCase().includes(id.toLowerCase())
          ) {
            matches.push(path);
          }
        }
      } catch (error) {
        if (error instanceof ActivityError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new ActivityError(
          'unreadable',
          'Codex activity source is unreadable',
          { cause: error },
        );
      }
    }
  }
  return matches.sort((left, right) =>
    basename(right).localeCompare(basename(left)),
  );
}

async function existingRepresentation(path: string): Promise<string> {
  for (const candidate of path.endsWith('.zst')
    ? [path, path.slice(0, -4)]
    : [path, `${path}.zst`]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ActivityError(
          'unreadable',
          'Codex activity source is unreadable',
          { cause: error },
        );
      }
    }
  }
  throw new ActivityError(
    'not_found',
    'Codex activity is unavailable for this session',
  );
}

async function canonicalExistingRoots(
  roots: CodexRolloutRoots,
): Promise<string[]> {
  const result: string[] = [];
  for (const root of [roots.sessions, roots.archived]) {
    const canonical = await realpath(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ActivityError(
        'unreadable',
        'Codex activity source is unreadable',
        { cause: error },
      );
    });
    if (canonical !== null) result.push(canonical);
  }
  if (result.length === 0) {
    throw new ActivityError('not_found', 'Codex activity is unavailable');
  }
  return result;
}

async function validateCodexRollout(input: {
  candidate: string;
  roots: CodexRolloutRoots;
  expectedSessionId?: string;
  expectedRolloutId?: string;
}): Promise<CodexValidatedRollout> {
  assertNativeRolloutPath(input.candidate);
  const existing = await existingRepresentation(input.candidate);
  const canonicalRoots = await canonicalExistingRoots(input.roots);
  const opened = await openCodexRollout(existing, canonicalRoots);
  try {
    const rolloutId = rolloutIdFromPath(opened.path);
    if (
      input.expectedRolloutId !== undefined &&
      rolloutId.toLowerCase() !== input.expectedRolloutId.toLowerCase()
    ) {
      throw new ActivityError(
        'session_mismatch',
        'Codex activity identity does not match',
      );
    }
    const metadata = await readCodexSessionMetadata(opened);
    if (
      input.expectedSessionId !== undefined &&
      metadata.sessionId !== input.expectedSessionId
    ) {
      throw new ActivityError(
        'session_mismatch',
        'Codex activity does not belong to the selected session',
      );
    }
    return {
      path: opened.path,
      root: canonicalRoots.find((root) => isPathWithin(root, opened.path))!,
      sessionId: metadata.sessionId,
      rolloutId,
      historyBase: metadata.historyBase,
      dev: opened.dev,
      ino: opened.ino,
    };
  } finally {
    await opened.handle.close();
  }
}

function metadataFromLine(
  line: string,
): { sessionId: string; historyBase: CodexHistoryBase | null } | null {
  const value = parseObject(line);
  if (value?.['type'] !== 'session_meta') return null;
  const payload = asRecord(value['payload']);
  const meta = asRecord(payload?.['meta']) ?? payload;
  const id = stringValue(meta?.['id']) ?? stringValue(meta?.['session_id']);
  if (id === null) {
    throw new ActivityError('invalid', 'Codex activity metadata is invalid');
  }
  const historyBaseRecord = asRecord(meta?.['history_base']);
  const rolloutId = stringValue(historyBaseRecord?.['thread_id']);
  const endByteOffset = numberValue(historyBaseRecord?.['end_byte_offset']);
  return {
    sessionId: id,
    historyBase:
      rolloutId !== null && endByteOffset !== null
        ? { rolloutId, endByteOffset }
        : null,
  };
}

function metadataTooLarge(): ActivityError {
  return new ActivityError(
    'invalid',
    'Codex activity metadata exceeds its bounded record size',
  );
}

function classifyRootError(error: unknown): ActivityError {
  return new ActivityError(
    (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'not_found'
      : 'unreadable',
    'Codex home directory is unavailable',
    { cause: error },
  );
}

function rolloutIdFromPath(path: string): string {
  const ids = rolloutIdsFromPath(path);
  return ids.at(-1) ?? basename(path);
}

function rolloutIdsFromPath(path: string): string[] {
  const name = basename(path).replace(/\.jsonl(?:\.zst)?$/, '');
  return name.match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [];
}

function assertNativeRolloutPath(candidate: string): void {
  if (!isAbsolute(candidate) || !ROLLOUT_FILENAME.test(basename(candidate))) {
    throw new ActivityError(
      'invalid',
      'Codex activity source is not a native rollout path',
    );
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
