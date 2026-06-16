/**
 * Builtin provider descriptors for the provider registry.
 *
 * The registry validates refs and kind only. Capabilities are declared by the
 * provider implementations that core actually invokes.
 */

import { parseProviderRef } from './provider-ref.js';
import {
  type ProviderDescriptor,
  type ProviderKind,
  ProviderRegistry,
} from './registry.js';

interface BuiltinSpec {
  id: string;
  kind: ProviderKind;
}

/**
 * Canonical provider refs Dreamux ships. These live next to the builtin ids so
 * core modules can import the stable refs from the registry layer instead of a
 * config-module shim.
 *
 * `builtin:feishu` is the built-in channel ref. Since the multi-channel config
 * slice (#209) it IS a registry descriptor (kind `channel`), so config loading
 * resolves it through the same provider path as runtimes and delegates
 * provider-specific config validation to the channel provider's `readConfig`.
 */
export const BUILTIN_FEISHU_PROVIDER_REF = 'builtin:feishu';
export const BUILTIN_CODEX_PROVIDER_REF = 'builtin:codex';
export const BUILTIN_CLAUDE_CODE_PROVIDER_REF = 'builtin:claude-code';

/**
 * Built-in provider id -> npm package the generic loader imports for it
 * (issue #209). The built-in refs stay stable; Dreamux resolves them to the
 * packages that ship the built-in providers so `builtin:*` and `npm:*` refs use
 * the same loading path. Each package version-bumps independently behind the
 * stable ref.
 */
export const BUILTIN_PROVIDER_PACKAGES: Readonly<Record<string, string>> = {
  codex: '@excitedjs/agent-runtime-codex',
  'claude-code': '@excitedjs/agent-runtime-claude-code',
  feishu: '@excitedjs/feishu-channel',
};

/** Thrown when a `builtin:` ref has no known package mapping. */
export class UnknownBuiltinProviderPackageError extends Error {
  constructor(readonly id: string) {
    super(
      `builtin provider ${JSON.stringify(`builtin:${id}`)} has no known ` +
        'package mapping',
    );
    this.name = 'UnknownBuiltinProviderPackageError';
  }
}

/**
 * Resolve a built-in provider id to the npm package that ships it. Throws
 * {@link UnknownBuiltinProviderPackageError} for an unmapped id so the loader can
 * fail loud with a named ref rather than a raw module-loader error.
 */
export function resolveBuiltinProviderPackage(id: string): string {
  const packageName = BUILTIN_PROVIDER_PACKAGES[id];
  if (packageName === undefined) {
    throw new UnknownBuiltinProviderPackageError(id);
  }
  return packageName;
}

/** The provider refs Dreamux ships and recognizes. */
export const BUILTIN_PROVIDERS: readonly BuiltinSpec[] = [
  { id: 'codex', kind: 'agentRuntime' },
  { id: 'claude-code', kind: 'agentRuntime' },
  { id: 'feishu', kind: 'channel' },
];

function builtinDescriptor(spec: BuiltinSpec): ProviderDescriptor {
  return {
    id: spec.id,
    kind: spec.kind,
    ref: parseProviderRef(`builtin:${spec.id}`),
  };
}

function buildBuiltinProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const spec of BUILTIN_PROVIDERS) {
    registry.register(builtinDescriptor(spec));
  }
  return registry;
}

/**
 * Build a registry pre-populated with the builtin provider descriptors.
 */
export function createBuiltinProviderRegistry(): ProviderRegistry {
  return buildBuiltinProviderRegistry();
}
