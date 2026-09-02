import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..');
const RELEASE_WORKFLOW = readFileSync(
  resolve(REPO_ROOT, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const SCAN_SCRIPT = readFileSync(
  resolve(REPO_ROOT, 'common', 'scripts', 'check-internal-content.sh'),
  'utf8',
);

// The forbidden tokens are assembled rather than written whole. This file feeds
// the scanner exactly what it must reject, and a scanner that flagged its own
// test would need a hole in its allowlist to accommodate it — so it does not
// get one.
const SEP = '/';
const MOUNT = `${SEP}data00${SEP}`;
const home = (user: string): string => `${SEP}home${SEP}${user}${SEP}`;

describe('internal-content tree scan', () => {
  it('extracts exactly what the release tarball audit extracts', () => {
    // Two gates, one red line: the release workflow audits packed tarballs and
    // this script audits the source tree. They only cover for each other while
    // they look for the same thing, and nothing but this test notices when one
    // is tightened and the other is not.
    const releasePattern = RELEASE_WORKFLOW.match(
      /\|\s+grep -aoE '([^']+)' \\\n/,
    )?.[1];
    const scriptPattern = SCAN_SCRIPT.match(/^FORBIDDEN_RE='([^']+)'$/m)?.[1];

    expect(scriptPattern).toBeDefined();
    expect(scriptPattern).toBe(releasePattern);
  });

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
