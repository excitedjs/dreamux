import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..');
const SCAN_SCRIPT_PATH = resolve(
  REPO_ROOT,
  'common',
  'scripts',
  'check-internal-content.sh',
);
const SCAN_SCRIPT = readFileSync(SCAN_SCRIPT_PATH, 'utf8');

// The forbidden tokens are assembled rather than written whole. This file feeds
// the scanner exactly what it must reject, and a scanner that flagged its own
// test would need a hole in its allowlist to accommodate it — so it does not
// get one.
const SEP = '/';
const MOUNT = `${SEP}data00${SEP}`;
const home = (user: string): string => `${SEP}home${SEP}${user}${SEP}`;

describe('internal-content tree scan', () => {
  it('allows a reviewed placeholder without allowing a name that starts with it', async () => {
    // `me` is an allowed placeholder and `meredith` is another. Written as a
    // bare alternation without the anchoring `-x`, both would also allow the
    // `mexico` and `meredith2` homes below — real-looking accounts that merely
    // start with an allowed name. The two-stage `grep -aoE | grep -vxE` shape
    // is what prevents that, so the real commands are what this exercises.
    const extractionPattern = SCAN_SCRIPT.match(/^FORBIDDEN_RE='([^']+)'$/m)?.[1];
    const allowlistPattern = SCAN_SCRIPT.match(/^ALLOWED_RE='([^']+)'$/m)?.[1];
    expect(extractionPattern).toContain('/home/[a-z][a-z0-9_-]+/');
    expect(allowlistPattern).toBeDefined();

    const extracted = await execa('grep', ['-aoE', extractionPattern ?? ''], {
      input: [
        `${home('me')}work`,
        `${home('meredith')}work`,
        `${home('mexico')}work`,
        `${home('meredith2')}work`,
        `${home('volta')}bin/node`,
        `${MOUNT}home/someone/work`,
      ].join('\n'),
      reject: false,
    });
    const rejected = await execa('grep', ['-vxE', allowlistPattern ?? ''], {
      input: extracted.stdout,
      reject: false,
    });

    expect(rejected.stdout.split('\n').filter(Boolean).sort()).toEqual([
      MOUNT,
      home('meredith2'),
      home('mexico'),
    ]);
  });
});

describe('internal-content tarball scan', () => {
  // The release workflow runs this very mode over every packed tarball before
  // upload, so what these cases exercise is the release gate's own behavior:
  // a real `.tgz`, the real script, its exit code and its report.
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function pack(name: string, distSource: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'internal-content-'));
    dirs.push(dir);
    await mkdir(join(dir, 'package', 'dist'), { recursive: true });
    await writeFile(join(dir, 'package', 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(dir, 'package', 'dist', 'index.js'), distSource);
    const tgz = join(dir, `${name}.tgz`);
    await execa('tar', ['czf', tgz, '-C', dir, 'package']);
    return tgz;
  }

  it('rejects a packed file carrying an internal path and names it, not the public install locations', async () => {
    // `linuxbrew2` starts with an allowed name: the anchored second stage is
    // what keeps it out, the same shape the tree scan relies on above. The
    // source-tree placeholder users are not allowed in an artifact at all.
    const tgz = await pack('leaky', [
      `const node = '${home('volta')}bin/node';`,
      `const brew = '${home('linuxbrew')}.linuxbrew/bin';`,
      `const nearMiss = '${home('linuxbrew2')}private';`,
      `const placeholder = '${home('example')}project';`,
      `const leaked = '${home('someone')}work';`,
      `const mount = '${MOUNT}home/someone/work';`,
    ].join('\n'));

    const result = await execa(SCAN_SCRIPT_PATH, ['--tarball', tgz], { reject: false });

    expect(result.exitCode).toBe(1);
    const reported = result.stderr
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim())
      .sort();
    expect(reported).toEqual([
      MOUNT,
      home('example'),
      home('linuxbrew2'),
      home('someone'),
    ]);
  });

  it('passes a tarball carrying only the public install locations, and refuses to scan a missing file', async () => {
    const tgz = await pack('clean', [
      `const node = '${home('volta')}bin/node';`,
      `const brew = '${home('linuxbrew')}.linuxbrew/bin';`,
    ].join('\n'));

    const clean = await execa(SCAN_SCRIPT_PATH, ['--tarball', tgz], { reject: false });
    expect(clean.exitCode).toBe(0);

    // A scanner that quietly ignores what it was asked to scan is the failure
    // this gate exists to remove: a path that is not a file is a usage error,
    // never a clean result.
    const missing = await execa(
      SCAN_SCRIPT_PATH,
      ['--tarball', join(dirname(tgz), 'absent.tgz')],
      { reject: false },
    );
    expect(missing.exitCode).toBe(2);
  });
});
