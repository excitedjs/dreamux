export const TEAM_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The Team task was submitted successfully. Dreamux core will automatically push the Team completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const TEAMMATE_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The TeamMate task was submitted successfully. Dreamux core will automatically push the TeamMate completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const WORKFLOW_RUN_SUCCESS_REMINDER =
  'Reminder: The workflow runs in the background. When it finishes, Dreamux automatically pushes the terminal completion into the caller\'s current context. Unless the user explicitly asks for a status check, do not call or poll workflow_status or other status/read tools; wait for the system push. If there is no other work, the turn may end naturally.';

export function teamDispatchSuccessText(
  result: Record<string, unknown>,
): string | undefined {
  return hasSubmitted(result) ? TEAM_DISPATCH_SUCCESS_REMINDER : undefined;
}

export function teammateDispatchSuccessText(
  result: Record<string, unknown>,
): string | undefined {
  return hasSubmitted(result)
    ? TEAMMATE_DISPATCH_SUCCESS_REMINDER
    : undefined;
}

export function workflowRunSuccessText(
  result: Record<string, unknown>,
): string | undefined {
  const runId = result['run_id'];
  return typeof runId === 'string' && runId.length > 0
    ? WORKFLOW_RUN_SUCCESS_REMINDER
    : undefined;
}

function hasSubmitted(result: Record<string, unknown>): boolean {
  return result['status'] === 'submitted';
}
