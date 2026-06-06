/**
 * Phase-1 builtin provider descriptors for issue #110.
 *
 * These register the bundled providers so that `builtin:feishu`,
 * `builtin:codex`, and `builtin:claude-code` resolve through the registry. They
 * started skeletal: PR #110 PR5 now attaches the Codex runtime capabilities
 * implemented by `builtin:codex`, while Feishu and Claude Code capabilities
 * remain for their dedicated provider PRs.
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
  capabilities?: readonly CapabilityDescriptor[];
}

/** The providers Dreamux ships and can run in phase 1. */
export const BUILTIN_PROVIDERS: readonly BuiltinSpec[] = [
  { id: 'feishu', kind: 'channel' },
  {
    id: 'codex',
    kind: 'agentRuntime',
    capabilities: [
      { id: capabilityId('codex', 'lifecycle'), kind: 'agentRuntime.lifecycle' },
      {
        id: capabilityId('codex', 'mcpInjection'),
        kind: 'agentRuntime.mcpInjection',
      },
      {
        id: capabilityId('codex', 'inboundTurn'),
        kind: 'agentRuntime.inboundTurn',
      },
      {
        id: capabilityId('codex', 'teammateCompletion.codexInboxTurn'),
        kind: 'agentRuntime.teammateCompletionDelivery',
      },
    ],
  },
  { id: 'claude-code', kind: 'agentRuntime' },
];

function builtinDescriptor(spec: BuiltinSpec): ProviderDescriptor {
  return {
    id: spec.id,
    kind: spec.kind,
    ref: parseProviderRef(`builtin:${spec.id}`),
    capabilities: [...(spec.capabilities ?? [])],
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
