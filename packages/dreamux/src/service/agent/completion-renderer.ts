import type { TeammateRole } from '@excitedjs/dreamux-types';

import { resolveCompletionBody } from '@excitedjs/dreamux-utils';

import type { PreparedCompletionFact } from '../completion-router/index.js';

/**
 * The submission seam carries text only, so a pushed completion reaches the
 * model as an ordinary user turn distinguished only by its envelope tag; the
 * body therefore says in words that the host sent it.
 */
const NOTIFICATION_SENTENCE =
  'This is an automated notification from Dreamux, not a message from the user.';

/** Render any routed completion through the shared inline/spill pipeline. */
export async function buildCompletionTurnText(
  completion: PreparedCompletionFact,
  spillDir: string,
): Promise<string> {
  const head = `${completionStatusLine(completion)} ${NOTIFICATION_SENTENCE}`;
  const body = await resolveCompletionBody(completion, spillDir);
  return body.kind === 'inline'
    ? `${head} Output below:\n\n${body.text}`
    : `${head} The output is too long, so the full result was saved to a file:\n\n${body.path}`;
}

function completionStatusLine(completion: PreparedCompletionFact): string {
  switch (completion.kind) {
    case 'teammate':
      return teammateStatusLine(
        completion.role,
        completion.source,
        completion.status,
      );
    case 'workflow':
      return workflowStatusLine(completion.runId, completion.status);
  }
}

/**
 * Word the completion notice by the producing Agent's actual role: a
 * Dispatcher's own Agent and a Team's leader are not TeamMates, so a fixed
 * "TeamMate" noun misdescribes their completion to the recipient.
 */
function teammateStatusLine(
  role: TeammateRole,
  source: string,
  status: PreparedCompletionFact['status'],
): string {
  const { subject, possessive } = roleSubject(role, source);
  switch (status) {
    case 'completed':
      return `${subject} has finished its task.`;
    case 'failed':
      return `${possessive} task failed.`;
    case 'stopped':
      return `${possessive} task was stopped.`;
  }
}

function roleSubject(
  role: TeammateRole,
  source: string,
): { subject: string; possessive: string } {
  switch (role) {
    case 'dispatcher':
      return {
        subject: 'The Dispatcher agent',
        possessive: "The Dispatcher agent's",
      };
    case 'team_leader':
      return {
        subject: `Team leader ${source}`,
        possessive: `Team leader ${source}'s`,
      };
    case 'teammate':
      return {
        subject: `TeamMate ${source}`,
        possessive: `TeamMate ${source}'s`,
      };
  }
}

function workflowStatusLine(
  runId: string,
  status: PreparedCompletionFact['status'],
): string {
  switch (status) {
    case 'completed':
      return `Workflow ${runId} has completed.`;
    case 'failed':
      return `Workflow ${runId} failed.`;
    case 'stopped':
      return `Workflow ${runId} was stopped.`;
  }
}
