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
import ts from 'typescript';

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
const TEST_DOUBLE_EXPORT = /\b(?:createFakeFeishuBot|FakeFeishuBot)\b/;
const DISTINCTIVE_RUNTIME_TERMS = new Set([
  'exec_command',
  'apply_patch',
  'commandActions',
  'contentItems',
  'structuredContent',
  'inputText',
  'inputImage',
  'aggregatedOutput',
]);
const ORDINARY_RUNTIME_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
]);
const APPROVED_COT_ACTION_DISPLAY_NAMES = new Set(['Read', 'Edit', 'Bash']);

function runtimeVocabulary(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    const value = ts.isIdentifier(node) || ts.isStringLiteralLike(node)
      ? node.text
      : null;
    if (
      value !== null &&
      (DISTINCTIVE_RUNTIME_TERMS.has(value) || ORDINARY_RUNTIME_TOOL_NAMES.has(value))
    ) {
      found.add(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found].sort();
}

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

  it('package src contains no test-only fake bot implementation or export', () => {
    const offenders = files.filter((file) =>
      TEST_DOUBLE_EXPORT.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps provider-specific runtime vocabulary out of the channel package', () => {
    const offenders = files.flatMap((file) => {
      const terms = runtimeVocabulary(readFileSync(file, 'utf8')).filter((term) => {
        if (!ORDINARY_RUNTIME_TOOL_NAMES.has(term)) return true;
        return !(
          file.endsWith('/feishu-cot-events.ts') &&
          APPROVED_COT_ACTION_DISPLAY_NAMES.has(term)
        );
      });
      return terms.map((term) => `${file}:${term}`);
    });
    expect(offenders).toEqual([]);
  });

  it('detects runtime vocabulary in code while ignoring comments', () => {
    expect(runtimeVocabulary(`
      // commandActions and Bash in comments do not count.
      const commandActions = 'exec_command';
      const display = 'Bash';
    `)).toEqual(['Bash', 'commandActions', 'exec_command']);
  });

  it('the channel provider is constructable against the public contract only', () => {
    const provider = createFeishuChannelProvider();
    expect(provider.ref).toBe('builtin:feishu');
    expect(provider.descriptor.kind).toBe('channel');
    expect(typeof provider.createSession).toBe('function');
    expect(typeof provider.readConfig).toBe('function');
  });
});
