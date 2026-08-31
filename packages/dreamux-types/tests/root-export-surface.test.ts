/**
 * Root-export completeness guard (issue #209 root-export policy).
 *
 * `src/index.ts` documents: "the root aggregates every public contract type so
 * an external provider author can name any of them directly... The `exports`
 * map publishes only this root, so this list IS the public API." This test
 * reads every `export interface`/`export type` declared across `src/*.ts` and
 * asserts each name is re-exported from `index.ts`, so a newly added public
 * type cannot silently stay unreachable to an external provider package.
 *
 * There is no carve-out: every declared public type is reachable from the root.
 * `turn.ts` used to be one — its inbound-turn shapes were declared but withheld
 * from the root — but it had no consumer left once Channel rendering moved out
 * of the runtime-neutral layer, so the module was deleted rather than kept as a
 * documented exception.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

/** Matches a top-level `export interface Foo` / `export type Foo` declaration name. */
const DECLARATION_NAME = /^export\s+(?:interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

function declaredExportNames(fileText: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  DECLARATION_NAME.lastIndex = 0;
  while ((match = DECLARATION_NAME.exec(fileText))) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

/** Every name inside a root `export type { A, B, ... } from './module.js';` block. */
function rootReExportedNames(indexText: string): Set<string> {
  const names = new Set<string>();
  const blockPattern = /export type \{([^}]*)\} from/gs;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(indexText))) {
    const body = match[1];
    if (!body) continue;
    for (const rawName of body.split(',')) {
      const name = rawName.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const sourceFiles = readdirSync(srcRoot)
  .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
  .sort();

const indexText = readFileSync(join(srcRoot, 'index.ts'), 'utf8');
const rootExports = rootReExportedNames(indexText);

describe('src/index.ts re-exports every public contract type', () => {
  it('the root export list is non-trivially populated (guards against a parse regression)', () => {
    expect(rootExports.size).toBeGreaterThan(50);
  });

  for (const file of sourceFiles) {
    const text = readFileSync(join(srcRoot, file), 'utf8');
    const declared = declaredExportNames(text);

    it(`every type declared in ${file} is reachable from the package root`, () => {
      expect(declared.length).toBeGreaterThan(0);
      const missing = declared.filter((name) => !rootExports.has(name));
      expect(missing).toEqual([]);
    });
  }
});

describe('the root export surface has no carve-out', () => {
  it('the deleted inbound-turn shapes are gone from source and root alike', () => {
    expect(sourceFiles).not.toContain('turn.ts');
    for (const name of ['InboundAttachment', 'InboundTurnInput']) {
      expect(rootExports.has(name)).toBe(false);
    }
  });
});
