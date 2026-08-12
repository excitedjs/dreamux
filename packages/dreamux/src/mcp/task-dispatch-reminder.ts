export const TEAM_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The Team task was submitted successfully. Dreamux core will automatically push the Team completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const TEAMMATE_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The TeamMate task was submitted successfully. Dreamux core will automatically push the TeamMate completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const WORKFLOW_RUN_SUCCESS_REMINDER =
  'Reminder: The workflow runs in the background. When it finishes, Dreamux automatically pushes the terminal completion into the caller\'s current context. Unless the user explicitly asks for a status check, do not call or poll workflow_status or other status/read tools; wait for the system push. If there is no other work, the turn may end naturally.';

export function appendTaskDispatchSuccessReminder(
  text: string,
  result: unknown,
  method: string,
  taskDispatchReminder: string,
): string {
  const reminder = taskDispatchSuccessReminder(
    method,
    result,
    taskDispatchReminder,
  );
  return reminder === null ? text : `${text}\n\n${reminder}`;
}

export function appendStructuredTaskDispatchSuccessReminder(
  result: unknown,
  method: string,
  taskDispatchReminder: string,
): unknown {
  const reminder = taskDispatchSuccessReminder(
    method,
    result,
    taskDispatchReminder,
  );
  return reminder === null
    ? result
    : {
        ...(result as Record<string, unknown>),
        reminder,
      };
}

function taskDispatchSuccessReminder(
  method: string,
  result: unknown,
  taskDispatchReminder: string,
): string | null {
  if (method === 'workflow.run' && hasNonEmptyRunId(result)) {
    return WORKFLOW_RUN_SUCCESS_REMINDER;
  }
  return hasSubmittedTurn(result) ? taskDispatchReminder : null;
}

function hasNonEmptyRunId(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  const runId = (result as Record<string, unknown>)['run_id'];
  return typeof runId === 'string' && runId.trim() !== '';
}

function hasSubmittedTurn(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  const turn = (result as Record<string, unknown>)['turn'];
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) {
    return false;
  }
  return (turn as Record<string, unknown>)['status'] === 'submitted';
}
