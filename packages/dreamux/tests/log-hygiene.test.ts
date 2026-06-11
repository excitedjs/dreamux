import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeEmptyLogFile } from '../src/platform/logs.js';

/**
 * Empty child-log cleanup (issue #182 logs stage): supervisors call
 * `removeEmptyLogFile` on a child's stdout/stderr log after the child exits, so
 * a clean run that produced no output leaves no zero-byte file behind, while any
 * file that captured output is kept.
 */
describe('removeEmptyLogFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dreamux-log-hygiene-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes a zero-byte log file', async () => {
    const path = join(dir, 'child.stderr.log');
    await writeFile(path, '');
    await removeEmptyLogFile(path);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a log file that captured output', async () => {
    const path = join(dir, 'child.stderr.log');
    await writeFile(path, 'panic: something went wrong\n');
    await removeEmptyLogFile(path);
    expect(await readFile(path, 'utf8')).toBe('panic: something went wrong\n');
  });

  it('is a no-op (never throws) when the file does not exist', async () => {
    await expect(
      removeEmptyLogFile(join(dir, 'never-created.log')),
    ).resolves.toBeUndefined();
  });
});
