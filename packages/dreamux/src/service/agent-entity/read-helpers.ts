import { Buffer } from 'node:buffer';

import type { AgentRuntimeStatus } from '@excitedjs/dreamux-types';

import { RuleViolation, throwCallerMistake } from '../../command/errors.js';
import {
  mustString,
  optionalBooleanField,
  optionalInteger,
  optionalNonBlankString,
  optionalString,
  type CommandPayload,
} from '../../command/payload.js';
import {
  validateTeamMateName,
  type AgentEntityHistoryQuery,
  type AgentEntityIdentity,
  type AgentEntityLastQuery,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeStatus,
} from './types.js';

export function toStatus(
  identity: AgentEntityIdentity,
  runtimeStatus: AgentRuntimeStatus | null,
  effectiveStatus = identity.status,
): AgentEntityRuntimeStatus {
  return {
    name: identity.name,
    session_id: identity.session_id,
    agent_runtime: identity.agent_runtime,
    repo: {
      mode: identity.worktree.mode,
      path: identity.runtime_cwd,
      source_repo: identity.source_repo,
      branch: identity.worktree.branch,
      base_ref: identity.worktree.base_ref,
      cleanup: identity.worktree.cleanup,
      cleanup_state: identity.worktree.cleanup_state,
    },
    intent: identity.intent,
    status: effectiveStatus,
    runtime_status: runtimeStatus,
    last_error: identity.last_error,
    closed_at: identity.closed_at,
    close_note: identity.close_note,
  };
}

export function toRecordRow(
  identity: AgentEntityIdentity,
  runtimeStatus: AgentRuntimeStatus | null,
  effectiveStatus = identity.status,
): AgentEntityRecordRow {
  return {
    name: identity.name,
    agent_runtime: identity.agent_runtime,
    source_repo: identity.source_repo,
    created_at: identity.created_at,
    updated_at: identity.updated_at,
    status: effectiveStatus,
    runtime_status: runtimeStatus,
    intent: identity.intent,
    closed_at: identity.closed_at,
    close_note: identity.close_note,
    close_note_preview:
      identity.close_note === null ? null : previewText(identity.close_note),
    cleanup_state: identity.worktree.cleanup_state,
    resume:
      identity.closed_at === null || identity.session_id !== null
        ? { tool: 'send', name: identity.name }
        : null,
  };
}

export function matchesRecordQuery(
  row: AgentEntityRecordRow,
  input: Omit<AgentEntityHistoryQuery, 'dispatcherId'>,
): boolean {
  if (input.name !== undefined && row.name !== validateTeamMateName(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (
    input.agentRuntime !== undefined &&
    row.agent_runtime !== input.agentRuntime
  ) {
    return false;
  }
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    if (
      row.source_repo === null ||
      !row.source_repo.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  if (input.grep !== undefined && !recordRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.updated_at < input.since) return false;
  if (input.until !== undefined && row.updated_at > input.until) return false;
  return true;
}

export function clampHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new RuleViolation('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

/**
 * Read an agent entity name parameter.
 *
 * The entity naming rule decides it, on every caller-facing surface, and a name
 * that breaks it is the caller's mistake rather than an unclassified failure
 * raised deep in a lookup or a record scan. The rule speaks in its own words, so
 * its sentence is kept and only its type is made the caller's.
 */
export function agentEntityNameParam(
  params: CommandPayload,
  key: string,
): string {
  return assertEntityName(mustString(params, key));
}

/** The same read where the field is an optional filter; absent stays absent. */
export function optionalAgentEntityNameParam(
  params: CommandPayload,
  key: string,
): string | null {
  const value = optionalNonBlankString(params, key);
  return value === null ? null : assertEntityName(value);
}

function assertEntityName(value: string): string {
  try {
    return validateTeamMateName(value);
  } catch (error) {
    throwCallerMistake(error);
  }
}

const LAST_LIMIT_DEFAULT = 20;
const LAST_LIMIT_MAX = 200;

export function validateLastLimit(input: number | undefined): number {
  if (input === undefined) return LAST_LIMIT_DEFAULT;
  if (!Number.isInteger(input) || input < 1 || input > LAST_LIMIT_MAX) {
    throw new RuleViolation(
      `last limit must be an integer in 1..${LAST_LIMIT_MAX}`,
    );
  }
  return input;
}

/**
 * One Activity read request, as every caller-facing surface asks it.
 *
 * The bound belongs to {@link validateLastLimit} and is stated in its own words;
 * only its type becomes the caller's, so the sentence a caller reads cannot
 * drift from the limit that produced it.
 */
export function agentEntityLastQuery(
  params: CommandPayload,
): AgentEntityLastQuery {
  const limit = optionalInteger(params, 'limit');
  try {
    validateLastLimit(limit ?? undefined);
  } catch (error) {
    throwCallerMistake(error);
  }
  const cursor = optionalString(params, 'cursor');
  const includeTools = optionalBooleanField(params, 'include_tools')[
    'include_tools'
  ];
  return {
    ...(limit !== null ? { limit } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(includeTools !== undefined ? { includeTools } : {}),
  };
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

function recordRowMatchesText(row: AgentEntityRecordRow, grep: string): boolean {
  const needle = grep.trim().toLowerCase();
  if (needle === '') return true;
  return [
    row.name,
    row.agent_runtime,
    row.source_repo,
    row.intent,
    row.close_note,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500
    ? collapsed
    : `${collapsed.slice(0, 497)}...`;
}
