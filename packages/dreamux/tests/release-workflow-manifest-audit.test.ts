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

describe('release tarball home-path audit', () => {
  it('allows only the reviewed public home tokens through the real two-stage filter', async () => {
    const extractionPattern = RELEASE_WORKFLOW.match(
      /\|\s+grep -aoE '([^']+)' \\\n/,
    )?.[1];
    const allowlistPattern = RELEASE_WORKFLOW.match(
      /\|\s+grep -vxE '([^']+)' \\\n/,
    )?.[1];
    expect(extractionPattern).toContain('/home/[a-z][a-z0-9_-]+/');
    expect(allowlistPattern).toBe('/home/(volta|linuxbrew)/');

    const extracted = await execa(
      'grep',
      ['-aoE', extractionPattern ?? ''],
      {
        input: [
          '/home/volta/bin/node',
          '/home/linuxbrew/.linuxbrew/bin',
          '/home/example/project',
          '/home/linuxbrew2/private',
        ].join('\n'),
        reject: false,
      },
    );
    const filtered = await execa(
      'grep',
      ['-vxE', allowlistPattern ?? ''],
      {
        input: extracted.stdout,
        reject: false,
      },
    );

    expect(filtered.stdout.split('\n').filter(Boolean).sort()).toEqual([
      '/home/example/',
      '/home/linuxbrew2/',
    ]);
  });
});
