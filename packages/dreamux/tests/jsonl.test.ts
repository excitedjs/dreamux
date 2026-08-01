import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../src/platform/jsonl.js';

describe('appendJsonLine', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-jsonl-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends owner-only newline-delimited JSON in call order', async () => {
    const path = join(root, 'nested', 'events.jsonl');

    await appendJsonLine(path, { index: 1 });
    await appendJsonLine(path, { index: 2 });

    expect(await readFile(path, 'utf8')).toBe(
      '{"index":1}\n{"index":2}\n',
    );
    expect((await stat(path)).mode & 0o077).toBe(0);
  });
});
