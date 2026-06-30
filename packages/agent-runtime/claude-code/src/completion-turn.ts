import { resolveCompletionBody } from '@excitedjs/dreamux-utils';
import type { CompletionEnvelope } from '@excitedjs/dreamux-types';

/**
 * Status line opening a TeamMate completion turn. Plain English, status-varied:
 * do not mimic claude-code's native task-notification harness.
 */
function completionStatusLine(completion: CompletionEnvelope): string {
  switch (completion.status) {
    case 'completed':
      return `TeamMate ${completion.source} has finished its task.`;
    case 'failed':
      return `TeamMate ${completion.source}'s task failed.`;
    case 'stopped':
      return `TeamMate ${completion.source}'s task was stopped.`;
  }
}

/**
 * Build the plain-text completion turn. The result is inlined when short; when
 * it overflows the inline budget the full result is spilled to a file and only
 * the path is inlined.
 */
export async function buildCompletionTurnText(
  completion: CompletionEnvelope,
  spillDir: string,
): Promise<string> {
  const line = completionStatusLine(completion);
  const body = await resolveCompletionBody(completion, spillDir);
  return body.kind === 'inline'
    ? `${line} Output below:\n\n${body.text}`
    : `${line} The output is too long, so the full result was saved to a file:\n\n${body.path}`;
}
