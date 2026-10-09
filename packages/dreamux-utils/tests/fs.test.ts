import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishFileExclusive, writeFileAtomic } from '../src/fs.js';
import { TransactionalStore } from '../src/transactional-store.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dreamux-write-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('atomic filesystem publication', () => {
  it('writes exact content with private default permissions and no temporary leftovers', async () => {
    const path = join(root, 'state.json');
    await writeFileAtomic(path, '{"a":1}');
    expect(await readFile(path, 'utf8')).toBe('{"a":1}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['state.json']);
  });
  it('honors an explicit mode and atomically replaces the previous complete contents', async () => {
    const path = join(root, 'state.json');
    await writeFileAtomic(path, 'first', { mode: 0o644 });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await writeFileAtomic(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
    expect(await readdir(root)).toEqual(['state.json']);
  });
  it('creates missing parent directories for the current publication contract', async () => {
    const path = join(root, 'nested', 'state.json');
    await writeFileAtomic(path, 'complete');
    expect(await readFile(path, 'utf8')).toBe('complete');
  });
  it('cleans its temporary file when publishing over a directory fails', async () => {
    const path = join(root, 'existing');
    await mkdir(path);
    await writeFile(join(path, 'foreign'), 'keep');
    await expect(writeFileAtomic(path, 'replacement')).rejects.toThrow();
    expect(await readdir(root)).toEqual(['existing']);
    expect(await readFile(join(path, 'foreign'), 'utf8')).toBe('keep');
  });
  it('has exactly one winner under concurrent exclusive publishers without clobbering', async () => {
    const path = join(root, 'new.json');
    const results = await Promise.all(
      ['first', 'second'].map((data) => publishFileExclusive(path, data)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(results[0] ? 'first' : 'second');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await publishFileExclusive(path, 'third')).toBe(false);
    expect(await readdir(root)).toEqual(['new.json']);
  });
});

describe('transactional publication owner', () => {
  it('serializes updates and exposes the committed disk value to afterCommit', async () => {
    const path = join(root, 'nested', 'counter.json');
    const store = new TransactionalStore({ path, load: async () => 0 });
    const published: number[] = [];
    await Promise.all(
      [1, 2, 3].map(() =>
        store.update(
          (n) => n + 1,
          async (value) => {
            expect(JSON.parse(await readFile(path, 'utf8'))).toBe(value);
            expect(store.current).toBe(value);
            published.push(value);
          },
        ),
      ),
    );
    expect(published).toEqual([1, 2, 3]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('keeps the previous committed memory and disk on failed change and accepts the next update', async () => {
    const path = join(root, 'state.json');
    const store = new TransactionalStore({ path, load: async () => 0 });
    await store.create(1);
    await expect(
      store.update(() => {
        throw new Error('failed change');
      }),
    ).rejects.toThrow('failed change');
    expect(store.current).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toBe(1);
    await store.update((n) => n + 1);
    expect(store.current).toBe(2);
  });
});
