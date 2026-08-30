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
 * `turn.ts` is the one documented exception: its header comment states its
 * shapes "no longer cross the Agent Runtime seam and are not part of the
 * package root export" (a Provider receives only already-rendered text). This
 * guard locks that as a deliberate, visible carve-out rather than an oversight
 * — it asserts every OTHER file's exports are reachable, and separately
 * asserts `turn.ts`'s exports stay unreachable, so either direction of change
 * has to touch this test file on purpose.
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
    if (file === 'turn.ts') continue; // covered by the dedicated carve-out test below.

    const text = readFileSync(join(srcRoot, file), 'utf8');
    const declared = declaredExportNames(text);

    it(`every type declared in ${file} is reachable from the package root`, () => {
      expect(declared.length).toBeGreaterThan(0);
      const missing = declared.filter((name) => !rootExports.has(name));
      expect(missing).toEqual([]);
    });
  }
});

describe('turn.ts is the documented, deliberate root-export carve-out', () => {
  it('InboundTurnInput / InboundAttachment are declared but NOT re-exported from the root', () => {
    const turnText = readFileSync(join(srcRoot, 'turn.ts'), 'utf8');
    const declared = declaredExportNames(turnText);

    expect(declared).toEqual(['InboundAttachment', 'InboundTurnInput']);
    for (const name of declared) {
      expect(rootExports.has(name)).toBe(false);
    }
  });

  it('turn.ts documents WHY it is excluded, so the carve-out stays visible in source', () => {
    const turnText = readFileSync(join(srcRoot, 'turn.ts'), 'utf8');
    // The source comment wraps across a JSDoc continuation line (`\n * `), so
    // the pattern tolerates that separator between the two halves of the
    // phrase rather than requiring plain whitespace.
    expect(turnText).toMatch(/not part of the package[\s*]+root export/);
  });
});
