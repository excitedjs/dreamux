/**
 * Import-boundary guard (issue #209 slice 5 validation guard).
 *
 * `@excitedjs/feishu-channel` must implement the Dreamux Channel provider
 * contract against `@excitedjs/dreamux-types` + `@excitedjs/feishu-transport`
 * ONLY — it must never import `@excitedjs/dreamux` core, and its source must not
 * reach back into the host tree via a relative path escape. This scans the
 * package's own `src/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createFeishuChannelProvider } from '../src/index.js';

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
// Any relative import that climbs above the package src root would reach the
// host tree in the monorepo layout; the package must stay self-contained.
const RELATIVE_ESCAPE = /from\s+['"]\.\.\/\.\.\//;
// `@excitedjs/feishu-transport` is the SOLE owner of the Lark SDK import; the
// channel package must reach the platform only through it, never directly.
const LARK_SDK_IMPORT = /from\s+['"]@larksuiteoapi\//;

describe('feishu-channel import boundary', () => {
  const files = walk(join(pkgRoot, 'src'));

  it('package src never imports @excitedjs/dreamux core', () => {
    const offenders = files.filter((file) =>
      HOST_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('package src never escapes its own tree with a relative import', () => {
    const offenders = files.filter((file) =>
      RELATIVE_ESCAPE.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('package src never imports the Lark SDK directly', () => {
    const offenders = files.filter((file) =>
      LARK_SDK_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the channel provider is constructable against the public contract only', () => {
    const provider = createFeishuChannelProvider();
    expect(provider.ref).toBe('builtin:feishu');
    expect(provider.descriptor.kind).toBe('channel');
    expect(typeof provider.createSession).toBe('function');
    expect(typeof provider.readConfig).toBe('function');
  });
});
