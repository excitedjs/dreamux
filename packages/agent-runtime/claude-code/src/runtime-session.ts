import type { TurnOutcome } from './supervisor.js';
import {
  deriveClaudeTranscriptPath,
  locateClaudeTranscript,
} from './transcript/path.js';

export interface ResolveRuntimeTranscriptPathInput {
  sessionId: string;
  cwd: string;
  locator: string | null;
  env: NodeJS.ProcessEnv;
  resume: boolean;
  override?: (
    input: Omit<ResolveRuntimeTranscriptPathInput, 'override'>,
  ) => Promise<string>;
}

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

export function resolveRuntimeTranscriptPath(
  input: ResolveRuntimeTranscriptPathInput,
): Promise<string> {
  const { override, ...pathInput } = input;
  if (override !== undefined) return override(pathInput);
  return input.resume
    ? locateClaudeTranscript({
        sessionId: input.sessionId,
        cwd: input.cwd,
        locator: input.locator,
        env: input.env,
      }).then((located) => located.path)
    : deriveClaudeTranscriptPath(input.sessionId, input.cwd, input.env);
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
