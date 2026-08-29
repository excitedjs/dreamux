/**
 * Native admission classification for the Claude Code stream-json child.
 */
import type { RuntimeAdmission } from '@excitedjs/dreamux-types';

import { ClaudeSteerAdmissionError } from './rpc.js';

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function classifySteerFailure(
  error: unknown,
  stopped: boolean,
): RuntimeAdmission {
  if (error instanceof ClaudeSteerAdmissionError) {
    if (error.admission === 'ambiguous') {
      return { status: 'ambiguous', error };
    }
    if (!stopped) return { status: 'failed', error };
  }
  if (stopped) return { status: 'stopped' };
  return { status: 'ambiguous', error: asError(error) };
}
