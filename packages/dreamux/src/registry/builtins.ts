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
 * builtin modules can import them without depending on `config/config.ts`
 * (which would form an import cycle once config registers builtins through the
 * agent-runtime catalog). `config/config.ts` re-exports them for the
 * non-builtin callers that already import them from there.
 *
 * `builtin:feishu` is the built-in channel ref. It is intentionally NOT a
 * registry descriptor (the Feishu channel is not a registry provider), but its
 * ref string belongs here with the other builtin refs.
 */
export const BUILTIN_FEISHU_PROVIDER_REF = 'builtin:feishu';
export const BUILTIN_CODEX_PROVIDER_REF = 'builtin:codex';
export const BUILTIN_CLAUDE_CODE_PROVIDER_REF = 'builtin:claude-code';

/** The provider refs Dreamux ships and recognizes. */
export const BUILTIN_PROVIDERS: readonly BuiltinSpec[] = [
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
