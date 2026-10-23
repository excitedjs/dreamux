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
      enum: ['non_closed', 'all', ...statuses],
      default: 'non_closed',
      description:
        'Default non_closed excludes only closed resources. Use all or an exact status to include closed resources.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
      description: 'Rows per page; default 20, maximum 100.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      description:
        'next_cursor from the previous page; keep the same status filter. Each call reads current state, not a frozen snapshot.',
    },
  };
}

/** Callers provide their authorized, consistently ordered rows before paging. */
export function listPage<T extends { status: string }>(
  rows: readonly T[],
  args: CommandPayload,
  statuses: readonly string[],
): { items: T[]; total: number; next_cursor: string | null } {
  const status = optionalString(args, 'status') ?? 'non_closed';
  if (
    status !== 'non_closed' &&
    status !== 'all' &&
    !statuses.includes(status)
  ) {
    throw new ValidationError(`Unknown list status: ${status}`);
  }
  const matching = rows.filter(
    (row) =>
      status === 'all' ||
      (status === 'non_closed'
        ? row.status !== 'closed'
        : row.status === status),
  );
  const cursor = optionalString(args, 'cursor');
  const start = cursor === null ? 0 : decodeCursor(cursor);
  const limit = clampHistoryLimit(optionalInteger(args, 'limit') ?? undefined);
  const items = matching.slice(start, start + limit);
  const next = start + items.length;
  return {
    items,
    total: matching.length,
    next_cursor: next < matching.length ? encodeCursor(next) : null,
  };
}
