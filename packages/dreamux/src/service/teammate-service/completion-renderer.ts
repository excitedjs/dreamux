import { resolveCompletionBody } from '@excitedjs/dreamux-utils';

import type { PreparedCompletionFact } from '../completion-router/index.js';

/** Render any routed completion through the shared inline/spill pipeline. */
export async function buildCompletionTurnText(
  completion: PreparedCompletionFact,
  spillDir: string,
): Promise<string> {
  const line = completionStatusLine(completion);
  const body = await resolveCompletionBody(completion, spillDir);
  return body.kind === 'inline'
    ? `${line} Output below:\n\n${body.text}`
    : `${line} The output is too long, so the full result was saved to a file:\n\n${body.path}`;
}

function completionStatusLine(completion: PreparedCompletionFact): string {
  switch (completion.kind) {
    case 'teammate':
      return teammateStatusLine(completion.source, completion.status);
    case 'workflow':
      return workflowStatusLine(completion.runId, completion.status);
  }
}

function teammateStatusLine(
  source: string,
  status: PreparedCompletionFact['status'],
): string {
  switch (status) {
    case 'completed':
      return `TeamMate ${source} has finished its task.`;
    case 'failed':
      return `TeamMate ${source}'s task failed.`;
    case 'stopped':
      return `TeamMate ${source}'s task was stopped.`;
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
