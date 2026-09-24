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
 * `builtin:feishu` is the built-in channel ref. It resolves to the provider the
 * always-loaded Feishu plugin contributes (see
 * {@link ALWAYS_LOADED_PLUGIN_REFS}), so config loading resolves it through the
 * same registry path as every other provider and delegates provider-specific
 * config validation to the channel provider's `readConfig`.
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
};

/**
 * Thrown when a `builtin:` ref is neither shipped by Dreamux nor contributed by
 * a loaded plugin. Plugin-contributed providers are registered before this
 * lookup runs, so the usual cause is a provider whose plugin is no longer
 * listed in `plugins[]`.
 */
export class UnknownBuiltinProviderPackageError extends Error {
  constructor(readonly id: string) {
    super(
      `no loaded plugin contributes provider ${JSON.stringify(`builtin:${id}`)} ` +
        'and Dreamux does not ship it; list the plugin that provides it in plugins[]',
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
];

/**
 * Built-in plugin id -> the package whose default export is its factory.
 * Separate from BUILTIN_PROVIDER_PACKAGES: a plugin is not a provider.
 */
export const BUILTIN_PLUGIN_PACKAGES: Readonly<Record<string, string>> = {
  bootstrap: '@excitedjs/dreamux-plugin-bootstrap',
  feishu: '@excitedjs/feishu-channel',
};

/** Plugins loaded whether or not `plugins[]` lists them. */
export const ALWAYS_LOADED_PLUGIN_REFS: readonly string[] = ['builtin:feishu'];

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

/**
 * Register a provider addressed as `builtin:<id>`: the descriptor and its
 * implementation together. Used for plugin-contributed providers (and tests).
 */
export function registerBuiltinProvider(
  registry: ProviderRegistry,
  spec: BuiltinSpec,
  implementation: unknown,
): void {
  registry.register(builtinDescriptor(spec));
  registry.registerImplementation(spec.id, implementation);
}
