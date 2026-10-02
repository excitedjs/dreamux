/**
 * The built-in Claude Code plugin, always loaded by Dreamux.
 *
 * Contributes the Claude Code Agent Runtime provider under the name
 * `claude-code`, which config addresses as `builtin:claude-code`. It
 * constructs the provider on package defaults: `AgentRuntimeProvider` has no
 * `ref`/`descriptor` member (Core owns registration identity in its registry,
 * never echoed back to the provider). The provider uses the configured binary
 * and constructs its resident sessions directly.
 */
import type { DreamuxPlugin } from '@excitedjs/dreamux-types';

import { createClaudeCodeAgentRuntimeProvider } from './provider.js';

/** The zero-argument plugin factory Dreamux's plugin loader calls. */
export default function claudeCodePlugin(): DreamuxPlugin {
  return {
    name: 'claude-code',
    contribute(host) {
      host.agentRuntimeProviders.contribute(
        'claude-code',
        createClaudeCodeAgentRuntimeProvider(),
      );
    },
  };
}
