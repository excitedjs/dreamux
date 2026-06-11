import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureOwnerOnlyDir } from '../src/platform/owner-only-dir.js';
import { assertNoLegacyAdminServer } from '../src/admin/socket.js';

describe('ensureOwnerOnlyDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-owner-dir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a missing dir owner-only', async () => {
    const dir = join(root, 'run', 'sockets');
    await ensureOwnerOnlyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing group/world-traversable dir to 0700', async () => {
    const dir = join(root, 'run');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    await ensureOwnerOnlyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('leaves an already-0700 dir untouched', async () => {
    const dir = join(root, 'run');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await ensureOwnerOnlyDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlinked runtime dir', async () => {
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'linked');
    symlinkSync(real, link);
    await expect(ensureOwnerOnlyDir(link)).rejects.toThrow(/symlink/);
  });

  it('fails loud when the dir is owned by another uid', async () => {
    // Creating a foreign-owned dir needs root, so drive the branch with a
    // getuid override that reports a different uid than the dir's real owner.
    const dir = join(root, 'run');
    mkdirSync(dir, { recursive: true });
    const realOwner = statSync(dir).uid;
    await expect(
      ensureOwnerOnlyDir(dir, { getuid: () => realOwner + 1 }),
    ).rejects.toThrow(/owned by uid/);
  });

  it('accepts a dir owned by the current uid', async () => {
    const dir = join(root, 'run');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const realOwner = statSync(dir).uid;
    await expect(
      ensureOwnerOnlyDir(dir, { getuid: () => realOwner }),
    ).resolves.toBeUndefined();
  });
});

describe('assertNoLegacyAdminServer', () => {
  let root: string;
  let legacyLockPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-legacy-admin-'));
    legacyLockPath = join(root, 'state', 'admin.sock.lock');
    mkdirSync(join(root, 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes when no legacy lock exists', async () => {
    await expect(
      assertNoLegacyAdminServer({ legacyLockPath }),
    ).resolves.toBeUndefined();
  });

  it('fails loud when a live old server still holds the legacy lock', async () => {
    writeFileSync(legacyLockPath, '4242\n');
    await expect(
      assertNoLegacyAdminServer({
        legacyLockPath,
        isPidAlive: (pid) => pid === 4242,
      }),
    ).rejects.toThrow(/legacy dreamux serve process \(pid 4242\)/);
  });

  it('ignores a stale legacy lock whose holder is dead', async () => {
    writeFileSync(legacyLockPath, '4242\n');
    await expect(
      assertNoLegacyAdminServer({
        legacyLockPath,
        isPidAlive: () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it('ignores an unreadable/empty legacy lock', async () => {
    writeFileSync(legacyLockPath, '\n');
    await expect(
      assertNoLegacyAdminServer({
        legacyLockPath,
        isPidAlive: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('never removes the legacy lock (detection only)', async () => {
    writeFileSync(legacyLockPath, '4242\n');
    await assertNoLegacyAdminServer({
      legacyLockPath,
      isPidAlive: () => false,
    });
    expect(statSync(legacyLockPath).isFile()).toBe(true);
  });
});
