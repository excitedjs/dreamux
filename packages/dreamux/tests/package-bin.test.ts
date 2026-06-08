/**
 * Unit tests for `resolveExecutableOnPath` (issue #126 PR7).
 *
 * This is the async PATH probe behind the honest `get_capabilities`
 * advertisement: it proves whether a worker binary is resolvable in the service
 * environment the way a shell would, which is the exact signal behind a
 * `spawn <bin> ENOENT`. Fixtures use sync fs (allowed under `tests/**`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExecutableOnPath } from '../src/platform/package-bin.js';

function writeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe('resolveExecutableOnPath', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-pathprobe-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a bare name found on PATH to its absolute path', async () => {
    const binDir = join(root, 'bin');
    const expected = writeExecutable(binDir, 'mybin');

    const resolved = await resolveExecutableOnPath('mybin', {
      PATH: `/nonexistent-dreamux-dir:${binDir}`,
    });
    expect(resolved).toBe(expected);
  });

  it('returns null for a bare name that is on no PATH entry', async () => {
    const resolved = await resolveExecutableOnPath('definitely-not-here', {
      PATH: `/nonexistent-dreamux-dir:${root}`,
    });
    expect(resolved).toBeNull();
  });

  it('checks an absolute path directly without consulting PATH', async () => {
    const abs = writeExecutable(join(root, 'abs'), 'tool');

    const resolved = await resolveExecutableOnPath(abs, {
      PATH: '/nonexistent-dreamux-dir',
    });
    expect(resolved).toBe(abs);
  });

  it('returns null for an absolute path that does not exist', async () => {
    const resolved = await resolveExecutableOnPath(join(root, 'missing-tool'), {
      PATH: '/nonexistent-dreamux-dir',
    });
    expect(resolved).toBeNull();
  });

  it('returns null for an empty bin name', async () => {
    const resolved = await resolveExecutableOnPath('', { PATH: root });
    expect(resolved).toBeNull();
  });

  it('returns null when PATH is empty for a bare name', async () => {
    const resolved = await resolveExecutableOnPath('anything', { PATH: '' });
    expect(resolved).toBeNull();
  });
});
