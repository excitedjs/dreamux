/**
 * Import-boundary guard (issue #209 validation guard).
 *
 * `@excitedjs/dreamux-types` must not depend on `@excitedjs/dreamux`, and the
 * external-provider fixture (standing in for a provider in another repo) must
 * import Dreamux contracts from `@excitedjs/dreamux-types` only. This scans the
 * package's own `src/` and the fixture for a forbidden host import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const HOST_IMPORT = /from\s+['"]@excitedjs\/dreamux['"]/;

describe('dreamux-types import boundary', () => {
  it('package src never imports @excitedjs/dreamux', () => {
    const offenders = walk(join(pkgRoot, 'src')).filter((file) =>
      HOST_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the external-provider fixture imports @excitedjs/dreamux-types only', () => {
    const fixture = readFileSync(
      join(pkgRoot, 'tests', 'fixtures', 'external-provider.ts'),
      'utf8',
    );
    expect(HOST_IMPORT.test(fixture)).toBe(false);
    expect(fixture).toMatch(/from\s+['"]@excitedjs\/dreamux-types['"]/);
  });
});
