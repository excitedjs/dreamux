/**
 * Acceptance tests for the package launchers.
 *
 * The launcher must work from any cwd, follow symlinks, and shell out to
 * compiled dist output with plain node. Issue #18 removes package-global
 * legacy aliases; this test also pins the package manifest to the supported
 * public bins.
 */

import { describe, it, expect, beforeAll } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- black-box launcher acceptance test: it execs the compiled `dreamux`/`tm` bins as real child processes and asserts on captured stdout/exit code; spawnSync keeps each case one synchronous assertion with no async lifecycle to leak between tests (issue #85 test-scope carve-out).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dreamuxBinPath } from '../src/platform/package-bin.js';

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const PKG_BIN_DREAMUX = join(PACKAGE_ROOT, 'bin', 'dreamux');
const PKG_BIN_TM = join(PACKAGE_ROOT, 'bin', 'tm');
const ROOT_BIN_DREAMUX = join(MONOREPO_ROOT, 'bin', 'dreamux');

beforeAll(() => {
  const distFiles = [
    join(PACKAGE_ROOT, 'dist', 'cli', 'dreamux.js'),
    join(PACKAGE_ROOT, 'dist', 'cli', 'server.js'),
    join(PACKAGE_ROOT, 'dist', 'cli', 'server-ctl.js'),
  ];
  for (const distFile of distFiles) {
    if (!existsSync(distFile)) {
      throw new Error(
        `dist artefact ${distFile} is missing — run 'rush build' before these tests.`,
      );
    }
  }
});

function runHelp(binPath: string, cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(binPath, ['--help'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

interface LauncherCase {
  label: string;
  bin: string;
  execsNodeDirectly?: boolean;
  forwards?: boolean;
}

const LAUNCHERS: LauncherCase[] = [
  {
    label: 'packages/dreamux/bin/dreamux',
    bin: PKG_BIN_DREAMUX,
    execsNodeDirectly: true,
  },
  {
    label: '<repo>/bin/dreamux',
    bin: ROOT_BIN_DREAMUX,
    forwards: true,
  },
];

describe('package bin manifest', () => {
  it('publishes only the supported global bins', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };

    expect(manifest.bin).toEqual({
      dreamux: './bin/dreamux',
      tm: './bin/tm',
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

describe('packages/dreamux/bin/tm', () => {
  it('forwards to the package-local @excitedjs/tm executable without tsx', () => {
    const script = readFileSync(PKG_BIN_TM, 'utf8');

    expect(script).toContain('node_modules/.bin/tm');
    expect(script).not.toMatch(/\btsx\b/);
  });
});

for (const c of LAUNCHERS) {
  describe(c.label, () => {
    it('runs --help from /', () => {
      const { status, stdout } = runHelp(c.bin, '/');
      expect(status).toBe(0);
      expect(stdout).toContain('dreamux <command>');
      expect(stdout).toContain('serve');
      expect(stdout).not.toContain('dreamux-server');
      expect(stdout).not.toContain('server-ctl');
    });

    it('runs --help from a tmp dir', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-cwd-'));
      try {
        const { status, stdout } = runHelp(c.bin, tmp);
        expect(status).toBe(0);
        expect(stdout).toContain('dreamux <command>');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('runs via absolute symlink', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
      try {
        const link = join(tmp, 'launcher-link');
        symlinkSync(c.bin, link);
        const { status, stdout } = runHelp(link, '/');
        expect(status).toBe(0);
        expect(stdout).toContain('dreamux <command>');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('runs via nested symlink', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
      try {
        const inner = join(tmp, 'inner');
        symlinkSync(c.bin, inner);
        const outer = join(tmp, 'outer');
        symlinkSync('inner', outer);
        const { status, stdout } = runHelp(outer, '/');
        expect(status).toBe(0);
        expect(stdout).toContain('dreamux <command>');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('does not depend on tsx being installed', () => {
      const script = readFileSync(c.bin, 'utf8');
      expect(script).not.toMatch(/\btsx\b/);
    });

    if (c.execsNodeDirectly === true) {
      it('execs plain node against the compiled dist target', () => {
        const script = readFileSync(c.bin, 'utf8');
        expect(script).toContain('NODE_BIN="${DREAMUX_NODE_BIN:-node}"');
        expect(script).toMatch(/exec env DREAMUX_BIN="\$DREAMUX_BIN" "\$NODE_BIN" "\$TARGET"/);
      });
    }

    if (c.forwards === true) {
      it('forwards to the package-local dreamux launcher', () => {
        const script = readFileSync(c.bin, 'utf8');
        expect(script).toMatch(
          /exec "\$ROOT\/packages\/dreamux\/bin\/dreamux" "\$@"/,
        );
      });
    }
  });
}
