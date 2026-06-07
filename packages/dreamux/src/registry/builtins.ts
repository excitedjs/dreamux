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

/** The provider refs Dreamux ships and recognizes. */
export const BUILTIN_PROVIDERS: readonly BuiltinSpec[] = [
  { id: 'feishu', kind: 'channel' },
  { id: 'codex', kind: 'agentRuntime' },
  { id: 'claude-code', kind: 'agentRuntime' },
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

let defaultProviderRegistry: ProviderRegistry | null = null;

/**
 * Shared builtin registry for config parsing paths that do not yet have a
 * server-owned registry to inject.
 */
export function defaultBuiltinProviderRegistry(): ProviderRegistry {
  if (defaultProviderRegistry === null) {
    defaultProviderRegistry = buildBuiltinProviderRegistry();
  }
  return defaultProviderRegistry;
}
