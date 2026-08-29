import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';

import {
  isPathWithin,
  readBytesAt,
} from '@excitedjs/dreamux-utils';

import { ClaudeActivityError } from './error.js';

export interface ClaudeOpenedRollout {
  handle: FileHandle;
  path: string;
  size: number;
  dev: number | bigint;
  ino: number | bigint;
}

const MAX_METADATA_BYTES = 1_048_576;

export async function openClaudeRollout(
  candidate: string,
  canonicalRoot: string,
): Promise<ClaudeOpenedRollout> {
  let handle: FileHandle;
  try {
    handle = await open(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw classifyOpenError(error);
  }
  try {
    const [opened, canonicalPath] = await Promise.all([
      handle.stat(),
      realpath(candidate),
    ]);
    if (!opened.isFile()) {
      throw new ClaudeActivityError(
        'invalid',
        'Claude Code activity is not a regular file',
      );
    }
    if (!isPathWithin(canonicalRoot, canonicalPath)) {
      throw new ClaudeActivityError(
        'locator_outside_root',
        'Claude Code activity is unavailable for this session',
      );
    }
    const current = await open(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch((error: unknown) => {
      throw classifyOpenError(error);
    });
    try {
      const currentStat = await current.stat();
      if (opened.dev !== currentStat.dev || opened.ino !== currentStat.ino) {
        throw new ClaudeActivityError(
          'unreadable',
          'Claude Code activity changed while opening',
        );
      }
    } finally {
      await current.close();
    }
    return {
      handle,
      path: canonicalPath,
      size: opened.size,
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof ClaudeActivityError) throw error;
    throw new ClaudeActivityError(
      'unreadable',
      'Claude Code activity is unreadable',
      { cause: error },
    );
  }
}

export async function validateClaudeSessionEvidence(
  opened: ClaudeOpenedRollout,
  expectedSessionId: string,
  options: { maxReadChunkBytes?: number } = {},
): Promise<void> {
  const length = Math.min(opened.size, MAX_METADATA_BYTES + 1);
  const data = await readBytesAt(opened.handle, 0, length, {
    ...(options.maxReadChunkBytes !== undefined
      ? { maxChunkBytes: options.maxReadChunkBytes }
      : {}),
  });
  let cursor = 0;
  while (cursor < data.length) {
    const newline = data.indexOf(0x0a, cursor);
    if (newline < 0) {
      if (opened.size > MAX_METADATA_BYTES) {
        throw new ClaudeActivityError(
          'invalid',
          'Claude Code activity metadata record is oversized',
        );
      }
      break;
    }
    const raw = data.subarray(cursor, newline).toString('utf8');
    const value = parseRecord(raw);
    if (value === null && raw.trim() !== '') {
      throw new ClaudeActivityError(
        'invalid',
        'Claude Code activity contains invalid native metadata',
      );
    }
    const sessionId = stringValue(value?.['sessionId']);
    if (sessionId !== null) {
      if (sessionId !== expectedSessionId) {
        throw new ClaudeActivityError(
          'session_mismatch',
          'Claude Code activity does not belong to the selected session',
        );
      }
      return;
    }
    cursor = newline + 1;
  }
  throw new ClaudeActivityError(
    'invalid',
    'Claude Code activity has no authoritative session metadata',
  );
}

function classifyOpenError(error: unknown): ClaudeActivityError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new ClaudeActivityError(
      'not_found',
      'Claude Code activity is unavailable',
      { cause: error },
    );
  }
  if (code === 'ELOOP') {
    return new ClaudeActivityError(
      'locator_outside_root',
      'Claude Code activity is unavailable for this session',
      { cause: error },
    );
  }
  return new ClaudeActivityError(
    'unreadable',
    'Claude Code activity is unreadable',
    { cause: error },
  );
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
