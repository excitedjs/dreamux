import {
  createTranscriptScanBudget,
  type TranscriptScanBudget,
} from '@excitedjs/dreamux-utils';

import { ClaudeTranscriptError } from './error.js';

export type ClaudeTranscriptBudget = TranscriptScanBudget;

export function createClaudeTranscriptBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
} = {}): ClaudeTranscriptBudget {
  return createTranscriptScanBudget({
    ...input,
    limitError: () =>
      new ClaudeTranscriptError(
        'scan_unsupported',
        'Claude Code transcript discovery exceeded its bounded scan limit',
      ),
  });
}
