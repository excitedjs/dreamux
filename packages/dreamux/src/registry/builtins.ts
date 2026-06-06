/**
 * Phase-1 builtin provider descriptors for issue #110.
 *
 * These register the bundled providers so that `builtin:feishu`,
 * `builtin:codex`, and `builtin:claude-code` resolve through the registry.
 *
 * `builtin:feishu` declares its channel capabilities here (#110 PR4): the
 * catalog is the single source of truth for what the Feishu channel provider
 * exposes, and the provider implementation
 * (`src/channel/feishu-provider.ts`) reads them back from this descriptor. The
 * capability `kind` values match `CHANNEL_CAPABILITY` in
 * `src/channel/provider.ts`; the channel-provider test asserts they stay in
 * sync. The agentRuntime builtins stay capability-less until their adapter PRs
 * (#110 PR5 for Codex, PR6 for Claude Code).
 *
 * The confirmed builtin set is recorded in
 * `.agents/decisions/provider-references-and-capability-registry.md` and
 * `.agents/decisions/agent-runtime-provider.md`.
 */

import { parseProviderRef } from './provider-ref.js';
import {
  CapabilityRegistry,
  capabilityId,
  type CapabilityDescriptor,
  type ProviderDescriptor,
  type ProviderKind,
} from './registry.js';

interface BuiltinSpec {
  id: string;
  kind: ProviderKind;
  /** Capability `kind`s this builtin exposes; ids are namespaced by provider. */
  capabilities?: readonly string[];
}

/** The providers Dreamux ships and can run in phase 1. */
export const BUILTIN_PROVIDERS: readonly BuiltinSpec[] = [
  {
    id: 'feishu',
    kind: 'channel',
    capabilities: ['mcpServer', 'reply', 'react', 'access'],
  },
  { id: 'codex', kind: 'agentRuntime' },
  { id: 'claude-code', kind: 'agentRuntime' },
];

function builtinDescriptor(spec: BuiltinSpec): ProviderDescriptor {
  const capabilities: CapabilityDescriptor[] = (spec.capabilities ?? []).map(
    (kind) => ({ id: capabilityId(spec.id, kind), kind }),
  );
  return {
    id: spec.id,
    kind: spec.kind,
    ref: parseProviderRef(`builtin:${spec.id}`),
    capabilities,
  };
}

/**
 * Build a registry pre-populated with the phase-1 builtin providers. This does
 * not wire into the server startup path; callers opt in explicitly.
 */
export function createBuiltinRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const spec of BUILTIN_PROVIDERS) {
    registry.register(builtinDescriptor(spec));
  }
  return registry;
}
