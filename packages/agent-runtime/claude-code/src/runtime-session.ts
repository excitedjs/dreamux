import type { RuntimeCompletion } from '@excitedjs/dreamux-types';
import type { TurnOutcome } from './types.js';

export function buildClaudeProcessEnv(
  injectEnv: Record<string, string> | undefined,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...globalThis.process.env,
    ...(injectEnv ?? {}),
    ...extraEnv,
  };
}

/** One immutable completion per native result, shared by every answered request. */
export function completionFromTurnOutcome(
  outcome: TurnOutcome,
  expectedSessionId: string | null,
  requiresStructuredOutput: boolean,
): RuntimeCompletion {
  let error: Error | null = null;
  if (
    outcome.sessionId !== null &&
    outcome.sessionId !== '' &&
    outcome.sessionId !== expectedSessionId
  ) {
    error = new Error(
      'claude-code returned a session id that differs from the pinned native session',
    );
  } else if (outcome.isError) {
    error = new Error(turnFailureMessage(outcome));
  } else if (requiresStructuredOutput && !outcome.hasStructuredOutput) {
    error = new Error(
      'claude turn did not return structured_output for a ' +
        '--json-schema session',
    );
  }
  return error !== null
    ? Object.freeze({ status: 'failed', error })
    : Object.freeze({
        status: 'completed',
        resultText: outcome.text === '' ? null : outcome.text,
      });
}

/** Claude's own explanation for a failed native result. */
export function turnFailureMessage(outcome: TurnOutcome): string {
  return outcome.errors.join('; ') ||
    (outcome.subtype === 'success' ? outcome.text : '') ||
    outcome.terminalReason || outcome.subtype || 'claude turn failed';
}
