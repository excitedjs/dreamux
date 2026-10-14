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
          `Your owner is the ${owner.role} ${JSON.stringify(owner.name)}. You can use send to share useful findings with your owner or coordinate with peers while working. Use list when you need peer names. Sending a message does not end your turn. Messages identify their sender. A send receipt confirms admission, not a response or completion; replies require an explicit send. Dreamux automatically reports each observed normally completed or failed native turn to your owner, including background continuations. A turn result does not prove the assigned goal is finished. Automatic reports require an available owner runtime, do not wake an unavailable owner, and do not add reports for interrupted background work or work the owner stopped. Untagged task input does not identify its sender.`,
        ]),
    ...(operationAppend ?? []),
    ...pluginInstructions,
    ...(identity.identity_prompt !== null ? [identity.identity_prompt] : []),
  ];
  return append.length === 0 ? undefined : { systemPrompt: { append } };
}
