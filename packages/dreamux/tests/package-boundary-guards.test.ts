/**
 * Epic #209 package-boundary validation guards (decision record
 * `.agents/decisions/npm-package-split-and-channel-targets.md` §Validation
 * Guards). These are repo-wide regression catchers for package-split invariants
 * that are otherwise only "currently true" by inspection:
 *
 * - the Feishu/Lark SDK stays owned by exactly one package
 *   (`@excitedjs/feishu-transport`);
 * - a default `@excitedjs/dreamux` install still bundles the built-in provider
 *   packages (the runtime + channel builtins) as dependencies;
 * - provider/type packages never depend on `@excitedjs/dreamux` core.
 *
 * The per-package `import-boundary.test.ts` files already guard each provider's
 * own `src/` (no `@excitedjs/dreamux` import, no relative escape, and — for the
 * Feishu channel — no direct SDK import). These guards add the reciprocal,
 * repo-wide assertions: the SDK has a single owner across ALL packages, and the
 * package *manifests* (not just source imports) keep the dependency direction.
 *
 * They read `rush.json` + manifests and scan package `src/` on disk rather than
 * importing, so a boundary regression fails loud at the manifest/import layer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// packages/dreamux/tests -> repo root
const repoRoot = join(here, '..', '..', '..');

interface RushProject {
  packageName: string;
  projectFolder: string;
}

/**
 * Anchor the guards to rush's canonical project list so a newly-added package is
 * scanned automatically rather than silently escaping the guard. rush.json is
 * JSONC (comments + trailing commas), so pair the fields with a tolerant regex
 * instead of JSON.parse.
 */
function rushProjects(): RushProject[] {
  const raw = readFileSync(join(repoRoot, 'rush.json'), 'utf8');
  const re =
    /"packageName":\s*"([^"]+)"[\s\S]*?"projectFolder":\s*"([^"]+)"/g;
  const out: RushProject[] = [];
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out.push({ packageName: m[1]!, projectFolder: m[2]! });
  }
  return out;
}

function readManifest(projectFolder: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(repoRoot, projectFolder, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

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

const LARK_SDK_IMPORT = /from\s+['"]@larksuiteoapi\//;
const CORE_PROVIDER_PACKAGE_IMPORT =
  /from\s+['"]@excitedjs\/(?:agent-runtime-codex|agent-runtime-claude-code|feishu-channel|feishu-transport)(?:['"/]|$)|import\s*\(\s*['"]@excitedjs\/(?:agent-runtime-codex|agent-runtime-claude-code|feishu-channel|feishu-transport)(?:['"/]|$)/;
const CORE_PROVIDER_FACTORY_CALL =
  /\b(?:createCodexAgentRuntimeProvider|createClaudeCodeAgentRuntimeProvider|createFeishuChannelProvider)\s*\(|\bnew\s+(?:CodexRuntime|ClaudeCodeRuntime|FeishuChannelSession)\b/;
const projects = rushProjects();

describe('epic #209 package-boundary guards', () => {
  it('discovers the rush project set (sanity)', () => {
    // If this drops to a stub, the guards below would scan nothing — keep it
    // honest by asserting the real monorepo shape is present.
    const names = projects.map((p) => p.packageName);
    expect(names).toContain('@excitedjs/dreamux');
    expect(names).toContain('@excitedjs/feishu-transport');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('the Feishu/Lark SDK is imported by exactly one package (@excitedjs/feishu-transport)', () => {
    const owners = new Set<string>();
    for (const project of projects) {
      const files = walkTs(join(repoRoot, project.projectFolder, 'src'));
      const importsSdk = files.some((file) =>
        LARK_SDK_IMPORT.test(readFileSync(file, 'utf8')),
      );
      if (importsSdk) owners.add(project.packageName);
    }
    expect([...owners]).toEqual(['@excitedjs/feishu-transport']);
  });

  it('a default @excitedjs/dreamux install bundles the built-in provider packages', () => {
    const dreamux = projects.find((p) => p.packageName === '@excitedjs/dreamux');
    expect(dreamux).toBeDefined();
    const deps = (readManifest(dreamux!.projectFolder).dependencies ??
      {}) as Record<string, string>;
    // The built-in runtime + channel packages must ship as default dependencies
    // so an out-of-the-box install retains builtin:codex / builtin:claude-code /
    // builtin:feishu (issue #209 acceptance: "a default install still includes
    // the builtin runtime packages").
    for (const builtin of [
      '@excitedjs/agent-runtime-codex',
      '@excitedjs/agent-runtime-claude-code',
      '@excitedjs/feishu-channel',
    ]) {
      expect(deps).toHaveProperty(builtin);
    }
  });

  it('provider and type packages never depend on @excitedjs/dreamux core', () => {
    const providerPackages = [
      '@excitedjs/dreamux-types',
      '@excitedjs/feishu-transport',
      '@excitedjs/feishu-channel',
      '@excitedjs/agent-runtime-codex',
      '@excitedjs/agent-runtime-claude-code',
    ];
    for (const name of providerPackages) {
      const project = projects.find((p) => p.packageName === name);
      expect(project, `${name} present in rush.json`).toBeDefined();
      const manifest = readManifest(project!.projectFolder);
      for (const field of [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
      ] as const) {
        const block = (manifest[field] ?? {}) as Record<string, string>;
        expect(
          Object.prototype.hasOwnProperty.call(block, '@excitedjs/dreamux'),
          `${name} must not list @excitedjs/dreamux in ${field}`,
        ).toBe(false);
      }
    }
  });

  it('core source does not import built-in provider implementation packages', () => {
    const coreSrc = join(repoRoot, 'packages/dreamux/src');
    const offenders = walkTs(coreSrc).filter((file) =>
      CORE_PROVIDER_PACKAGE_IMPORT.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders.map((file) => file.slice(repoRoot.length + 1)),
    ).toEqual([]);
  });

  it('core source does not call provider-specific factories or classes directly', () => {
    const coreSrc = join(repoRoot, 'packages/dreamux/src');
    const offenders = walkTs(coreSrc).filter((file) =>
      CORE_PROVIDER_FACTORY_CALL.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders.map((file) => file.slice(repoRoot.length + 1)),
    ).toEqual([]);
  });

  it('core has no provider-specific runtime/channel adapter source tree', () => {
    for (const removedPath of [
      'packages/dreamux/src/agent-runtime/builtin',
      'packages/dreamux/src/channel/feishu',
      'packages/dreamux/src/channel/feishu-channel.ts',
      'packages/dreamux/src/channel/feishu-mcp-surface.ts',
      'packages/dreamux/src/channel/bot.ts',
    ]) {
      expect(existsSync(join(repoRoot, removedPath)), removedPath).toBe(false);
    }
  });
});
