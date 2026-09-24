import type { TeammateService } from '../teammate-service/index.js';
import { toSubmissionResult } from '../teammate-service/turn-recording.js';
import { AGENT_TASK_SOURCE } from '../submission-sources.js';
import { resolveTeamLeaderCompletionDelivery } from './completion-targets.js';
import type { TeamServiceDeps } from './types.js';

/**
 * Submit a new Team's creation prompt to its freshly built leader. Anything
 * short of `submitted` throws, so the creation that asked for it is abandoned.
 */
export async function submitInitialLeaderPrompt(input: {
  deps: TeamServiceDeps;
  leader: TeammateService;
  prompt: string;
}): Promise<void> {
  const { deps, leader } = input;
  const delivery = await resolveTeamLeaderCompletionDelivery({
    initiator: deps.leaderCompletionInitiator,
    completionDelivery: deps.completionDelivery,
  });
  const submission = toSubmissionResult(
    await leader.submitInput({
      source: AGENT_TASK_SOURCE,
      text: input.prompt,
      ...(delivery !== null ? { deliverCompletion: delivery } : {}),
    }),
  );
  if (submission.status !== 'submitted') {
    if (
      (submission.status === 'failed' || submission.status === 'ambiguous') &&
      submission.error !== undefined
    ) {
      throw new Error(submission.error);
    }
    throw new Error(
      `initial TeamLeader prompt was not admitted (${submission.status})`,
    );
  }
}
