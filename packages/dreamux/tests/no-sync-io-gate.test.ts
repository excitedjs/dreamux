/**
 * Executable contract for the issue #85 synchronous-blocking-IO lint gate.
 *
 * These tests run the real ESLint flat config (`@excitedjs/eslint-config`, wired
 * through this package's `eslint.config.js`) against in-memory fixtures so the
 * gate's behaviour is pinned, not just assumed:
 *   - `src/**` is a hard error on any `*Sync` IO (`n/no-sync`);
 *   - `src/**` files over 700 physical lines are a hard error (`max-lines`);
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
import { existsSync, readFileSync } from 'node:fs';
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

  it('flags source files over 700 physical lines', async () => {
    const results = await lint(
      'src/__large_source_fixture__.ts',
      Array.from({ length: 701 }, (_, i) => `// line ${i + 1}`).join('\n'),
    );
    expect(ruleIds(results)).toContain('max-lines');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('does not apply the source line-count gate to tests/**', async () => {
    const results = await lint(
      'tests/__large_test_fixture__.ts',
      Array.from({ length: 701 }, (_, i) => `// line ${i + 1}`).join('\n'),
    );
    expect(ruleIds(results)).not.toContain('max-lines');
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

// repoRoot -> packages/dreamux/tests -> up two levels.
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

interface RushProject {
  packageName: string;
  projectFolder: string;
}

/**
 * Same tolerant-regex rush.json reader package-boundary-guards.test.ts uses,
 * duplicated locally rather than imported: this file must stay independently
 * runnable, and importing another guard's helper would create an ownership
 * edge across two files different nodes may be revising concurrently.
 */
function rushProjects(): RushProject[] {
  const raw = readFileSync(join(REPO_ROOT, 'rush.json'), 'utf8');
  const re = /"packageName":\s*"([^"]+)"[\s\S]*?"projectFolder":\s*"([^"]+)"/g;
  const out: RushProject[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out.push({ packageName: m[1]!, projectFolder: m[2]! });
  }
  return out;
}

/**
 * Every rush project that ships its own `eslint.config.js` consuming the
 * shared gate. `@excitedjs/eslint-config` itself is excluded: it IS the
 * shared config (index.js only, no src/tests tree of its own to lint against
 * its own rules).
 */
const gatedProjects = rushProjects().filter((p) =>
  existsSync(join(REPO_ROOT, p.projectFolder, 'eslint.config.js')),
);

describe('the sync-IO gate is wired into every package, not just @excitedjs/dreamux (issue #85 repo-wide extension)', () => {
  it('discovers more than one gated package (sanity — a stub project list would pass everything vacuously)', () => {
    expect(gatedProjects.length).toBeGreaterThanOrEqual(6);
    expect(gatedProjects.map((p) => p.packageName)).toContain(
      '@excitedjs/agent-runtime-codex',
    );
  });

  it.each(gatedProjects.map((p) => [p.packageName, p.projectFolder] as const))(
    '%s: n/no-sync fires on synchronous fs IO in src/**, using that package\'s OWN eslint.config.js',
    async (_name, projectFolder) => {
      // Each package gets its own `new ESLint({ cwd })` rooted at ITS package
      // directory, so this resolves and exercises that package's real
      // eslint.config.js file (its own composition of the shared gate, plus
      // any import-boundary or neutral-contract additions it layers on top) —
      // strictly stronger than asserting the config file merely imports the
      // base config, which would miss a last-wins override that silently
      // dropped the gate.
      const pkgRoot = join(REPO_ROOT, projectFolder);
      const eslint = new ESLint({ cwd: pkgRoot });
      const results = await eslint.lintText(
        [
          "import { readFileSync } from 'node:fs';",
          'export function read(p: string): string {',
          "  return readFileSync(p, 'utf8');",
          '}',
          '',
        ].join('\n'),
        { filePath: join(pkgRoot, 'src/__cross_pkg_gate_fixture__.ts') },
      );
      const rules = results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
      expect(rules, `${projectFolder} src/** sync-IO gate`).toContain('n/no-sync');
    },
  );

  it.each(gatedProjects.map((p) => [p.packageName, p.projectFolder] as const))(
    '%s: tests/** allows sync fs but still bans sync child_process',
    async (_name, projectFolder) => {
      const pkgRoot = join(REPO_ROOT, projectFolder);
      const eslint = new ESLint({ cwd: pkgRoot });

      const fsResults = await eslint.lintText(
        [
          "import { mkdtempSync } from 'node:fs';",
          "import { tmpdir } from 'node:os';",
          "export const dir = mkdtempSync(tmpdir());",
          '',
        ].join('\n'),
        { filePath: join(pkgRoot, 'tests/__cross_pkg_gate_fixture__.ts') },
      );
      const fsRules = fsResults.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
      expect(fsRules, `${projectFolder} tests/** sync-fs exemption`).not.toContain(
        'n/no-sync',
      );

      const cpResults = await eslint.lintText(
        [
          "import { execSync } from 'node:child_process';",
          "export const out = execSync('echo hi');",
          '',
        ].join('\n'),
        { filePath: join(pkgRoot, 'tests/__cross_pkg_gate_cp_fixture__.ts') },
      );
      const cpRules = cpResults.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
      expect(
        cpRules,
        `${projectFolder} tests/** sync child_process ban`,
      ).toContain('no-restricted-imports');
    },
  );
});

describe('the core/provider import-boundary rules are wired via the same real eslint.config.js (issue #209)', () => {
  it('core (@excitedjs/dreamux) flags a static import of a builtin provider package as no-restricted-imports', async () => {
    const pkgRoot = join(REPO_ROOT, 'packages/dreamux');
    const eslint = new ESLint({ cwd: pkgRoot });
    const results = await eslint.lintText(
      [
        "import { createCodexAgentRuntimeProvider } from '@excitedjs/agent-runtime-codex';",
        'export const factory = createCodexAgentRuntimeProvider;',
        '',
      ].join('\n'),
      { filePath: join(pkgRoot, 'src/__core_boundary_fixture__.ts') },
    );
    const rules = results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
    expect(rules).toContain('no-restricted-imports');
  });

  it.each([
    ['@excitedjs/agent-runtime-codex', 'packages/agent-runtime/codex'],
    ['@excitedjs/agent-runtime-claude-code', 'packages/agent-runtime/claude-code'],
    ['@excitedjs/feishu-channel', 'packages/channel/feishu-channel'],
    ['@excitedjs/feishu-transport', 'packages/channel/feishu-transport'],
  ] as const)(
    '%s flags a static import of @excitedjs/dreamux core as no-restricted-imports',
    async (_name, projectFolder) => {
      const pkgRoot = join(REPO_ROOT, projectFolder);
      const eslint = new ESLint({ cwd: pkgRoot });
      const results = await eslint.lintText(
        [
          "import { something } from '@excitedjs/dreamux';",
          'export const reexported = something;',
          '',
        ].join('\n'),
        { filePath: join(pkgRoot, 'src/__provider_boundary_fixture__.ts') },
      );
      const rules = results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
      expect(rules, `${projectFolder} provider-import-boundary`).toContain(
        'no-restricted-imports',
      );
    },
  );
});
