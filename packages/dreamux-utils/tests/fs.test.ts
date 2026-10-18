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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishFileExclusive, writeFileAtomic } from '../src/fs.js';
import { TransactionalStore } from '../src/transactional-store.js';
import { expectOwnerOnlyPermissions } from './permissions.js';

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
    await expectOwnerOnlyPermissions(path, 0o600);
    expect(await readdir(root)).toEqual(['state.json']);
  });
  it('honors an explicit mode and atomically replaces the previous complete contents', async () => {
    const path = join(root, 'state.json');
    await writeFileAtomic(path, 'first', { mode: 0o644 });
    if (process.platform !== 'win32')
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
  it.skipIf(process.platform !== 'win32')(
    'retries a native sharing lock without exposing partial or missing data',
    async () => {
      const path = join(root, 'locked state.json');
      await writeFile(path, 'previous complete state');
      const release = await holdWindowsReadLock(path);
      try {
        const replacement = writeFileAtomic(path, 'next complete state', {
          mode: 0o644,
        });
        // Record either outcome immediately so a regression rejects the assertion
        // instead of becoming an unhandled rejection while the lock is held.
        const outcome = replacement.then(
          () => 'committed',
          (error: unknown) => error,
        );
        await delay(150);
        expect(await readFile(path, 'utf8')).toBe('previous complete state');
        await release();
        expect(await outcome).toBe('committed');
        expect(await readFile(path, 'utf8')).toBe('next complete state');
        expect(await readdir(root)).toEqual(['locked state.json']);
      } finally {
        await release();
      }
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'rejects a persistent sharing lock without losing the previous commit or leaking a temp file',
    async () => {
      const path = join(root, 'locked state.json');
      await writeFile(path, 'previous complete state');
      const release = await holdWindowsReadLock(path);
      try {
        await expect(
          writeFileAtomic(path, 'uncommitted', { mode: 0o644 }),
        ).rejects.toMatchObject({ code: 'EPERM' });
        expect(await readFile(path, 'utf8')).toBe('previous complete state');
        expect(await readdir(root)).toEqual(['locked state.json']);
      } finally {
        await release();
      }
    },
  );
  it('has exactly one winner under concurrent exclusive publishers without clobbering', async () => {
    const path = join(root, 'new.json');
    const results = await Promise.all(
      ['first', 'second'].map((data) => publishFileExclusive(path, data)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(results[0] ? 'first' : 'second');
    await expectOwnerOnlyPermissions(path, 0o600);
    expect(await publishFileExclusive(path, 'third')).toBe(false);
    expect(await readdir(root)).toEqual(['new.json']);
  });
  it.skipIf(process.platform !== 'win32')(
    'keeps newly published files replaceable under concurrent native creation',
    async () => {
      const workers = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, worker) => {
          for (let index = 0; index < 100; index++) {
            const path = join(root, `state-${worker}-${index}.json`);
            expect(await publishFileExclusive(path, 'initial')).toBe(true);
            await writeFileAtomic(path, 'replacement');
            expect(await readFile(path, 'utf8')).toBe('replacement');
          }
        }),
      );
      // Join every writer before asserting so failures cannot race fixture cleanup.
      expect(workers.filter((result) => result.status === 'rejected')).toEqual(
        [],
      );
      expect(await readdir(root)).toHaveLength(800);
    },
    60_000,
  );
});

/** Hold a real deny-delete Windows file handle until the test releases stdin. */
async function holdWindowsReadLock(path: string): Promise<() => Promise<void>> {
  const child = spawn(
    join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
$handle = [System.IO.File]::Open($env:DREAMUX_TEST_LOCK, 'Open', 'Read', 'Read')
try {
  [Console]::WriteLine('locked')
  [Console]::Out.Flush()
  [Console]::ReadLine() | Out-Null
} finally { $handle.Dispose() }
`,
    ],
    {
      windowsHide: true,
      env: { ...process.env, DREAMUX_TEST_LOCK: path },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  const ready = once(child.stdout, 'data');
  await once(child, 'spawn');
  expect(String((await ready)[0]).trim()).toBe('locked');
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      child.stdin.end('\n');
    }
    await closed;
  };
}

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
    await expectOwnerOnlyPermissions(path, 0o600);
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
