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

  beforeEach(() => {
    // The fixture root must NOT live under /tmp: the shared-tmp guard would
    // (correctly) reject an XDG candidate placed there, and a /tmp-based HOME
    // would make the dreamux run root itself look shared-tmp.
    root = mkdtempSync(join(homedir(), '.dreamux-sockets-test-'));
    previousHome = process.env['HOME'];
    previousXdg = process.env['XDG_RUNTIME_DIR'];
    process.env['HOME'] = join(root, 'home');
    delete process.env['XDG_RUNTIME_DIR'];
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
    else process.env['XDG_RUNTIME_DIR'] = previousXdg;
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

  it('fails loudly when even the dreamux-owned fallback is over budget', () => {
    process.env['HOME'] = join(root, 'h'.repeat(120));
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
