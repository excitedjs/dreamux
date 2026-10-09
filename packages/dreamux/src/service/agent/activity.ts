import type {
  AgentActivityError,
  AgentActivityPage,
  AgentActivityRecord,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { StatedFailure } from '../../platform/errors.js';
import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/catalog.js';

import { resolveAgent, type DreamuxConfig } from '../../config/config.js';
import {
  type AgentEntityActivityRecord,
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
} from './identity.js';
import { errorInfo } from '@excitedjs/dreamux-utils';
import { validateLastLimit } from './requests.js';
import type { RunningLaunch } from './types.js';

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
  /** Resolves the provider and config of an entity with no running runtime. */
  config: DreamuxConfig;
  providers: AgentRuntimeProviderCatalog;
  identity: AgentEntityIdentity;
  /**
   * The provider and config of the running generation, when there is one. It
   * wins over `config`: a runtime keeps the config it launched with, so the
   * current config may no longer describe the session being read.
   */
  running: RunningLaunch | null;
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
  const { provider, config } = input.running ?? resolveStoppedSource(input);
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
        config,
        cwd: input.identity.runtime_cwd,
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

/** With no runtime running, the entity reads through the current config. */
function resolveStoppedSource(input: ReadAgentActivityInput): RunningLaunch {
  const agent = resolveAgent(
    input.config,
    input.identity.dispatcher_id,
    input.identity.agent_runtime,
  );
  return {
    provider: input.providers.resolve(agent.provider).implementation,
    config: agent.config,
  };
}

function toEntityRecord(
  record: AgentActivityRecord,
): AgentEntityActivityRecord {
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

function validateActivityCursor(
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
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
    if (typeof record.text !== 'string') {
      throw new Error(
        'Agent Runtime activity provider returned an invalid assistant record',
      );
    }
    return;
  }
  if (
    record.kind !== 'tool' ||
    typeof record.name !== 'string' ||
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
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}

function isNullableTimestamp(value: string | undefined): boolean {
  if (value === undefined) return true;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * One Activity read failure, as the Agent entity layer states it.
 *
 * Named rather than assembled at the throw site: the reader's internal reason
 * vocabulary stops here, and what leaves is a fact with its own stable code and
 * its own next step.
 */
export class AgentActivityFailure extends StatedFailure {
  constructor(code: string, reason: string, action: string) {
    super(code, reason, action);
  }
}

/**
 * The public face of an Activity read failure the provider seam named. Each
 * message describes a neutral state only: never a filesystem path, a native
 * history layout, or a scan mode. Each action is what a caller can actually do
 * about that state.
 *
 * This table covers exactly the four recognized reasons and nothing else. A
 * failure Core never diagnosed is not listed here and is not given a sentence
 * here; it keeps its own.
 */
export const ACTIVITY_PUBLIC_ERRORS = [
  {
    reason: 'session_unavailable',
    code: 'ACTIVITY_SESSION_UNAVAILABLE',
    message: 'No runtime activity is available for this session.',
    action:
      'This agent has not produced runtime activity yet; send it a turn, or ' +
      'read its status to see whether it is running.',
  },
  {
    reason: 'cursor_invalid',
    code: 'ACTIVITY_CURSOR_INVALID',
    message: 'The activity cursor is invalid or no longer usable.',
    action: 'Read again without a cursor to start from the latest records.',
  },
  {
    reason: 'activity_corrupt',
    code: 'ACTIVITY_CORRUPT',
    message: 'The runtime activity could not be interpreted.',
    action:
      'Read again without a cursor; if it keeps failing, report it to the ' +
      'operator.',
  },
  {
    reason: 'provider_failure',
    code: 'ACTIVITY_PROVIDER_FAILURE',
    message: 'The agent runtime could not serve the activity read.',
    action:
      'Retry once; if it repeats, read the agent status to see whether its ' +
      'runtime is still running.',
  },
] as const satisfies readonly {
  reason: AgentActivityError['reason'];
  code: string;
  message: string;
  action: string;
}[];

/**
 * Re-throw one recognized Activity read failure as its public Command error.
 *
 * Only a read failure the provider seam named reaches here at all; anything
 * else was already left alone by the reader and passes straight through this
 * function with its own type and message intact.
 */
export function mapAgentActivityCommandError(error: unknown): never {
  if (!(error instanceof AgentActivityReadError)) throw error;
  const mapped = ACTIVITY_PUBLIC_ERRORS.find(
    (entry) => entry.reason === error.reason,
  );
  if (mapped === undefined) throw error;
  // A known Activity failure keeps its own public code; the reader's internal
  // reasons are what stay private, not the fact that the read failed.
  throw new AgentActivityFailure(mapped.code, mapped.message, mapped.action);
}
