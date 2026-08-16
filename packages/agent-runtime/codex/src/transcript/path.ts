import { isAbsolute as isAbsolutePath } from 'node:path';
import { opendir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { createZstdDecompress } from 'node:zlib';

import type { DreamuxEnvironment } from '@excitedjs/dreamux-types';
import { isPathWithin } from '@excitedjs/dreamux-utils';

import {
  createCodexTranscriptBudget,
  type CodexTranscriptBudget,
} from './budget.js';
import { CodexTranscriptError } from './error.js';
import {
  openCodexTranscript,
  type CodexOpenedTranscript,
} from './opened-file.js';

const ROLLOUT_FILENAME =
  /^rollout-[^/]+-[0-9a-f-]{36}(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const MAX_METADATA_BYTES = 1_048_576;

export interface CodexTranscriptRoots {
  home: string;
  sessions: string;
  archived: string;
}

export interface CodexValidatedTranscript {
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

export async function resolveCodexTranscriptRoots(
  env: DreamuxEnvironment = process.env,
): Promise<CodexTranscriptRoots> {
  const configured = env['CODEX_HOME'];
  let home: string;
  if (configured !== undefined) {
    if (!isAbsolutePath(configured)) {
      throw new CodexTranscriptError(
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
      throw new CodexTranscriptError(
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

export async function validateCodexThreadPath(
  candidate: string,
  expectedSessionId: string,
  roots: CodexTranscriptRoots,
): Promise<CodexValidatedTranscript> {
  try {
    return await validateCodexTranscriptLocator(
      candidate,
      expectedSessionId,
      roots,
    );
  } catch (error) {
    if (
      !(error instanceof CodexTranscriptError) ||
      error.reason !== 'not_found'
    ) {
      throw error;
    }
  }
  assertNativeRolloutPath(candidate);
  const rolloutId = rolloutIdFromPath(candidate);
  if (
    threadIdFromPath(candidate).toLowerCase() !==
    expectedSessionId.toLowerCase()
  ) {
    throw new CodexTranscriptError(
      'session_mismatch',
      'Codex transcript does not belong to the selected session',
    );
  }
  const canonicalPath = await canonicalProspectivePath(candidate, roots);
  return {
    path: canonicalPath,
    root: canonicalRootsForProspectivePath(canonicalPath, roots),
    sessionId: expectedSessionId,
    rolloutId,
    historyBase: null,
    dev: -1,
    ino: -1,
  };
}

export async function validateCodexTranscriptLocator(
  candidate: string,
  expectedSessionId: string,
  roots: CodexTranscriptRoots,
): Promise<CodexValidatedTranscript> {
  return validateCodexTranscript({
    candidate,
    roots,
    expectedSessionId,
  });
}

export async function locateCodexTranscript(
  locator: string | null | undefined,
  expectedSessionId: string,
  roots: CodexTranscriptRoots,
  budget: CodexTranscriptBudget = createCodexTranscriptBudget(),
): Promise<CodexValidatedTranscript> {
  if (locator !== null && locator !== undefined) {
    try {
      return await validateCodexTranscriptLocator(
        locator,
        expectedSessionId,
        roots,
      );
    } catch (error) {
      if (
        !(error instanceof CodexTranscriptError) ||
        error.reason !== 'not_found'
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
      return await validateCodexTranscriptLocator(
        candidate,
        expectedSessionId,
        roots,
      );
    } catch (error) {
      if (
        error instanceof CodexTranscriptError &&
        (error.reason === 'session_mismatch' ||
          error.reason === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new CodexTranscriptError(
    'not_found',
    'Codex transcript is unavailable',
  );
}

export async function findCodexRolloutById(
  roots: CodexTranscriptRoots,
  rolloutId: string,
  budget: CodexTranscriptBudget = createCodexTranscriptBudget(),
): Promise<CodexValidatedTranscript> {
  const candidates = await discoverRollouts(roots, rolloutId, budget);
  for (const candidate of candidates) {
    if (!basename(candidate).toLowerCase().includes(rolloutId.toLowerCase())) {
      continue;
    }
    try {
      return await validateCodexTranscript({
        candidate,
        roots,
        expectedRolloutId: rolloutId,
      });
    } catch (error) {
      if (
        error instanceof CodexTranscriptError &&
        (error.reason === 'session_mismatch' ||
          error.reason === 'not_found')
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new CodexTranscriptError(
    'not_found',
    'Codex transcript lineage is unavailable',
  );
}

export async function readCodexTranscriptText(
  opened: CodexOpenedTranscript,
  maxDecodedBytes: number,
): Promise<string> {
  if (opened.path.endsWith('.zst') && opened.size > maxDecodedBytes) {
    throw new CodexTranscriptError(
      'scan_unsupported',
      'Codex compressed transcript requires a native read index',
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
        throw new CodexTranscriptError(
          'scan_unsupported',
          'Codex transcript exceeds the bounded scan limit',
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof CodexTranscriptError) throw error;
    throw new CodexTranscriptError(
      'unreadable',
      'Codex transcript is unreadable',
      { cause: error },
    );
  } finally {
    stream.destroy();
    source.destroy();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readCodexSessionMetadata(
  opened: CodexOpenedTranscript,
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
    if (error instanceof CodexTranscriptError) throw error;
    throw new CodexTranscriptError(
      'unreadable',
      'Codex transcript metadata is unreadable',
      { cause: error },
    );
  } finally {
    stream.destroy();
    source.destroy();
  }
  throw new CodexTranscriptError(
    'invalid',
    'Codex transcript metadata is invalid',
  );
}

async function discoverRollouts(
  roots: CodexTranscriptRoots,
  id: string,
  budget: CodexTranscriptBudget,
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
        throw new CodexTranscriptError(
          'unreadable',
          'Codex transcript directory is unreadable',
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
        if (error instanceof CodexTranscriptError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new CodexTranscriptError(
          'unreadable',
          'Codex transcript directory is unreadable',
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
        throw new CodexTranscriptError(
          'unreadable',
          'Codex transcript path is unreadable',
          { cause: error },
        );
      }
    }
  }
  throw new CodexTranscriptError(
    'not_found',
    'Codex transcript is unavailable',
  );
}

async function canonicalExistingRoots(
  roots: CodexTranscriptRoots,
): Promise<string[]> {
  const result: string[] = [];
  for (const root of [roots.sessions, roots.archived]) {
    const canonical = await realpath(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CodexTranscriptError(
        'unreadable',
        'Codex transcript root is unreadable',
        { cause: error },
      );
    });
    if (canonical !== null) result.push(canonical);
  }
  if (result.length === 0) {
    throw new CodexTranscriptError(
      'not_found',
      'Codex transcript roots are unavailable',
    );
  }
  return result;
}

async function validateCodexTranscript(input: {
  candidate: string;
  roots: CodexTranscriptRoots;
  expectedSessionId?: string;
  expectedRolloutId?: string;
}): Promise<CodexValidatedTranscript> {
  assertNativeRolloutPath(input.candidate);
  const existing = await existingRepresentation(input.candidate);
  const canonicalRoots = await canonicalExistingRoots(input.roots);
  const opened = await openCodexTranscript(existing, canonicalRoots);
  try {
    const rolloutId = rolloutIdFromPath(opened.path);
    if (
      input.expectedRolloutId !== undefined &&
      rolloutId.toLowerCase() !== input.expectedRolloutId.toLowerCase()
    ) {
      throw new CodexTranscriptError(
        'session_mismatch',
        'Codex transcript rollout identity does not match',
      );
    }
    const metadata = await readCodexSessionMetadata(opened);
    if (
      input.expectedSessionId !== undefined &&
      metadata.sessionId !== input.expectedSessionId
    ) {
      throw new CodexTranscriptError(
        'session_mismatch',
        'Codex transcript does not belong to the selected session',
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

function canonicalRootsForProspectivePath(
  candidate: string,
  roots: CodexTranscriptRoots,
): string {
  return isPathWithin(roots.sessions, candidate)
    ? roots.sessions
    : roots.archived;
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
    throw new CodexTranscriptError(
      'invalid',
      'Codex transcript metadata is invalid',
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

function metadataTooLarge(): CodexTranscriptError {
  return new CodexTranscriptError(
    'invalid',
    'Codex transcript metadata exceeds its bounded record size',
  );
}

function classifyRootError(error: unknown): CodexTranscriptError {
  return new CodexTranscriptError(
    (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'not_found'
      : 'unreadable',
    'Codex home directory is unavailable',
    { cause: error },
  );
}

async function canonicalProspectivePath(
  candidate: string,
  roots: CodexTranscriptRoots,
): Promise<string> {
  const canonicalCandidate = await canonicalizeProspectivePath(candidate);
  const canonicalRoots = await Promise.all(
    [roots.sessions, roots.archived].map(canonicalizeProspectivePath),
  );
  if (!canonicalRoots.some((root) => isPathWithin(root, canonicalCandidate))) {
    throw new CodexTranscriptError(
      'locator_outside_root',
      'Codex transcript locator is outside the native transcript roots',
    );
  }
  return canonicalCandidate;
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  let ancestor = absolutePath;
  while (true) {
    const canonicalAncestor = await realpathIfExists(ancestor);
    if (canonicalAncestor !== null) {
      return resolve(
        canonicalAncestor,
        relative(ancestor, absolutePath),
      );
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new CodexTranscriptError(
        'not_found',
        'Codex transcript root is unavailable',
      );
    }
    ancestor = parent;
  }
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CodexTranscriptError(
      'unreadable',
      'Codex transcript path is unreadable',
      { cause: error },
    );
  }
}

function rolloutIdFromPath(path: string): string {
  const ids = rolloutIdsFromPath(path);
  return ids.at(-1) ?? basename(path);
}

function threadIdFromPath(path: string): string {
  const ids = rolloutIdsFromPath(path);
  return ids[0] ?? basename(path);
}

function rolloutIdsFromPath(path: string): string[] {
  const name = basename(path).replace(/\.jsonl(?:\.zst)?$/, '');
  return name.match(/[0-9a-f]{8}-[0-9a-f-]{27}/gi) ?? [];
}

function assertNativeRolloutPath(candidate: string): void {
  if (!isAbsolute(candidate) || !ROLLOUT_FILENAME.test(basename(candidate))) {
    throw new CodexTranscriptError(
      'invalid',
      'Codex transcript locator is not a native rollout path',
    );
  }
}

function homeDirectory(env: DreamuxEnvironment): string {
  const value = env['HOME'];
  if (value === undefined || value === '') {
    throw new CodexTranscriptError(
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
