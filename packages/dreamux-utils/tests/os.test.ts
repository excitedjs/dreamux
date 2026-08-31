/**
 * OS/filesystem primitives (os.ts): process-group signalling, the owner-only
 * directory invariant, empty-log cleanup, and the async existence probe.
 *
 * `ensureOwnerOnlyDir` and `removeEmptyLogFile` touch the real filesystem, so
 * these use a per-test mkdtemp directory cleaned up in afterEach — never the
 * operator's real ~/.dreamux state.
 */
import { mkdtemp, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { describe, it, expect, afterEach } from 'vitest';

import {
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
  ensureOwnerOnlyDir,
  removeEmptyLogFile,
  pathExists,
} from '../src/os.js';

/**
 * Spawn a detached child that exits immediately and await its exit, returning
 * a pid/pgid that is provably dead. This is deliberately NOT a hardcoded
 * high literal like 999999: on a long-lived shared box `pid_max` is commonly
 * well above a million, so a hardcoded "surely free" pid can collide with a
 * real, live process owned by someone else. Signalling that pid would be a
 * live hazard, not just test flake.
 */
async function getProvablyDeadPid(): Promise<number> {
  const child = spawn('node', ['-e', 'process.exit(0)'], { detached: true });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => {
      if (child.pid === undefined) reject(new Error('spawned child has no pid'));
    });
    child.once('exit', () => {
      if (child.pid !== undefined) resolve(child.pid);
    });
    child.once('error', reject);
  });
  // Immediate pid/pgid reuse in the few microseconds before the assertion
  // below runs is negligible on any real kernel.
  return pid;
}

describe('isProcessAlive', () => {
  it('is true for the current process (always alive, and we own it)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a pid that is not a positive finite integer', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
    expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('is false for a pid that has just exited (provably dead, not a guessed-free literal)', async () => {
    const deadPid = await getProvablyDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);
  });
});

describe('isProcessGroupAlive / killProcessGroup with a real detached child', () => {
  let child: ReturnType<typeof spawn> | null = null;

  afterEach(async () => {
    if (child && child.pid !== undefined) {
      try {
        killProcessGroup(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child = null;
  });

  it('reports a freshly spawned detached child group as alive, then not-alive after SIGKILL', async () => {
    child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
    await new Promise<void>((resolve, reject) => {
      child!.once('spawn', () => resolve());
      child!.once('error', reject);
    });
    const pgid = child.pid!;
    // A detached child is its own process-group leader, so its pid == its pgid.
    expect(isProcessGroupAlive(pgid)).toBe(true);

    killProcessGroup(pgid, 'SIGKILL');

    // Give the kernel a moment to reap the signalled group.
    const deadline = Date.now() + 2_000;
    while (isProcessGroupAlive(pgid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isProcessGroupAlive(pgid)).toBe(false);
  });

  it('killProcessGroup on an already-absent group is a silent no-op (ESRCH swallowed)', async () => {
    const deadPgid = await getProvablyDeadPid();
    expect(() => killProcessGroup(deadPgid, 'SIGTERM')).not.toThrow();
  });

  it('isProcessGroupAlive/killProcessGroup ignore non-positive or non-finite pgids', () => {
    expect(isProcessGroupAlive(0)).toBe(false);
    expect(isProcessGroupAlive(-5)).toBe(false);
    expect(() => killProcessGroup(0, 'SIGTERM')).not.toThrow();
    expect(() => killProcessGroup(-5, 'SIGTERM')).not.toThrow();
  });
});

describe('ensureOwnerOnlyDir', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('creates a fresh directory with 0700 permissions', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const target = join(root, 'nested', 'dir');
    await ensureOwnerOnlyDir(target);
    const info = await stat(target);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('tightens an existing directory that has permissive group/other bits', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const target = join(root, 'loose');
    await mkdir(target, { mode: 0o755 });
    await ensureOwnerOnlyDir(target);
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o700);
  });

  it('is idempotent: calling it twice on an already-0700 dir does not throw', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const target = join(root, 'idempotent');
    await ensureOwnerOnlyDir(target);
    await expect(ensureOwnerOnlyDir(target)).resolves.toBeUndefined();
  });

  it('refuses a symlink leaf even when the link points at a real directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const link = join(root, 'link');
    await symlink(real, link);
    await expect(ensureOwnerOnlyDir(link)).rejects.toThrow(/it is a symlink, not a real directory/);
  });

  it('rejects a directory owned by a different uid using the injected getuid probe', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const target = join(root, 'foreign');
    await mkdir(target, { mode: 0o700 });
    // Inject a getuid that reports a uid guaranteed to differ from the dir's
    // real owner (the current process), exercising the foreign-uid branch
    // without needing actual multi-user permissions.
    await expect(
      ensureOwnerOnlyDir(target, { getuid: () => -1 }),
    ).rejects.toThrow(/it is owned by uid \d+, not the current user \(uid -1\)/);
  });
});

describe('removeEmptyLogFile', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('removes a zero-byte file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const file = join(root, 'empty.log');
    await writeFile(file, '');
    await removeEmptyLogFile(file);
    expect(await pathExists(file)).toBe(false);
  });

  it('leaves a non-empty file untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const file = join(root, 'full.log');
    await writeFile(file, 'not empty');
    await removeEmptyLogFile(file);
    expect(await pathExists(file)).toBe(true);
  });

  it('never throws for a missing file (best-effort)', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    await expect(removeEmptyLogFile(join(root, 'nope.log'))).resolves.toBeUndefined();
  });
});

describe('pathExists', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('is true for an existing path and false for a missing one', async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-utils-os-'));
    const file = join(root, 'here.txt');
    await writeFile(file, 'x');
    expect(await pathExists(file)).toBe(true);
    expect(await pathExists(join(root, 'not-here.txt'))).toBe(false);
  });
});
