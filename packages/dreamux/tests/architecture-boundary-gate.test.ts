/**
 * Executable contract for the architecture neutrality lint gate (issue #209
 * polymorphism boundary), the harness layer of the "Architecture Discipline"
 * rule in the repo CLAUDE.md.
 *
 * These tests run the REAL on-disk ESLint flat configs of the affected packages
 * against in-memory fixtures, so the boundary is pinned as a hard lint error,
 * not just asserted in prose:
 *   - core (@excitedjs/dreamux) must not statically import a provider package;
 *   - a provider package must not import @excitedjs/dreamux core (but may import
 *     the neutral contract and shared utils);
 *   - the neutral runtime contract (dreamux-types agent-runtime.ts / turn.ts)
 *     must not NAME a provider-specific field, scoped to those files, and that
 *     guard composes with — does not replace — the shared sync-IO backstop.
 *
 * Fixtures use file *paths* under each package's `src/` (the files need not
 * exist on disk) so the flat-config `files` globs select the right block, and
 * the banned constructs live only inside `lintText` strings so this test file
 * stays clean under the gate. Each package's cwd resolves that package's real
 * `eslint.config.js`, so this exercises the shipped configs end to end.
 */

import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tests/ -> @excitedjs/dreamux (core) package root.
const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Sibling package roots in the monorepo layout.
const CODEX_ROOT = join(CORE_ROOT, '..', 'agent-runtime', 'codex');
const TYPES_ROOT = join(CORE_ROOT, '..', 'dreamux-types');

function lint(
  packageRoot: string,
  filePath: string,
  code: string,
): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: packageRoot });
  return eslint.lintText(code, { filePath: join(packageRoot, filePath) });
}

function ruleIds(results: ESLint.LintResult[]): string[] {
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ''));
}

describe('architecture neutrality lint gate (issue #209)', () => {
  it('flags core statically importing a provider package', async () => {
    const results = await lint(
      CORE_ROOT,
      'src/__boundary_fixture__.ts',
      [
        "import { createCodexAgentRuntimeProvider } from '@excitedjs/agent-runtime-codex';",
        'export const make = createCodexAgentRuntimeProvider;',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-imports');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('flags core importing the Feishu transport/channel packages', async () => {
    const results = await lint(
      CORE_ROOT,
      'src/__boundary_feishu__.ts',
      [
        "import { something } from '@excitedjs/feishu-transport';",
        'export const x = something;',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-imports');
  });

  it('lets core import the neutral contract (dreamux-types)', async () => {
    const results = await lint(
      CORE_ROOT,
      'src/__boundary_types_ok__.ts',
      [
        "import type { AgentRuntime } from '@excitedjs/dreamux-types';",
        'export type R = AgentRuntime;',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('no-restricted-imports');
  });

  it('flags a provider package importing core', async () => {
    const results = await lint(
      CODEX_ROOT,
      'src/__boundary_core__.ts',
      [
        "import { Server } from '@excitedjs/dreamux';",
        'export const s = Server;',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-imports');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('lets a provider import the neutral contract and shared utils', async () => {
    const results = await lint(
      CODEX_ROOT,
      'src/__boundary_provider_ok__.ts',
      [
        "import type { AgentRuntime } from '@excitedjs/dreamux-types';",
        "import { something } from '@excitedjs/dreamux-utils';",
        'export const x: AgentRuntime | undefined = something;',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('no-restricted-imports');
  });

  it('flags a provider-specific field declared in the neutral contract', async () => {
    const results = await lint(
      TYPES_ROOT,
      'src/agent-runtime.ts',
      [
        'export interface BadContract {',
        '  chat_id: string;',
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).toContain('no-restricted-syntax');
    expect(results[0]?.errorCount ?? 0).toBeGreaterThan(0);
  });

  it('does not flag a neutral snake_case field in the contract', async () => {
    const results = await lint(
      TYPES_ROOT,
      'src/turn.ts',
      [
        'export interface OkContract {',
        '  runtime_id: string;',
        '  last_error: string | null;',
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('no-restricted-syntax');
  });

  it('scopes the contract-field ban to the contract files only', async () => {
    // The same provider field name in a non-contract source file is allowed:
    // core has many legitimate uses; the ban is scoped to the neutral contract.
    const results = await lint(
      TYPES_ROOT,
      'src/__not_a_contract__.ts',
      [
        'export interface IncidentalType {',
        '  chat_id: string;',
        '}',
        '',
      ].join('\n'),
    );
    expect(ruleIds(results)).not.toContain('no-restricted-syntax');
  });

  it('preserves the shared sync-destructure backstop on the contract files', async () => {
    // The contract-field block re-declares no-restricted-syntax; assert it
    // COMPOSES with the shared sync gate rather than replacing it.
    const results = await lint(
      TYPES_ROOT,
      'src/agent-runtime.ts',
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
  });
});
