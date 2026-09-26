/**
 * The paging primitives every domain history reader (`teammate.history`,
 * `team.history`, ...) uses to answer the same page-of-records question:
 * how many rows fit a page, where the next page starts, how a long free-text
 * field is shown in a row summary, and whether a row's free-text fields match
 * a caller's `grep` filter.
 *
 * A domain's row shape and its own filter fields (which columns `grep`
 * searches, `status`/`repo` equality, ...) are not here — they stay with the
 * domain reader that owns that row shape and pass their own field list into
 * {@link matchesGrepText}.
 */
import { Buffer } from 'node:buffer';

import { RuleViolation } from './errors.js';

const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 100;

export function clampHistoryLimit(input: number | undefined): number {
  if (input === undefined) return HISTORY_LIMIT_DEFAULT;
  if (!Number.isInteger(input) || input < 1) {
    throw new RuleViolation('history limit must be a positive integer');
  }
  return Math.min(input, HISTORY_LIMIT_MAX);
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed['offset'] === 'number' &&
      Number.isInteger(parsed['offset']) &&
      parsed['offset'] >= 0
    ) {
      return parsed['offset'];
    }
  } catch {
    // Every unreadable cursor is the same broken rule, stated once below.
  }
  throw new RuleViolation('invalid history cursor');
}

export function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

/**
 * Whether any of a row's free-text fields contains `grep`, case-insensitively.
 *
 * The needle is trimmed before matching, so leading/trailing whitespace in
 * the search term is ignored rather than causing every row to miss.
 */
export function matchesGrepText(
  fields: readonly (string | null)[],
  grep: string,
): boolean {
  const needle = grep.trim().toLowerCase();
  if (needle === '') return true;
  return fields.some(
    (value) => value !== null && value.toLowerCase().includes(needle),
  );
}
