import type { AgentRuntimeSystemPrompt } from '@excitedjs/dreamux-types';

import type { AgentEntityIdentity } from '../agent-entity/types.js';

/**
 * What one Agent of a TeammateCollection is told about itself, in the order it
 * is told it.
 *
 * A Team-scoped Agent leads with the fact only its owner holds: which TeamMate
 * it is, and that what it outputs when its turn ends is what its TeamLeader
 * receives. The operation's own append follows — a workflow agent's return-value
 * contract — and the operator's identity has the last word. A dispatcher-scoped
 * TeamMate has no TeamLeader, so it is told none of it.
 */
export function teammateSystemPromptOptions(
  identity: AgentEntityIdentity,
  operationAppend: readonly string[] | undefined,
): { systemPrompt: AgentRuntimeSystemPrompt } | undefined {
  const append = [
    ...(identity.team_id !== null
      ? [
          `You are TeamMate ${JSON.stringify(identity.name)} of Dreamux Team ${JSON.stringify(identity.team_id)}. Your TeamLeader receives what you output when your turn ends.`,
        ]
      : []),
    ...(operationAppend ?? []),
    ...(identity.identity_prompt !== null ? [identity.identity_prompt] : []),
  ];
  return append.length === 0 ? undefined : { systemPrompt: { append } };
}
