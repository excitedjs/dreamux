import type { AgentRuntimeSystemPrompt } from '@excitedjs/dreamux-types';

import type { AgentEntityIdentity } from './identity.js';

/**
 * What one Agent of a TeammateCollection is told about itself, in the order it
 * is told it.
 *
 * A Team-scoped Agent leads with its Team membership. Ordinary members of both
 * collections receive their actual owner address and communication contract;
 * a Workflow agent does not,
 * because its output is consumed by the workflow script and the operation's
 * own append states that contract — a second, competing statement about where
 * the output goes would only distract it from returning the requested value.
 * The operation's append follows, then plugin instructions (the
 * `teammateLaunch` hook's draft) — same relative order as
 * `team/leader.ts`'s `teamLeaderSystemPrompt` — and the operator's identity
 * has the last word, as the most specific statement of who this TeamMate is.
 */
export function teammateSystemPromptOptions(
  identity: AgentEntityIdentity,
  operationAppend: readonly string[] | undefined,
  pluginInstructions: readonly string[],
  owner?: { name: string; role: string },
): { systemPrompt: AgentRuntimeSystemPrompt } | undefined {
  const membership =
    identity.team_id === null
      ? owner === undefined
        ? []
        : [`You are Dreamux TeamMate ${JSON.stringify(identity.name)}.`]
      : [
          `You are TeamMate ${JSON.stringify(identity.name)} of Dreamux Team ${JSON.stringify(identity.team_id)}.`,
        ];
  const append = [
    ...membership,
    ...(owner === undefined
      ? []
      : [
          `Your owner is the ${owner.role} ${JSON.stringify(owner.name)}. You can use teammate.send to pass a message to your owner or a peer in your collection, and teammate.list to list your owner and peers. Your normally completed and failed turn results are automatically reported to your owner when its runtime is available.`,
        ]),
    ...(operationAppend ?? []),
    ...pluginInstructions,
    ...(identity.identity_prompt !== null ? [identity.identity_prompt] : []),
  ];
  return append.length === 0 ? undefined : { systemPrompt: { append } };
}
