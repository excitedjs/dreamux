/**
 * Phase-1 builtin provider descriptors for issue #110.
 *
 * These register the bundled providers so that `builtin:feishu`,
 * `builtin:codex`, and `builtin:claude-code` resolve through the registry. They
 * are intentionally skeletal: each declares only its id and kind. Executable
 * capabilities (channel MCP + reply, runtime delivery, etc.) are attached by the
 * dedicated provider PRs (#110 PR4 for Feishu, PR5 for Codex, PR6 for Claude
 * Code); this PR does not implement provider behavior.
 *
 * The confirmed builtin set is recorded in
 * `.agents/decisions/provider-references-and-capability-registry.md` and
 * `.agents/decisions/agent-runtime-provider.md`.
 */

import { parseProviderRef } from './provider-ref.js';
import {
  CapabilityRegistry,
  type ProviderDescriptor,
  type ProviderKind,
} from './registry.js';

interface BuiltinSpec {
  id: string;
  kind: ProviderKind;
}

/** The providers Dreamux ships and can run in phase 1. */
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
    capabilities: [],
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
