/** Bounded model-facing collection scans; domain and Command lists stay whole. */
import type { JsonSchema } from '@excitedjs/dreamux-types';

import {
  optionalInteger,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import { INTEGER, NULLABLE_STRING } from '../../command/schema.js';
import { ValidationError } from '../../platform/errors.js';
import {
  clampHistoryLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/history-page.js';

const LIST_STATUS_ALL = 'all';
const LIST_STATUS_NON_CLOSED = 'non_closed';

export const PAGE_LIMIT_PROPERTY: JsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  default: 20,
  description: 'Rows per page; default 20, maximum 100.',
};

export const LIST_PAGE_PROPERTIES = {
  total: {
    ...INTEGER,
    description: 'Total rows matching the status filter, before pagination.',
  },
  next_cursor: NULLABLE_STRING,
};

export function listInputProperties(
  statuses: readonly string[],
): Record<string, JsonSchema> {
  return {
    status: {
      type: 'string',
      enum: [LIST_STATUS_NON_CLOSED, LIST_STATUS_ALL, ...statuses],
      default: LIST_STATUS_NON_CLOSED,
      description:
        'Default non_closed excludes only closed resources. Use all or an exact status to include closed resources.',
    },
    limit: PAGE_LIMIT_PROPERTY,
    cursor: {
      type: 'string',
      minLength: 1,
      description:
        'next_cursor from the previous page; keep the same status filter. Each call reads current state, not a frozen snapshot.',
    },
  };
}

/**
 * Callers provide their authorized, consistently ordered rows before paging.
 * `exclude` drops a row the caller may not see (a member never lists itself)
 * before the total is counted, so totals describe the visible collection.
 */
export function listPage<T extends { status: string }>(
  rows: readonly T[],
  args: CommandPayload,
  statuses: readonly string[],
  exclude?: (row: T) => boolean,
): { items: T[]; total: number; next_cursor: string | null } {
  const matches = statusMatcher(optionalString(args, 'status'), statuses);
  const cursor = optionalString(args, 'cursor');
  const start = cursor === null ? 0 : decodeCursor(cursor);
  const limit = clampHistoryLimit(optionalInteger(args, 'limit') ?? undefined);
  const items: T[] = [];
  let total = 0;
  for (const row of rows) {
    if (exclude?.(row) === true || !matches(row)) continue;
    if (total >= start && items.length < limit) items.push(row);
    total += 1;
  }
  const next = start + items.length;
  return {
    items,
    total,
    next_cursor: next < total ? encodeCursor(next) : null,
  };
}

/** The requested status, validated once, as the one row predicate it means. */
function statusMatcher(
  requested: string | null,
  statuses: readonly string[],
): (row: { status: string }) => boolean {
  const status = requested ?? LIST_STATUS_NON_CLOSED;
  if (status === LIST_STATUS_ALL) return () => true;
  if (status === LIST_STATUS_NON_CLOSED) {
    return (row) => row.status !== 'closed';
  }
  if (!statuses.includes(status)) {
    throw new ValidationError(`Unknown list status: ${status}`);
  }
  return (row) => row.status === status;
}
