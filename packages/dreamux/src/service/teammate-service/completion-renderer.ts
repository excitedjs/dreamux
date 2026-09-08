import { resolveCompletionBody } from '@excitedjs/dreamux-utils';

import type {
  PreparedCompletionFact,
  TeammateCompletionFact,
  WorkflowCompletionFact,
} from '../completion-router/index.js';

/**
 * The submission seam carries text only, so a pushed completion reaches the
 * model as an ordinary user turn distinguished only by its envelope tag; the
 * body therefore says in words that the host sent it.
 */
const NOTIFICATION_SENTENCE =
  'This is an automated notification from Dreamux, not a message from the user.';

/** Render any routed completion through the shape its producer reports in. */
export async function buildCompletionTurnText(
  completion: PreparedCompletionFact,
  spillDir: string,
): Promise<string> {
  return completion.kind === 'workflow'
    ? workflowNotification(completion)
    : teammateNotification(completion, spillDir);
}

/**
 * One TeamMate's settled turn: prose plus the result it produced.
 *
 * A TeamMate answers in its own words, so the answer is the body — inlined when
 * it fits the turn budget and spilled to a file when it does not.
 */
async function teammateNotification(
  completion: TeammateCompletionFact,
  spillDir: string,
): Promise<string> {
  const head = `${teammateStatusLine(completion)} ${NOTIFICATION_SENTENCE}`;
  const body = await resolveCompletionBody(completion, spillDir);
  return body.kind === 'inline'
    ? `${head} Output below:\n\n${body.text}`
    : `${head} The output is too long, so the full result was saved to a file:\n\n${body.path}`;
}

/**
 * One finished Workflow run: tagged facts and the paths to everything else.
 *
 * A run produces a script's return value, not an answer written for a reader,
 * and the caller usually needs to know how it went before deciding whether to
 * read it at all. So the notification states the outcome and names the files,
 * and the result stays on disk until the caller asks for it.
 */
function workflowNotification(completion: WorkflowCompletionFact): string {
  return [
    NOTIFICATION_SENTENCE,
    '',
    '<workflow-notification>',
    `<task-id>${completion.runId}</task-id>`,
    `<output-file>${completion.outputPath}</output-file>`,
    `<status>${workflowStatus(completion)}</status>`,
    `<summary>${workflowSummary(completion)}</summary>`,
    `<diagnostics>${workflowDiagnostics(completion)}</diagnostics>`,
    '</workflow-notification>',
  ].join('\n');
}

function workflowStatus(completion: WorkflowCompletionFact): string {
  const { total, succeeded, failed } = completion.agents;
  const agents = `${total} ${total === 1 ? 'agent' : 'agents'}`;
  const counts = `${agents}: ${succeeded} succeeded, ${failed} failed`;
  const reason = completion.error === null ? '' : ` — ${completion.error}`;
  return `${completion.status} — ${counts}${reason}`;
}

function workflowSummary(completion: WorkflowCompletionFact): string {
  // A run created before records carried the script's own words has no
  // description, and its id is then the only thing a summary can truthfully say.
  const subject = completion.description === null
    ? completion.runId
    : JSON.stringify(completion.description);
  return `Dynamic workflow ${subject} ${completion.status}`;
}

function workflowDiagnostics(completion: WorkflowCompletionFact): string {
  return (
    `Per-agent results: ${completion.journalPath} — one {"kind":"result",...} ` +
    'line per settled Agent. Read it before diagnosing an unexpected result.'
  );
}

function teammateStatusLine(completion: TeammateCompletionFact): string {
  switch (completion.status) {
    case 'completed':
      return `TeamMate ${completion.source} has finished its task.`;
    case 'failed':
      return `TeamMate ${completion.source}'s task failed.`;
    case 'stopped':
      return `TeamMate ${completion.source}'s task was stopped.`;
  }
}
