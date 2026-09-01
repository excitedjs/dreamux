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
 *   2. Core never imports a provider implementation package for behavior.
 *   3. Core contains no provider-native config/CLI/event syntax (Codex TOML
 *      keys, Claude Code CLI flags, provider protocol event names).
 *   4. The generic MCP transport (`src/mcp/*.ts`) never branches on a tool
 *      name — it is a caller-bound catalog + a shared executor, nothing else.
 *
 * All scans strip comments first: a docstring that *explains* the boundary by
 * naming `builtin:feishu` in prose (e.g. `channel/external-channel-provider.ts`)
 * is not a violation, and a raw-text grep would false-positive on it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

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
    const idPattern = /'codex'|"codex"|'claude-code'|"claude-code"|'feishu'|"feishu"/;
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

  it('config.ts carve-out is a single fail-loud rejection, not a provider-id branch', () => {
    // Guards the carve-out itself: if `rejectTopLevelCodex` ever grows an
    // else-branch that does something DIFFERENT when the block is present vs
    // absent (as opposed to always erroring), that is a real provider-id
    // product branch and this narrower shape check must fail loud.
    const src = stripComments(
      readFileSync(join(coreSrc, 'config/config.ts'), 'utf8'),
    );
    const fnMatch = /function rejectTopLevelCodex\(([\s\S]*?)\n\}/.exec(src);
    expect(fnMatch, 'rejectTopLevelCodex function present').not.toBeNull();
    const body = fnMatch![1]!;
    // Exactly one early return (absence) and one throw (presence); no other
    // control flow that could diverge in behavior by branch.
    expect(body).toMatch(/if \(!\('codex' in raw\)\) return;/);
    expect(body).toMatch(/throw new Error/);
    expect(body.match(/\bif\s*\(/g)?.length ?? 0).toBe(1);
    expect(body).not.toMatch(/\belse\b/);
  });

  it('the builtin id -> package carve-out list is itself pinned', () => {
    // A new leak could otherwise hide by silently growing this exact map
    // instead of adding a new file to the allowance above. Pin its shape so a
    // fourth builtin id is a deliberate, reviewed change.
    const src = readFileSync(join(coreSrc, 'registry/builtins.ts'), 'utf8');
    expect(src).toContain("codex: '@excitedjs/agent-runtime-codex'");
    expect(src).toContain("'claude-code': '@excitedjs/agent-runtime-claude-code'");
    expect(src).toContain("feishu: '@excitedjs/feishu-channel'");
    // Sanity: exactly 3 builtins declared (kind-agnostic count), so a new
    // provider *type* (not just a re-export) shows up as a diff here.
    const specMatches = src.match(/\{ id: '[a-z-]+', kind: '[a-zA-Z]+' \}/g) ?? [];
    expect(specMatches).toHaveLength(3);
  });

  it('core does not import a provider implementation package outside the loader boundary', () => {
    // Complements package-boundary-guards' "core does not import builtin
    // provider packages" with the loader-internal boundary: even the loader
    // skeleton (registry/provider-loader.ts, agent-runtime/external-provider.ts,
    // channel/external-channel-provider.ts) resolves packages by NAME STRING
    // through `resolveBuiltinProviderPackage` / a `dynamic import()`, and must
    // never `import` one statically for its exports.
    const providerImport =
      /^import[^;]*from\s+['"]@excitedjs\/(agent-runtime-codex|agent-runtime-claude-code|feishu-channel|feishu-transport)/m;
    const offenders = allCoreFiles.filter((file) =>
      providerImport.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map(rel)).toEqual([]);
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
    // `assistant.message` / `tool.call` appear in
    // channel/conversation-projection.ts. They must be the neutral
    // `RuntimeActivity` kind literals dreamux-types declares, not a
    // provider-native event name Core hardcoded independently — this positive
    // assertion is what makes the absence check above trustworthy rather than
    // coincidental.
    const typesSrc = readFileSync(
      join(coreSrc, '..', '..', 'dreamux-types', 'src', 'agent-runtime.ts'),
      'utf8',
    );
    expect(typesSrc).toContain("kind: 'assistant.message'");
    expect(typesSrc).toContain("kind: 'tool.call'");
  });
});

describe('generic MCP transport has no tool-name branch', () => {
  const mcpFiles = ['mcp/server.ts', 'mcp/shim.ts', 'mcp/catalog.ts'].map((f) =>
    join(coreSrc, f),
  );

  it('none of the generic MCP transport files switch or string-compare on a tool name', () => {
    // A caller-bound catalog + a shared executor never needs to know a
    // specific tool's name; any `case 'toolName':` or `name === 'toolName'`
    // there would mean business logic leaked into the transport layer. The
    // transport DOES compare against protocol-level constants (call.name ===
    // '' for validation, etc.) — those are covered by the neutral-vocabulary
    // exclusion list below, not tool identities.
    const neutralComparisons = [
      "name === ''",
      "name.trim() === ''",
      "title === ''",
      "annotation === ''",
      "icon['src'] === ''",
      "icon['mimeType'] === ''",
      "size === ''",
      "message === ''",
      "version === ''",
    ];
    const toolNameBranch = /\bcase\s+'[a-z][a-zA-Z_.]*'\s*:|\bname\s*===\s*'[a-z][a-zA-Z_.]{2,}'/g;
    const offenders: string[] = [];
    for (const file of mcpFiles) {
      let clean = stripComments(readFileSync(file, 'utf8'));
      for (const neutral of neutralComparisons) {
        clean = clean.split(neutral).join('');
      }
      const matches = clean.match(toolNameBranch) ?? [];
      if (matches.length > 0) {
        offenders.push(`${rel(file)}: ${matches.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
