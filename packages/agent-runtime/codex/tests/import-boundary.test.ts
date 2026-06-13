/**
 * Import-boundary guard (issue #209 slice 3 validation guard).
 *
 * `@excitedjs/agent-runtime-codex` must implement the Dreamux Agent Runtime
 * contract against `@excitedjs/dreamux-types` ONLY — it must never import
 * `@excitedjs/dreamux` core, and its source must not reach back into the host
 * tree via a relative path escape. This scans the package's own `src/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createCodexAgentRuntimeProvider } from '../src/index.js';

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

describe('agent-runtime-codex import boundary', () => {
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

  it('the provider factory is constructable against the public contract only', () => {
    const provider = createCodexAgentRuntimeProvider();
    expect(provider.ref).toBe('builtin:codex');
    expect(provider.descriptor.kind).toBe('agentRuntime');
    expect(provider.getCapabilities().resume.supported).toBe(true);
  });
});
