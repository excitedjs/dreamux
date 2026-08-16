import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';

import { isPathWithin } from '@excitedjs/dreamux-utils';

import { CodexTranscriptError } from './error.js';

export interface CodexOpenedTranscript {
  handle: FileHandle;
  path: string;
  size: number;
  dev: number | bigint;
  ino: number | bigint;
}

export async function openCodexTranscript(
  candidate: string,
  canonicalRoots: readonly string[],
): Promise<CodexOpenedTranscript> {
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
      throw new CodexTranscriptError(
        'invalid',
        'Codex transcript is not a regular file',
      );
    }
    if (!canonicalRoots.some((root) => isPathWithin(root, canonicalPath))) {
      throw new CodexTranscriptError(
        'locator_outside_root',
        'Codex transcript locator is outside the native transcript roots',
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
        throw new CodexTranscriptError(
          'unreadable',
          'Codex transcript changed while opening',
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
    if (error instanceof CodexTranscriptError) throw error;
    throw new CodexTranscriptError(
      'unreadable',
      'Codex transcript is unreadable',
      { cause: error },
    );
  }
}

function classifyOpenError(error: unknown): CodexTranscriptError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new CodexTranscriptError(
      'not_found',
      'Codex transcript is unavailable',
      { cause: error },
    );
  }
  if (code === 'ELOOP') {
    return new CodexTranscriptError(
      'locator_outside_root',
      'Codex transcript locator is outside the native transcript roots',
      { cause: error },
    );
  }
  return new CodexTranscriptError(
    'unreadable',
    'Codex transcript is unreadable',
    { cause: error },
  );
}
