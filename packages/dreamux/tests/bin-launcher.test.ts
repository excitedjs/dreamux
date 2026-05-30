/**
 * Acceptance tests for the bin/ launchers.
 *
 * Covers two surfaces, both required to keep working:
 *   1. The package-local launchers under packages/dreamux/bin/:
 *      `dreamux`, `server`, `server-ctl`.
 *   2. The repo-root forwarders under <repo>/bin/ that operators with
 *      pre-monorepo PATH entries still rely on (issue #4, decision 0002).
 *
 * Each launcher must:
 *   - work from any cwd (resolve its own location via $BASH_SOURCE)
 *   - follow symlinks (npm-link / ~/bin shortcuts / nested chains)
 *   - shell out to plain `node`, not `tsx` (no dev-tool runtime dep, PR #6)
 *
 * Tests spawn the real bash launcher against the actually-built `dist/`
 * in this checkout, so a regression in either the bash logic or the tsc
 * emit gets caught.
 */

import { describe, it, expect, beforeAll } from 'vitest';
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

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

// Package-local launchers (installed under node_modules/.bin when this
// package is consumed as @excitedjs/dreamux).
const PKG_BIN_DREAMUX = join(PACKAGE_ROOT, 'bin', 'dreamux');
const PKG_BIN_SERVER = join(PACKAGE_ROOT, 'bin', 'server');
const PKG_BIN_CTL = join(PACKAGE_ROOT, 'bin', 'server-ctl');

// Repo-root forwarders (backward-compat with pre-monorepo PATH entries
// pointing at <repo>/bin).
const ROOT_BIN_DREAMUX = join(MONOREPO_ROOT, 'bin', 'dreamux');
const ROOT_BIN_SERVER = join(MONOREPO_ROOT, 'bin', 'server');
const ROOT_BIN_CTL = join(MONOREPO_ROOT, 'bin', 'server-ctl');

beforeAll(() => {
  // Acceptance criterion: a built dist/ exists for the package; `npm
  // install`'s prepare hook produces it. Repo-root shims forward into
  // this same dist/, so checking the package paths is sufficient.
  for (const f of [
    join(PACKAGE_ROOT, 'dist', 'cli', 'dreamux.js'),
    join(PACKAGE_ROOT, 'dist', 'cli', 'server.js'),
    join(PACKAGE_ROOT, 'dist', 'cli', 'server-ctl.js'),
  ]) {
    if (!existsSync(f)) {
      throw new Error(
        `dist artefact ${f} is missing — run 'npm run build' before these tests.`,
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
  /** Display name for `describe`. */
  label: string;
  /** Absolute path of the launcher. */
  bin: string;
  /** Substring that must appear in the --help stdout. */
  helpMarker: string;
  /** When set, also assert that the shim does not exec `tsx` and instead exec's `node`. */
  noTsx?: boolean;
  /** When set, also assert the shim execs `node "$TARGET"` directly (i.e. is the real launcher, not a thin redirector). */
  execsNodeDirectly?: boolean;
  /** When set, also assert the shim forwards (`exec` to a real launcher) rather than `exec node`. */
  forwards?: boolean;
}

const PACKAGE_LAUNCHERS: LauncherCase[] = [
  {
    label: 'packages/dreamux/bin/dreamux (unified CLI)',
    bin: PKG_BIN_DREAMUX,
    helpMarker: 'unified CLI',
    noTsx: true,
    execsNodeDirectly: true,
  },
  {
    label: 'packages/dreamux/bin/server (legacy alias)',
    bin: PKG_BIN_SERVER,
    helpMarker: 'dreamux-server',
    noTsx: true,
    execsNodeDirectly: true,
  },
  {
    label: 'packages/dreamux/bin/server-ctl (legacy alias)',
    bin: PKG_BIN_CTL,
    helpMarker: 'server-ctl',
    noTsx: true,
    execsNodeDirectly: true,
  },
];

const ROOT_FORWARDERS: LauncherCase[] = [
  {
    label: '<repo>/bin/dreamux (root forwarder)',
    bin: ROOT_BIN_DREAMUX,
    helpMarker: 'unified CLI',
    noTsx: true,
    forwards: true,
  },
  {
    label: '<repo>/bin/server (root forwarder, backward compat)',
    bin: ROOT_BIN_SERVER,
    helpMarker: 'dreamux-server',
    noTsx: true,
    forwards: true,
  },
  {
    label: '<repo>/bin/server-ctl (root forwarder, backward compat)',
    bin: ROOT_BIN_CTL,
    helpMarker: 'server-ctl',
    noTsx: true,
    forwards: true,
  },
];

for (const c of [...PACKAGE_LAUNCHERS, ...ROOT_FORWARDERS]) {
  describe(c.label, () => {
    it('runs --help from / (cwd-independent)', () => {
      const { status, stdout } = runHelp(c.bin, '/');
      expect(status).toBe(0);
      expect(stdout).toContain(c.helpMarker);
    });

    it('runs --help from a tmp dir (cwd-independent)', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-cwd-'));
      try {
        const { status, stdout } = runHelp(c.bin, tmp);
        expect(status).toBe(0);
        expect(stdout).toContain(c.helpMarker);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('runs via absolute symlink (npm-link / ~/bin style)', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
      try {
        const link = join(tmp, 'launcher-link');
        symlinkSync(c.bin, link);
        const { status, stdout } = runHelp(link, '/');
        expect(status).toBe(0);
        expect(stdout).toContain(c.helpMarker);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('runs via nested symlink (relative → absolute target)', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'dreamux-link-'));
      try {
        const inner = join(tmp, 'inner');
        symlinkSync(c.bin, inner);
        const outer = join(tmp, 'outer');
        symlinkSync('inner', outer); // relative, same dir
        const { status, stdout } = runHelp(outer, '/');
        expect(status).toBe(0);
        expect(stdout).toContain(c.helpMarker);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    if (c.noTsx === true) {
      it('does not depend on tsx being installed', () => {
        // Static check: the shim source must not contain `tsx` even if
        // tsx happens to be installed when the test runs.
        const script = readFileSync(c.bin, 'utf8');
        expect(script).not.toMatch(/\btsx\b/);
      });
    }

    if (c.execsNodeDirectly === true) {
      it('exec`s plain `node` against the compiled dist target', () => {
        const script = readFileSync(c.bin, 'utf8');
        expect(script).toMatch(/exec node "\$TARGET"/);
      });
    }

    if (c.forwards === true) {
      it('forwards to a launcher under packages/dreamux/bin/', () => {
        const script = readFileSync(c.bin, 'utf8');
        // The forwarder must end with `exec "$ROOT/packages/dreamux/bin/<x>"`.
        expect(script).toMatch(
          /exec "\$ROOT\/packages\/dreamux\/bin\/(dreamux|server|server-ctl)" "\$@"/,
        );
      });
    }
  });
}
