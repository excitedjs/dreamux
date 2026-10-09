/**
 * The built-in Codex plugin, always loaded by Dreamux.
 *
 * Contributes the Codex Agent Runtime provider under the name `codex`, which
 * config addresses as `builtin:codex`. It constructs the provider on package
 * defaults: `AgentRuntimeProvider` has no `ref`/`descriptor` member (Core owns
 * registration identity in its registry, never echoed back to the provider),
 * and the provider constructs its process/client directly. This plugin uses
 * the provider's default restart backoff values.
 */
import type { DreamuxPlugin } from '@excitedjs/dreamux-types';

import { createCodexAgentRuntimeProvider } from './provider.js';

/** The zero-argument plugin factory Dreamux's plugin loader calls. */
export default function codexPlugin(): DreamuxPlugin {
  return {
    name: 'codex',
    contribute(host) {
      host.agentRuntimeProviders.contribute(
        'codex',
        createCodexAgentRuntimeProvider(),
      );
    },
  };
}
