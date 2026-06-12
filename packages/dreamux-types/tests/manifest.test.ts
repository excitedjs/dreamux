/**
 * Publishability + declaration-only guards for @excitedjs/dreamux-types.
 *
 * These assert the package manifest publishes declarations only and carries no
 * runtime contract surface or runtime dependencies (issue #209 validation
 * guards). They read the package's own manifest/tsconfig rather than importing
 * the package at runtime, because the package emits no runtime JS.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkgRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('@excitedjs/dreamux-types manifest', () => {
  const pkg = readJson('package.json');

  it('is named @excitedjs/dreamux-types', () => {
    expect(pkg.name).toBe('@excitedjs/dreamux-types');
  });

  it('exposes a types entry but no runtime main', () => {
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.main).toBeUndefined();
  });

  it('publishes a types-only exports map (no import/default/require target)', () => {
    const exportsMap = pkg.exports as Record<string, Record<string, unknown>>;
    expect(exportsMap['.']).toEqual({ types: './dist/index.d.ts' });
    expect(exportsMap['.'].import).toBeUndefined();
    expect(exportsMap['.'].default).toBeUndefined();
    expect(exportsMap['.'].require).toBeUndefined();
  });

  it('declares no runtime dependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('ships only declarations + docs in the published files list', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});

describe('@excitedjs/dreamux-types tsconfig', () => {
  const tsconfig = readJson('tsconfig.json');
  const options = tsconfig.compilerOptions as Record<string, unknown>;

  it('emits declarations only (no runtime JS)', () => {
    expect(options.emitDeclarationOnly).toBe(true);
    expect(options.declaration).toBe(true);
  });
});
