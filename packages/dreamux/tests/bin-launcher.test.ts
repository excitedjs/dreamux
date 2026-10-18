/**
 * Acceptance tests for the package launcher.
 *
 * The launcher must work from any cwd, follow symlinks, and shell out to
 * compiled dist output with plain node. Issue #18 removes package-global
 * legacy aliases; this test also pins the package manifest to the supported
 * public bins.
 */

import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- black-box launcher acceptance test: it execs the compiled `dreamux` bins as real child processes and asserts on captured stdout/exit code; spawnSync keeps each case one synchronous assertion with no async lifecycle to leak between tests (issue #85 test-scope carve-out).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dreamuxBinPath } from '../src/platform/package-bin.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PKG_BIN_DREAMUX = join(PACKAGE_ROOT, 'bin', 'dreamux');

beforeAll(() => {
  const distFiles = [
    join(PACKAGE_ROOT, 'dist', 'cli', 'dreamux.js'),
    join(PACKAGE_ROOT, 'dist', 'cli', 'server.js'),
  ];
  for (const distFile of distFiles) {
    if (!existsSync(distFile)) {
      throw new Error(
        `dist artefact ${distFile} is missing — run 'rush build' before these tests.`,
      );
    }
  }
});

function runHelp(
  binPath: string,
  cwd: string,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [binPath, '--help'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('package bin manifest', () => {
  it('publishes only the supported global bins', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };

    expect(manifest.bin).toEqual({
      dreamux: './bin/dreamux',
    });
  });
});

describe('runtime dreamux bin resolution', () => {
  it('uses an absolute package bin path by default', () => {
    expect(dreamuxBinPath({})).toBe(PKG_BIN_DREAMUX);
  });

  it('normalizes DREAMUX_BIN overrides to absolute paths', () => {
    expect(dreamuxBinPath({ DREAMUX_BIN: 'relative/dreamux' })).toBe(
      resolve('relative/dreamux'),
    );
  });
});

describe('packages/dreamux/bin/dreamux', () => {
  it('runs --help from the filesystem root', () => {
    const { status, stdout } = runHelp(
      PKG_BIN_DREAMUX,
      parse(PACKAGE_ROOT).root,
    );
    expect(status).toBe(0);
    expect(stdout).toContain('dreamux <command>');
    expect(stdout).toContain('serve');
    expect(stdout).not.toContain('dreamux-server');
    expect(stdout).not.toContain('server-ctl');
  });

  it('runs --help from a tmp dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dreamux-cwd-'));
    try {
      const { status, stdout } = runHelp(PKG_BIN_DREAMUX, tmp);
      expect(status).toBe(0);
      expect(stdout).toContain('dreamux <command>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs via absolute symlink', (context) => {
    const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
    try {
      const link = join(tmp, 'launcher-link');
      if (!createSymlink(PKG_BIN_DREAMUX, link)) return context.skip();
      const { status, stdout } = runHelp(link, parse(PACKAGE_ROOT).root);
      expect(status).toBe(0);
      expect(stdout).toContain('dreamux <command>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runs via nested symlink', (context) => {
    const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
    try {
      const inner = join(tmp, 'inner');
      if (!createSymlink(PKG_BIN_DREAMUX, inner)) return context.skip();
      const outer = join(tmp, 'outer');
      symlinkSync('inner', outer);
      const { status, stdout } = runHelp(outer, parse(PACKAGE_ROOT).root);
      expect(status).toBe(0);
      expect(stdout).toContain('dreamux <command>');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loads compiled output without dependencies and preserves literal argv from a path with spaces', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dreamux launcher spaces '));
    try {
      mkdirSync(join(tmp, 'bin'));
      mkdirSync(join(tmp, 'dist', 'cli'), { recursive: true });
      const bin = join(tmp, 'bin', 'dreamux');
      copyFileSync(PKG_BIN_DREAMUX, bin);
      writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(tmp, 'dist', 'cli', 'dreamux.js'),
        'console.log(JSON.stringify({ args: process.argv.slice(2), bin: process.env.DREAMUX_BIN })); process.exitCode = 7;',
      );
      const args = ['path with spaces', 'x&y', '{"value":"a b"}'];
      const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DREAMUX_NODE_BIN: process.execPath },
        windowsHide: true,
      });
      expect(result.status).toBe(7);
      expect(JSON.parse(result.stdout)).toEqual({ args, bin });

      const selectedNode = spawnSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DREAMUX_NODE_BIN: 'node' },
        windowsHide: true,
      });
      expect(selectedNode.status).toBe(7);
      expect(JSON.parse(selectedNode.stdout)).toEqual({ args, bin });

      const missingNode = spawnSync(process.execPath, [bin], {
        encoding: 'utf8',
        env: { ...process.env, DREAMUX_NODE_BIN: join(tmp, 'missing-node') },
        windowsHide: true,
      });
      expect(missingNode.status).toBe(1);
      expect(missingNode.stderr).toContain('ENOENT');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function createSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    )
      return false;
    throw error;
  }
}
