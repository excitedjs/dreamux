import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  allocateRuntimeSocketPath,
  isSharedTmpPath,
  runtimeSocketDirCandidates,
  sweepRuntimeSocketDirs,
} from '../src/platform/runtime-sockets.js';
import {
  resetRuntimeConfig,
  runRoot,
  stateRoot,
  unixSocketPathFitsBudget,
} from '../src/platform/paths.js';
import { allocateCodexSocketPath } from '../src/agent-runtime/builtin/codex/paths.js';

describe('runtime socket allocation', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousXdg: string | undefined;
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    // The fixture root must NOT live under /tmp: the shared-tmp guard would
    // (correctly) reject an XDG candidate placed there, and a /tmp-based HOME
    // would make the dreamux run root itself look shared-tmp.
    root = mkdtempSync(join(homedir(), '.dreamux-sockets-test-'));
    previousHome = process.env['HOME'];
    previousXdg = process.env['XDG_RUNTIME_DIR'];
    previousTmpdir = process.env['TMPDIR'];
    process.env['HOME'] = join(root, 'home');
    delete process.env['XDG_RUNTIME_DIR'];
    // Pin TMPDIR to a shared-tmp value so the private-OS-temp candidate is
    // excluded by default; tests that exercise it set TMPDIR explicitly. This
    // keeps allocation deterministic across Linux (`/tmp`) and macOS
    // (`$TMPDIR` = `/var/folders/…`, which would otherwise be a valid candidate).
    process.env['TMPDIR'] = '/tmp';
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
    else process.env['XDG_RUNTIME_DIR'] = previousXdg;
    if (previousTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmpdir;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers a private XDG runtime root and allocates short random names', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/424242' };
    const first = allocateRuntimeSocketPath('test socket', env);
    expect(first.startsWith('/run/user/424242/dreamux/sockets/')).toBe(true);
    expect(first.endsWith('.sock')).toBe(true);
    expect(unixSocketPathFitsBudget(first)).toBe(true);

    // Random per allocation: a fresh start never reuses a previous path.
    const second = allocateRuntimeSocketPath('test socket', env);
    expect(second).not.toBe(first);
  });

  it('rejects shared-tmp XDG roots and falls back to the dreamux run root', () => {
    // XDG_RUNTIME_DIR is operator input: a shared-tmp value must not bypass
    // the guard, whether it is the root itself or a subdirectory.
    for (const sharedXdg of ['/tmp', '/tmp/xdg', '/private/tmp', '/var/tmp/xdg']) {
      expect(isSharedTmpPath(sharedXdg)).toBe(true);
      const path = allocateRuntimeSocketPath('test socket', {
        XDG_RUNTIME_DIR: sharedXdg,
      });
      expect(path.startsWith(join(runRoot(), 'sockets'))).toBe(true);
    }
  });

  it('falls back to the dreamux run root when XDG is unset or over budget', () => {
    const noXdg = allocateRuntimeSocketPath('test socket', {});
    expect(noXdg.startsWith(join(runRoot(), 'sockets'))).toBe(true);
    expect(unixSocketPathFitsBudget(noXdg)).toBe(true);

    const longXdg = allocateRuntimeSocketPath('test socket', {
      XDG_RUNTIME_DIR: `/run/user/${'x'.repeat(120)}`,
    });
    expect(longXdg.startsWith(join(runRoot(), 'sockets'))).toBe(true);
  });

  it('never allocates under the durable state tree', () => {
    for (const env of [{}, { XDG_RUNTIME_DIR: '/run/user/424242' }]) {
      const path = allocateRuntimeSocketPath('test socket', env);
      expect(path.startsWith(stateRoot())).toBe(false);
      expect(isSharedTmpPath(path)).toBe(false);
    }
  });

  it('uses a private OS temp dir when XDG is absent and the run root is over budget (#182 macOS gate)', () => {
    // Reproduce the macOS CI failure: no XDG_RUNTIME_DIR and a long per-run HOME
    // push ~/.dreamux/run/sockets over the sun_path budget. A short, PRIVATE
    // TMPDIR (the macOS $TMPDIR analog) must keep the socket within budget
    // without touching shared /tmp or depending on the long durable HOME.
    process.env['HOME'] = join(root, 'h'.repeat(120));
    resetRuntimeConfig();
    const privateTmp = join(root, 't'); // short, under the real (short) home
    const path = allocateRuntimeSocketPath('test socket', { TMPDIR: privateTmp });
    expect(path.startsWith(join(privateTmp, 'dreamux', 'sockets'))).toBe(true);
    expect(path.endsWith('.sock')).toBe(true);
    expect(unixSocketPathFitsBudget(path)).toBe(true);
    expect(isSharedTmpPath(path)).toBe(false);
  });

  it('never uses a shared-tmp TMPDIR for sockets', () => {
    // On Linux os.tmpdir() is /tmp (shared); the private-temp candidate must be
    // excluded so we never reintroduce a world-shared tmp socket.
    for (const sharedTmp of ['/tmp', '/var/tmp', '/private/tmp']) {
      expect(runtimeSocketDirCandidates({ TMPDIR: sharedTmp })).toEqual([
        join(runRoot(), 'sockets'),
      ]);
    }
    // A private TMPDIR is appended after the dreamux run root, never before it.
    expect(runtimeSocketDirCandidates({ TMPDIR: join(root, 't') })).toEqual([
      join(runRoot(), 'sockets'),
      join(root, 't', 'dreamux', 'sockets'),
    ]);
  });

  it('fails loudly when even the dreamux-owned fallback is over budget', () => {
    process.env['HOME'] = join(root, 'h'.repeat(120));
    // TMPDIR pinned to shared /tmp (beforeEach) is excluded, so no private-temp
    // candidate rescues an over-budget run root here.
    expect(() => allocateRuntimeSocketPath('test socket', {})).toThrow(
      /test socket is too long for Unix sockets/,
    );
    // The codex wrapper names the owning dispatcher in the failure.
    expect(() => allocateCodexSocketPath('flow')).toThrow(
      /dispatcher 'flow' Codex socket path is too long/,
    );
  });

  it('sweeps every candidate dir wholesale and tolerates missing dirs', async () => {
    const xdg = join(root, 'xdg');
    const env = { XDG_RUNTIME_DIR: xdg };
    const [xdgDir, runDir] = runtimeSocketDirCandidates(env);
    expect(xdgDir).toBe(join(xdg, 'dreamux', 'sockets'));
    expect(runDir).toBe(join(runRoot(), 'sockets'));

    // Crash orphans from a previous server: both candidate dirs hold sockets.
    for (const dir of [xdgDir!, runDir!]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'orphan.sock'), '');
    }

    const swept = await sweepRuntimeSocketDirs(env);
    expect(swept).toEqual([xdgDir, runDir]);
    expect(existsSync(xdgDir!)).toBe(false);
    expect(existsSync(runDir!)).toBe(false);

    // A second sweep over now-missing dirs is a no-op, not an error.
    await expect(sweepRuntimeSocketDirs(env)).resolves.toEqual([xdgDir, runDir]);
  });
});
