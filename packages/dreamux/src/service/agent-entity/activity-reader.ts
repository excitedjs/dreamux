import { Buffer } from 'node:buffer';

import type {
  AgentActivityError,
  AgentActivityPage,
  AgentActivityRecord,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  HOST_INJECT_ENV,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import { resolveAgent } from './agent-config.js';
import {
  type AgentEntityActivityRecord,
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
} from './types.js';
import { errorInfo } from '../../platform/error-info.js';
import { validateLastLimit } from './read-helpers.js';

/**
 * Core's independent bounds on a provider page. The provider enforces its own
 * native read bounds and reports truncation; Core still validates what comes
 * back, because a provider is not trusted to bound Core's output.
 */
export const ACTIVITY_OUTPUT_BUDGET_BYTES = 262_144;
const ACTIVITY_CURSOR_MAX_LENGTH = 4096;
const ACTIVITY_TEXT_MAX_CHARS = 16_384;
const ACTIVITY_TOOL_NAME_MAX_CHARS = 256;

const ACTIVITY_ERROR_REASONS = new Set<AgentActivityError['reason']>([
  'session_unavailable',
  'cursor_invalid',
  'activity_corrupt',
  'provider_failure',
]);

/**
 * An Activity read that failed for a reason the provider seam names.
 *
 * Only the four recognized reasons reach this class. A failure nobody
 * recognized is not translated into it: it keeps its own type and its own
 * message, because Core did not diagnose it and has nothing truer to say.
 */
export class AgentActivityReadError extends Error {
  constructor(readonly reason: AgentActivityError['reason']) {
    super('Agent Runtime activity read failed');
    this.name = 'AgentActivityReadError';
  }
}

export interface ReadAgentActivityInput {
  config: DreamuxConfig;
  providers: AgentRuntimeProviderCatalog;
  identity: AgentEntityIdentity;
  query: AgentEntityLastQuery;
  log: DreamuxLogger;
}

export interface ReadAgentActivityResult {
  requestedRecords: number;
  records: AgentEntityActivityRecord[];
  nextCursor: string | null;
  truncated: boolean;
}

/**
 * Read the recent tail of an agent entity's activity through its provider.
 *
 * This is a cold read: it never materializes the entity or starts a runtime, so
 * a closed teammate stays readable. It works equally against a live session,
 * because the provider's reader is required to produce records for an
 * in-progress turn.
 */
export async function readAgentActivity(
  input: ReadAgentActivityInput,
): Promise<ReadAgentActivityResult> {
  const requestedRecords = validateLastLimit(input.query.limit);
  const cursor = validateActivityCursor(input.query.cursor);
  const includeTools = validateIncludeTools(input.query.includeTools);
  const sessionId = input.identity.session_id;
  if (sessionId === null) {
    throw new AgentActivityReadError('session_unavailable');
  }
  const agent = resolveAgent(
    input.config,
    input.identity.dispatcher_id,
    input.identity.agent_runtime,
  );
  const provider = input.providers.resolve(agent.provider).implementation;
  let page: AgentActivityPage;
  try {
    page = await provider.readRecentActivity(
      {
        sessionId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit: requestedRecords,
        includeTools,
      },
      {
        config: agent.config,
        cwd: input.identity.runtime_cwd,
        injectEnv: HOST_INJECT_ENV,
        logger: input.log,
      },
    );
    verifyActivityPage(page, requestedRecords);
  } catch (error) {
    throwActivityReadError(error, input.log, input.identity.name);
  }
  return {
    requestedRecords,
    records: page.records.map(toEntityRecord),
    nextCursor: page.nextCursor ?? null,
    truncated: page.truncated,
  };
}

function toEntityRecord(record: AgentActivityRecord): AgentEntityActivityRecord {
  return record.kind === 'assistant_message'
    ? {
        kind: 'assistant_message',
        text: record.text,
        occurred_at: record.occurredAt ?? null,
      }
    : {
        kind: 'tool',
        name: record.name,
        status: record.status,
        occurred_at: record.occurredAt ?? null,
      };
}

/**
 * Report one failed Activity read, and decide nothing else about it.
 *
 * A reason the provider seam names is the one thing this layer can restate, so
 * it becomes the named read failure its callers already map. Everything else —
 * a provider bug, a library throw, a Core check that did not hold — leaves
 * exactly as it arrived, so its own message is what a caller finally reads.
 * The log gets the whole value either way; the stack is an operator fact and
 * never travels with the answer.
 */
function throwActivityReadError(
  error: unknown,
  log: DreamuxLogger,
  teammateName: string,
): never {
  const reason = recognizedActivityErrorReason(error);
  log.error(
    {
      teammate: teammateName,
      ...(reason !== null ? { activity_reason: reason } : {}),
      err: errorInfo(error),
    },
    'Agent Runtime activity read failed',
  );
  if (reason === null) throw error;
  throw new AgentActivityReadError(reason);
}

function recognizedActivityErrorReason(
  error: unknown,
): AgentActivityError['reason'] | null {
  if (error instanceof AgentActivityReadError) return error.reason;
  if (error === null || typeof error !== 'object') return null;
  const candidate = error as Record<string, unknown>;
  if (candidate['name'] !== 'AgentActivityError') return null;
  const reason = candidate['reason'];
  return typeof reason === 'string' &&
    ACTIVITY_ERROR_REASONS.has(reason as AgentActivityError['reason'])
    ? (reason as AgentActivityError['reason'])
    : null;
}

function validateActivityCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (
    cursor.length === 0 ||
    cursor.length > ACTIVITY_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new AgentActivityReadError('cursor_invalid');
  }
  return cursor;
}

function validateIncludeTools(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error('last include_tools must be a boolean');
  }
  return value;
}

function verifyActivityPage(
  page: AgentActivityPage,
  requestedRecords: number,
): void {
  if (
    page === null ||
    typeof page !== 'object' ||
    !Array.isArray(page.records) ||
    typeof page.truncated !== 'boolean' ||
    !isValidPageCursor(page.nextCursor)
  ) {
    throw new Error('Agent Runtime activity provider returned an invalid page');
  }
  if (page.records.length > requestedRecords) {
    throw new Error(
      'Agent Runtime activity provider returned too many records',
    );
  }
  for (const record of page.records) verifyActivityRecord(record);
  const bytes = Buffer.byteLength(JSON.stringify(page.records), 'utf8');
  if (bytes > ACTIVITY_OUTPUT_BUDGET_BYTES) {
    throw new Error(
      `Agent Runtime activity provider exceeded the ${ACTIVITY_OUTPUT_BUDGET_BYTES}-byte output budget`,
    );
  }
}

function verifyActivityRecord(record: AgentActivityRecord): void {
  if (record === null || typeof record !== 'object') {
    throw new Error(
      'Agent Runtime activity provider returned an invalid record',
    );
  }
  if (!isNullableTimestamp(record.occurredAt)) {
    throw new Error(
      'Agent Runtime activity provider returned an invalid record timestamp',
    );
  }
  if (record.kind === 'assistant_message') {
    if (!isBoundedString(record.text, ACTIVITY_TEXT_MAX_CHARS)) {
      throw new Error(
        'Agent Runtime activity provider returned an invalid assistant record',
      );
    }
    return;
  }
  if (
    record.kind !== 'tool' ||
    !isBoundedString(record.name, ACTIVITY_TOOL_NAME_MAX_CHARS) ||
    (record.status !== 'started' &&
      record.status !== 'completed' &&
      record.status !== 'failed')
  ) {
    throw new Error(
      'Agent Runtime activity provider returned an invalid tool record',
    );
  }
}

function isValidPageCursor(value: string | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= ACTIVITY_CURSOR_MAX_LENGTH &&
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}

function isNullableTimestamp(value: string | undefined): boolean {
  if (value === undefined) return true;
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    !Number.isNaN(Date.parse(value))
  );
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && [...value].length <= limit;
}
