import {
  createTranscriptScanBudget,
  type TranscriptScanBudget,
} from '@excitedjs/dreamux-utils';

import { CodexTranscriptError } from './error.js';

export type CodexTranscriptBudget = TranscriptScanBudget;

export function createCodexTranscriptBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
} = {}): CodexTranscriptBudget {
  return createTranscriptScanBudget({
    ...input,
    limitError: () =>
      new CodexTranscriptError(
        'scan_unsupported',
        'Codex transcript discovery exceeded its bounded scan limit',
      ),
  });
}
