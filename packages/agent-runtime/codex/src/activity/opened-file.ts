import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';

import { ActivityError, isPathWithin } from '@excitedjs/dreamux-utils';

export interface CodexOpenedRollout {
  handle: FileHandle;
  path: string;
  size: number;
  dev: number | bigint;
  ino: number | bigint;
}

export async function openCodexRollout(
  candidate: string,
  canonicalRoots: readonly string[],
): Promise<CodexOpenedRollout> {
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
      throw new ActivityError(
        'invalid',
        'Codex activity source is not a regular file',
      );
    }
    if (!canonicalRoots.some((root) => isPathWithin(root, canonicalPath))) {
      throw new ActivityError(
        'locator_outside_root',
        'Codex activity is unavailable for this session',
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
        throw new ActivityError(
          'unreadable',
          'Codex activity source changed while opening',
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
    if (error instanceof ActivityError) throw error;
    throw new ActivityError('unreadable', 'Codex activity is unreadable', {
      cause: error,
    });
  }
}

function classifyOpenError(error: unknown): ActivityError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new ActivityError(
      'not_found',
      'Codex activity is unavailable for this session',
      { cause: error },
    );
  }
  if (code === 'ELOOP') {
    return new ActivityError(
      'locator_outside_root',
      'Codex activity is unavailable for this session',
      { cause: error },
    );
  }
  return new ActivityError('unreadable', 'Codex activity is unreadable', {
    cause: error,
  });
}
