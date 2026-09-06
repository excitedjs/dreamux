import type { AgentRuntimeSystemPrompt } from '@excitedjs/dreamux-types';

import type { AgentEntityIdentity } from '../agent-entity/types.js';

/**
 * What one Agent of a TeammateCollection is told about itself, in the order it
 * is told it.
 *
 * A Team-scoped Agent leads with the fact only its owner holds: which TeamMate
 * of which Team it is. An ordinary TeamMate is also told that what it outputs
 * when its turn ends is what its TeamLeader receives; a workflow agent is not,
 * because its output is consumed by the workflow script and the operation's
 * own append states that contract — a second, competing statement about where
 * the output goes would only distract it from returning the requested value.
 * The operation's append follows, and the operator's identity has the last
 * word. A dispatcher-scoped TeamMate has no TeamLeader, so it is told none of it.
 */
export function teammateSystemPromptOptions(
  identity: AgentEntityIdentity,
  operationAppend: readonly string[] | undefined,
): { systemPrompt: AgentRuntimeSystemPrompt } | undefined {
  const membership =
    identity.team_id === null
      ? []
      : [
          `You are TeamMate ${JSON.stringify(identity.name)} of Dreamux Team ${JSON.stringify(identity.team_id)}.` +
            (operationAppend === undefined || operationAppend.length === 0
              ? ' Your TeamLeader receives what you output when your turn ends.'
              : ''),
        ];
  const append = [
    ...membership,
    ...(operationAppend ?? []),
    ...(identity.identity_prompt !== null ? [identity.identity_prompt] : []),
  ];
  return append.length === 0 ? undefined : { systemPrompt: { append } };
}
