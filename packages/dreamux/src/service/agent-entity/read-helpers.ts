import { Buffer } from 'node:buffer';

import type { AgentRuntimeStatus } from '@excitedjs/dreamux-types';

import {
  validateTeamMateName,
  type AgentEntityHistoryQuery,
  type AgentEntityIdentity,
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
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

const LAST_TURNS_DEFAULT = 1;
const LAST_TURNS_MAX = 50;

export function validateLastTurns(input: number | undefined): number {
  if (input === undefined) return LAST_TURNS_DEFAULT;
  if (!Number.isInteger(input) || input < 1 || input > LAST_TURNS_MAX) {
    throw new Error(`last turns must be an integer in 1..${LAST_TURNS_MAX}`);
  }
  return input;
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
    // Invalid cursors share one stable public error below.
  }
  throw new Error('invalid history cursor');
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
