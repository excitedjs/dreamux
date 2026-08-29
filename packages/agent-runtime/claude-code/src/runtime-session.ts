import type { TurnOutcome } from './supervisor.js';

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

export function resultTextFromTurnOutcome(
  outcome: TurnOutcome,
  expectedSessionId: string | null,
  requiresStructuredOutput: boolean,
): string | null {
  if (
    outcome.sessionId !== null &&
    outcome.sessionId !== '' &&
    outcome.sessionId !== expectedSessionId
  ) {
    throw new Error(
      'claude-code returned a session id that differs from the pinned native session',
    );
  }
  const resultText =
    outcome.isError || outcome.text === '' ? null : outcome.text;
  if (outcome.isError) {
    const detail =
      outcome.errors.length > 0
        ? outcome.errors.join('; ')
        : (outcome.subtype ?? 'unknown error');
    throw new Error(`claude turn returned an error result: ${detail}`);
  }
  if (requiresStructuredOutput && !outcome.hasStructuredOutput) {
    throw new Error(
      'claude turn did not return structured_output for a ' +
        '--json-schema session',
    );
  }
  return resultText;
}
