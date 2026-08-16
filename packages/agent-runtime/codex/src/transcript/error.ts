import type { AgentRuntimeTranscriptError } from '@excitedjs/dreamux-types';

export class CodexTranscriptError
  extends Error
  implements AgentRuntimeTranscriptError
{
  readonly name = 'AgentRuntimeTranscriptError';

  constructor(
    readonly reason: AgentRuntimeTranscriptError['reason'],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}
