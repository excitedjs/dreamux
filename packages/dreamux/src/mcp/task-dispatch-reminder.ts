export const TEAM_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The Team task was submitted successfully. Dreamux core will automatically push the Team completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export const TEAMMATE_DISPATCH_SUCCESS_REMINDER =
  'Reminder: The TeamMate task was submitted successfully. Dreamux core will automatically push the TeamMate completion back when it finishes. Do not poll last or other read tools for completion; if you have no other work, you may end this turn naturally.';

export function appendTaskDispatchSuccessReminder(
  text: string,
  result: unknown,
  reminder: string,
): string {
  return hasSubmittedTurn(result)
    ? `${text}\n\n${reminder}`
    : text;
}

export function appendStructuredTaskDispatchSuccessReminder(
  result: unknown,
  reminder: string,
): unknown {
  return hasSubmittedTurn(result)
    ? {
        ...(result as Record<string, unknown>),
        reminder,
      }
    : result;
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
