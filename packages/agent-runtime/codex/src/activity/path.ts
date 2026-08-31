import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';
import { isPathWithin } from '@excitedjs/dreamux-utils';

import {
  createCodexScanBudget,
  type CodexScanBudget,
} from './budget.js';
import { CodexActivityError } from './error.js';
import {
  openCodexRollout,
  type CodexOpenedRollout,
} from './opened-file.js';

const ROLLOUT_FILENAME =
  /^rollout-[^/]+-[0-9a-f-]{36}(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const MAX_METADATA_BYTES = 1_048_576;

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
  env: DreamuxEnvironment = process.env,
): Promise<CodexRolloutRoots> {
  const configured = env['CODEX_HOME'];
  let home: string;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new CodexActivityError(
        'invalid',
        'Explicit Codex home must be an absolute directory',
      );
    }
    let info;
    try {
      info = await stat(configured);
    } catch (error) {
      throw classifyRootError(error);
    }
    if (!info.isDirectory()) {
      throw new CodexActivityError(
        'invalid',
        'Explicit Codex home must be a directory',
      );
    }
    home = await realpath(configured).catch((error: unknown) => {
      throw classifyRootError(error);
    });
  } else {
    const fallback = join(homeDirectory(env), '.codex');
    home = await realpath(fallback).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return resolve(fallback);
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
  budget: CodexScanBudget = createCodexScanBudget(),
): Promise<CodexValidatedRollout> {
  if (locator !== null && locator !== undefined) {
    try {
      return await validateCodexRolloutPath(
        locator,
        expectedSessionId,
        roots,
      );
    } catch (error) {
      if (
        !(error instanceof CodexActivityError) ||
        error.detail !== 'not_found'
      ) {
        throw error;
      }
    }
  }
  const candidates = await discoverRollouts(
    roots,
    expectedSessionId,
    budget,
  );
  for (const candidate of candidates) {
    try {
      return await validateCodexRolloutPath(
        candidate,
        expectedSessionId,
        roots,
      );
    } catch (error) {
      if (
        error instanceof CodexActivityError &&
        (error.detail === 'session_mismatch' ||
          error.detail === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new CodexActivityError(
    'not_found',
    'Codex activity is unavailable for this session',
  );
}

export async function findCodexRolloutById(
  roots: CodexRolloutRoots,
  rolloutId: string,
  budget: CodexScanBudget = createCodexScanBudget(),
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
        error instanceof CodexActivityError &&
        (error.detail === 'session_mismatch' ||
          error.detail === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new CodexActivityError(
    'not_found',
    'Codex activity history is unavailable',
  );
}

export async function readCodexRolloutText(
  opened: CodexOpenedRollout,
  maxDecodedBytes: number,
): Promise<string> {
  if (opened.path.endsWith('.zst') && opened.size > maxDecodedBytes) {
    throw new CodexActivityError(
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
        throw new CodexActivityError(
          'scan_unsupported',
          'Codex activity exceeds the bounded limit',
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof CodexActivityError) throw error;
    throw new CodexActivityError(
      'unreadable',
      'Codex activity is unreadable',
      { cause: error },
    );
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
    if (error instanceof CodexActivityError) throw error;
    throw new CodexActivityError(
      'unreadable',
      'Codex activity metadata is unreadable',
      { cause: error },
    );
  } finally {
    stream.destroy();
    source.destroy();
  }
  throw new CodexActivityError(
    'invalid',
    'Codex activity metadata is invalid',
  );
}

async function discoverRollouts(
  roots: CodexRolloutRoots,
  id: string,
  budget: CodexScanBudget,
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
        throw new CodexActivityError(
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
        if (error instanceof CodexActivityError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new CodexActivityError(
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
        throw new CodexActivityError(
          'unreadable',
          'Codex activity source is unreadable',
          { cause: error },
        );
      }
    }
  }
  throw new CodexActivityError(
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
      throw new CodexActivityError(
        'unreadable',
        'Codex activity source is unreadable',
        { cause: error },
      );
    });
    if (canonical !== null) result.push(canonical);
  }
  if (result.length === 0) {
    throw new CodexActivityError(
      'not_found',
      'Codex activity is unavailable',
    );
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
      throw new CodexActivityError(
        'session_mismatch',
        'Codex activity identity does not match',
      );
    }
    const metadata = await readCodexSessionMetadata(opened);
    if (
      input.expectedSessionId !== undefined &&
      metadata.sessionId !== input.expectedSessionId
    ) {
      throw new CodexActivityError(
        'session_mismatch',
        'Codex activity does not belong to the selected session',
      );
    }
    return {
      path: opened.path,
      root:
        canonicalRoots.find((root) => isPathWithin(root, opened.path))!,
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
  const id =
    stringValue(meta?.['id']) ?? stringValue(meta?.['session_id']);
  if (id === null) {
    throw new CodexActivityError(
      'invalid',
      'Codex activity metadata is invalid',
    );
  }
  const historyBaseRecord = asRecord(meta?.['history_base']);
  const rolloutId = stringValue(historyBaseRecord?.['thread_id']);
  const endByteOffset = numberValue(
    historyBaseRecord?.['end_byte_offset'],
  );
  return {
    sessionId: id,
    historyBase:
      rolloutId !== null && endByteOffset !== null
        ? { rolloutId, endByteOffset }
        : null,
  };
}

function metadataTooLarge(): CodexActivityError {
  return new CodexActivityError(
    'invalid',
    'Codex activity metadata exceeds its bounded record size',
  );
}

function classifyRootError(error: unknown): CodexActivityError {
  return new CodexActivityError(
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
    throw new CodexActivityError(
      'invalid',
      'Codex activity source is not a native rollout path',
    );
  }
}

function homeDirectory(env: DreamuxEnvironment): string {
  const value = env['HOME'];
  if (value === undefined || value === '') {
    throw new CodexActivityError(
      'not_found',
      'Codex home directory is unavailable',
    );
  }
  return value;
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
