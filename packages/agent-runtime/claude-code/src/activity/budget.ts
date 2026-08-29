import {
  createScanBudget,
  type ScanBudget,
} from '@excitedjs/dreamux-utils';

import { ClaudeActivityError } from './error.js';

export type ClaudeScanBudget = ScanBudget;

export function createClaudeScanBudget(input: {
  maxEntries?: number;
  maxElapsedMs?: number;
  now?: () => number;
} = {}): ClaudeScanBudget {
  return createScanBudget({
    ...input,
    limitError: () =>
      new ClaudeActivityError(
        'scan_unsupported',
        'Claude Code activity discovery exceeded its bounded scan limit',
      ),
  });
}
