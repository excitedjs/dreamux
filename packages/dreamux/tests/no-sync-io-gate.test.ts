/**
 * Executable contract for the issue #85 synchronous-blocking-IO lint gate.
 *
 * These tests run the real ESLint flat config (`@excitedjs/eslint-config`, wired
 * through this package's `eslint.config.js`) against in-memory fixtures so the
 * gate's behaviour is pinned, not just assumed:
 *   - `src/**` is a hard error on any `*Sync` IO (`n/no-sync`);
 *   - `tests/**` exempts `n/no-sync` (sync `fs` fixtures are allowed) but still
 *     bans synchronous `child_process` via `no-restricted-imports`;
 *   - an `eslint-disable` without a reason is itself an error
 *     (`@eslint-community/eslint-comments/require-description`).
 *
 * The fixtures use file *paths* under `src/` and `tests/` (the files need not
 * exist on disk) so the flat-config `files` globs select the right block. The
 * banned constructs appear only inside `lintText` string arguments, so this test
 * file itself stays clean under the gate.
 */

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/ -> package root holding eslint.config.js.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function lint(filePath: string, code: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: PACKAGE_ROOT });
  return eslint.lintText(code, { filePath: join(PACKAGE_ROOT, filePath) });
}

function ruleIds(results: ESLint.LintResult[]): string[] {
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
}

describe('no-sync-io lint gate (issue #85)', () => {
  it('flags synchronous fs IO in src/** as an n/no-sync error', async () => {
    const results = await lint(
      'src/__gate_fixture__.ts',
      [
        "import { readFileSync } from 'node:fs';",
        'export function read(p: string): string {',
        "  return readFileSync(p, 'utf8');",
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('n/no-sync');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('import backstop fires on a renamed *Sync import that n/no-sync misses', async () => {
    // n/no-sync matches the *call site* by callee name. A renamed import is
    // called as `read(...)` — name does not end in `Sync` — so n/no-sync alone
    // would let it through. The `no-restricted-imports` backstop must catch the
    // import. Asserting n/no-sync is ABSENT proves the backstop is independently
    // load-bearing, not shadowed by the primary rule.
    const results = await lint(
      'src/__gate_alias__.ts',
      [
        "import { readFileSync as read } from 'node:fs';",
        'export function load(p: string): string {',
        "  return read(p, 'utf8');",
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-imports');
    expect(ruleIds(results)).not.toContain('n/no-sync');
  });

  it('destructure backstop fires on a rebind that n/no-sync and the import backstop miss', async () => {
    // `const { readFileSync: read } = fs` rebinds the Sync member away from any
    // detectable call-site name (the call below is `read(...)`). The fixture
    // pulls `fs` from a runtime value with no `import` at all, so neither
    // n/no-sync nor the `no-restricted-imports` backstop can match — only
    // `no-restricted-syntax` catches the destructure. Asserting the other two
    // are ABSENT proves this backstop is independently load-bearing.
    const results = await lint(
      'src/__gate_destructure__.ts',
      [
        'export function load(p: string): string {',
        '  const fs = globalThis as unknown as {',
        '    readFileSync(path: string): string;',
        '  };',
        '  const { readFileSync: read } = fs;',
        '  return read(p);',
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-syntax');
    expect(ruleIds(results)).not.toContain('n/no-sync');
    expect(ruleIds(results)).not.toContain('no-restricted-imports');
  });

  it('exempts synchronous fs IO in tests/** (sync fixtures are allowed)', async () => {
    const results = await lint(
      'tests/__gate_fixture__.ts',
      [
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "export const dir = mkdtempSync(tmpdir());",
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('n/no-sync');
    expect(ruleIds(results)).not.toContain('no-restricted-imports');
  });

  it('still bans synchronous child_process in tests/**', async () => {
    const results = await lint(
      'tests/__gate_cp__.ts',
      [
        "import { execSync } from 'node:child_process';",
        "export const out = execSync('echo hi');",
        '',
      ].join('\n'),
    );
    // n/no-sync is off for tests, but the child_process import backstop holds.
    expect(ruleIds(results)).toContain('no-restricted-imports');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('rejects an eslint-disable without a description', async () => {
    const results = await lint(
      'tests/__gate_disable__.ts',
      [
        '// eslint-disable-next-line no-restricted-imports',
        "import { execSync } from 'node:child_process';",
        "export const out = execSync('echo hi');",
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain(
      '@eslint-community/eslint-comments/require-description',
    );
  });

  it('accepts a child_process disable that carries a reason', async () => {
    const results = await lint(
      'tests/__gate_disable_ok__.ts',
      [
        '// eslint-disable-next-line no-restricted-imports -- black-box CLI test needs a synchronous probe (issue #85 carve-out)',
        "import { execSync } from 'node:child_process';",
        "export const out = execSync('echo hi');",
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('no-restricted-imports');
    expect(ruleIds(results)).not.toContain(
      '@eslint-community/eslint-comments/require-description',
    );
  });
});
