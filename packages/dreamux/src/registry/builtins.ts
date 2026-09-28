/**
 * Builtin provider descriptors for the provider registry.
 *
 * The registry validates refs and kind only. Capabilities are declared by the
 * provider implementations that core actually invokes.
 */

import { parseProviderRef } from './provider-ref.js';
import {
  type ProviderDescriptor,
  type ProviderImplementation,
  type ProviderKind,
  ProviderRegistry,
} from './registry.js';

/**
 * Canonical provider refs Dreamux ships. These live next to the builtin ids so
 * core modules can import the stable refs from the registry layer instead of a
 * config-module shim.
 *
 * All three resolve to the provider their always-loaded plugin contributes
 * (see {@link ALWAYS_LOADED_PLUGIN_REFS}), so config loading resolves them
 * through one registry and delegates provider-specific config validation to
 * the provider's own `readConfig`.
 */
export const BUILTIN_FEISHU_PROVIDER_REF = 'builtin:feishu';
export const BUILTIN_CODEX_PROVIDER_REF = 'builtin:codex';
export const BUILTIN_CLAUDE_CODE_PROVIDER_REF = 'builtin:claude-code';

/**
 * Thrown when a `builtin:` ref reaches the package loader unregistered: every
 * built-in ships as a plugin and registers descriptor + implementation
 * together from its own `contribute()` (see {@link ALWAYS_LOADED_PLUGIN_REFS}),
 * so this fires only for an id no loaded plugin contributes — typically a
 * provider whose plugin is no longer listed in `plugins[]`, or a typo.
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
 * Built-in plugin id -> the package whose default export is its factory. A
 * plugin is not a provider: this is what `loadPlugins` imports to construct
 * and `contribute()` each always-loaded plugin, not what a provider registers
 * under.
 */
export const BUILTIN_PLUGIN_PACKAGES: Readonly<Record<string, string>> = {
  bootstrap: '@excitedjs/dreamux-plugin-bootstrap',
  feishu: '@excitedjs/feishu-channel',
  codex: '@excitedjs/agent-runtime-codex',
  'claude-code': '@excitedjs/agent-runtime-claude-code',
};

/** Plugins loaded whether or not `plugins[]` lists them. */
export const ALWAYS_LOADED_PLUGIN_REFS: readonly string[] = [
  'builtin:feishu',
  'builtin:codex',
  'builtin:claude-code',
];

/** The two fields a plugin-contributed registration names: id and kind. */
interface BuiltinRegistration {
  id: string;
  kind: ProviderKind;
}

function builtinDescriptor(spec: BuiltinRegistration): ProviderDescriptor {
  return {
    id: spec.id,
    kind: spec.kind,
    ref: parseProviderRef(`builtin:${spec.id}`),
  };
}

/**
 * Register a provider addressed as `builtin:<id>`: the descriptor and its
 * implementation together. Used for plugin-contributed providers (and tests).
 */
export function registerBuiltinProvider(
  registry: ProviderRegistry,
  spec: BuiltinRegistration,
  implementation: ProviderImplementation,
): void {
  registry.register(builtinDescriptor(spec), implementation);
}
