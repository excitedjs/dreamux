import {
  createScanBudget,
  type ScanBudget,
} from '@excitedjs/dreamux-utils';

import { CodexActivityError } from './error.js';

export type CodexScanBudget = ScanBudget;

export function createCodexScanBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
} = {}): CodexScanBudget {
  return createScanBudget({
    ...input,
    limitError: () =>
      new CodexActivityError(
        'scan_unsupported',
        'Codex activity read exceeded its bounded limit',
      ),
  });
}
