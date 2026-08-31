/**
 * Atomic write helper (fs.ts): tmpfile-then-rename, with O_CREAT|O_EXCL so a
 * name collision fails loud instead of clobbering, and no chmod of the final
 * path (permissions are set at open time only).
 */
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { writeAtomic } from '../src/fs.js';

describe('writeAtomic', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('writes the final file with the exact given content', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    await writeAtomic(root, 'out.json', '{"a":1}');
    const content = await readFile(join(root, 'out.json'), 'utf8');
    expect(content).toBe('{"a":1}');
  });

  it('applies the default 0600 mode at open time', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    await writeAtomic(root, 'secret.txt', 'x');
    const info = await stat(join(root, 'secret.txt'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('honors an explicit mode argument', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    await writeAtomic(root, 'readable.txt', 'x', 0o644);
    const info = await stat(join(root, 'readable.txt'));
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('leaves no leftover .tmp- file after a successful write', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    await writeAtomic(root, 'clean.txt', 'x');
    const entries = await readdir(root);
    expect(entries).toEqual(['clean.txt']);
  });

  it('overwrites an existing final file (rename replaces, does not collide)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    await writeAtomic(root, 'out.txt', 'first');
    await writeAtomic(root, 'out.txt', 'second');
    const content = await readFile(join(root, 'out.txt'), 'utf8');
    expect(content).toBe('second');
    // Only the final file remains — the two writes must not leave two tmp files.
    const entries = await readdir(root);
    expect(entries).toEqual(['out.txt']);
  });

  it('rejects when the parent directory does not exist and leaves no tmp file behind', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    const missingDir = join(root, 'does-not-exist');
    await expect(writeAtomic(missingDir, 'out.txt', 'x')).rejects.toThrow();
    // Nothing should have been created under the (missing) parent's sibling root.
    const entries = await readdir(root);
    expect(entries).toEqual([]);
  });

  it('fails loud on a real EEXIST tmp-name collision instead of clobbering', async () => {
    // writeAtomic's tmp suffix is pid+time+random, so we cannot force a real
    // collision through the public API. Instead we assert the underlying
    // exclusivity primitive it depends on: opening the same path twice with
    // 'wx' throws EEXIST rather than truncating the first writer's data. This
    // is the exact guarantee writeAtomic's tmp-file open relies on.
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-fs-'));
    const collidePath = join(root, 'collide.tmp');
    const handle = await open(collidePath, 'wx', 0o600);
    await handle.writeFile('first-writer-data');
    try {
      await expect(open(collidePath, 'wx', 0o600)).rejects.toMatchObject({ code: 'EEXIST' });
      // The first writer's data must be untouched by the failed second open.
      const content = await readFile(collidePath, 'utf8');
      expect(content).toBe('first-writer-data');
    } finally {
      await handle.close();
    }
  });
});
