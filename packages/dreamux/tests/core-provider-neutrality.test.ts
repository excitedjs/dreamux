/**
 * Architecture guard: Core stays behind the neutral `AgentRuntimeProvider` /
 * `ChannelProvider` seam (minimize-provider-boundaries task design record, `.agents/tasks/architecture/minimize-provider-boundaries/technical-design/final.md` §1-2).
 *
 * These are the "polymorphism" invariants a text-shape scan can legitimately
 * enforce (absence IS the contract, per the repo's CLAUDE.md layering rule):
 *
 *   1. Core (`packages/dreamux/src`) never branches product behavior on a
 *      concrete Agent Runtime provider id (`codex`, `claude-code`) or Channel
 *      provider id (`feishu`) — the one legitimate place that names those ids
 *      is the builtin-registry composition root, and that carve-out is asserted
 *      explicitly here so a new leak elsewhere cannot hide behind "it's just
 *      like builtins.ts".
 *   2. Core contains no provider-native config/CLI/event syntax (Codex TOML
 *      keys, Claude Code CLI flags, provider protocol event names).
 *
 * All scans strip comments first: a docstring that *explains* the boundary by
 * naming `builtin:feishu` in prose (e.g. `channel/external-channel-provider.ts`)
 * is not a violation, and a raw-text grep would false-positive on it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect, expectTypeOf } from 'vitest';

import type { RuntimeActivity } from '@excitedjs/dreamux-types';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = join(here, '..', 'src');

function walkTs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip `//` and `/* *\/` comments so prose mentions never trip a code-shape scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function rel(file: string): string {
  return relative(join(coreSrc, '..'), file);
}

const allCoreFiles = walkTs(coreSrc);

describe('core provider-id / channel-id neutrality', () => {
  it('the only files naming a concrete builtin provider id are the composition root', () => {
    // `codex`, `claude-code`, and `feishu` are the three builtin ids. The
    // registry composition root is the sole legitimate place a literal id may
    // select behavior (it IS the id -> package mapping). `config/config.ts`
    // also matches because it fail-loud rejects the deleted top-level `codex`
    // TOML block by key name — a single unconditional rejection, not a branch
    // that changes behavior BY provider id — so it is asserted as a second,
    // narrow, explicitly-named carve-out rather than silently widening the
    // registry allowance.
    const idPattern =
      /'codex'|"codex"|'claude-code'|"claude-code"|'feishu'|"feishu"/;
    const offenders = allCoreFiles.filter((file) =>
      idPattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    const allowedCarveOuts = new Set([
      'src/registry/builtins.ts',
      'src/config/config.ts',
    ]);
    const offenderPaths = offenders.map((f) => rel(f)).sort();
    expect(offenderPaths).toEqual([...allowedCarveOuts].sort());
  });

  it('the only file naming a composite `builtin:<id>` ref literal is the composition root', () => {
    // The bare-id scan above requires the quote adjacent to the id
    // (`'codex'`), so a composite literal like `'builtin:feishu'` would not
    // trip it even though comparing against it IS the same class of
    // provider-id product branch the cell targets (e.g. `if (ref.raw ===
    // 'builtin:feishu')`). Scan for the composite form separately so that
    // bypass vector is closed too.
    const compositePattern = /['"]builtin:(codex|claude-code|feishu)['"]/;
    const offenders = allCoreFiles.filter((file) =>
      compositePattern.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(rel)).toEqual(['src/registry/builtins.ts']);
  });

  it('core contains no provider-native config/CLI/event syntax', () => {
    // Tokens unambiguous to one provider's own wire/CLI surface. Deliberately
    // excludes generic flags dreamux's own CLI could legitimately use
    // (--model, --resume, --verbose, --print) so this stays a neutrality
    // guard, not a "no CLI flags" ban.
    const providerNativeTokens = [
      'sandbox_mode',
      'approval_policy',
      'model_reasoning_effort',
      'mcp_servers',
      'stream-json',
      '--dangerously-skip-permissions',
      '--permission-mode',
      '--append-system-prompt',
      '--mcp-config',
    ];
    const offenders: string[] = [];
    for (const file of allCoreFiles) {
      const clean = stripComments(readFileSync(file, 'utf8'));
      for (const token of providerNativeTokens) {
        if (clean.includes(token)) {
          offenders.push(`${rel(file)}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the neutral RuntimeActivity kinds used in Core are the dreamux-types contract, not provider syntax', () => {
    // The kinds Core switches on must be the neutral RuntimeActivity literals
    // dreamux-types declares. This positive check makes the absence check
    // above trustworthy. It is type-level, enforced by typecheck:tests.
    expectTypeOf<
      Extract<RuntimeActivity, { kind: 'assistant.message' }>['kind']
    >().toEqualTypeOf<'assistant.message'>();
    expectTypeOf<
      Extract<RuntimeActivity, { kind: 'tool.call' }>['kind']
    >().toEqualTypeOf<'tool.call'>();
  });
});
