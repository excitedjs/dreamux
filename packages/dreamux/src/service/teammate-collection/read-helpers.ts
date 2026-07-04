import { Buffer } from 'node:buffer';

import type { AgentRuntime } from '@excitedjs/dreamux-types';

import { AgentTurnsStore, turnsScopeOf } from '../agent-entity/turns-store.js';
import {
  validateTeamMateName,
  type AgentEntityHistoryQuery,
  type AgentEntityIdentity,
  type AgentEntityLastTurn,
  type AgentEntityRecordRow,
  type AgentEntityRuntimeStatus,
} from '../agent-entity/types.js';

/**
 * Project an identity (+ its live runtime, if any) into the public runtime
 * status. Pure: no store reads and no scope decisions; the owning collection's
 * read chokepoint validates scope before calling this projector.
 */
export function toStatus(
  identity: AgentEntityIdentity,
  runtime: AgentRuntime | null,
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
    status: identity.status,
    runtime_status: runtime?.getStatus() ?? null,
    last_error: identity.last_error,
    closed_at: identity.closed_at,
    close_note: identity.close_note,
  };
}

/** Project an identity (+ live runtime) into a history record row. Pure. */
export function toRecordRow(
  identity: AgentEntityIdentity,
  runtime: AgentRuntime | null,
): AgentEntityRecordRow {
  return {
    name: identity.name,
    turn_count: identity.turn_count,
    agent_runtime: identity.agent_runtime,
    source_repo: identity.source_repo,
    created_at: identity.created_at,
    updated_at: identity.updated_at,
    last_seen_at: identity.last_seen_at,
    status: identity.status,
    runtime_status: runtime?.getStatus() ?? null,
    intent: identity.intent,
    closed_at: identity.closed_at,
    close_note: identity.close_note,
    close_note_preview:
      identity.close_note !== null ? previewText(identity.close_note) : null,
    last_prompt_preview: identity.last_prompt_preview,
    last_assistant_preview: identity.last_assistant_preview,
    cleanup_state: identity.worktree.cleanup_state,
    resume:
      identity.closed_at === null || identity.session_id !== null
        ? { tool: 'send', name: identity.name }
        : null,
  };
}

/**
 * Fold the entity's turn archive into the most-recent `requestedTurns` turns,
 * newest-last. Pure read over the turns store: it neither validates the request
 * (the caller passes an already-validated `requestedTurns`) nor assembles the
 * `AgentEntityLastResult` envelope (the caller pairs the array with
 * `toStatus(...)`). Returns the turns array only.
 */
export async function foldLastTurns(
  turnsStore: AgentTurnsStore,
  identity: AgentEntityIdentity,
  requestedTurns: number,
): Promise<AgentEntityLastTurn[]> {
  let nextSeq = 0;
  const firstSeq = new Map<string, number>();
  const seqOf = (turnId: string): number => {
    const existing = firstSeq.get(turnId);
    if (existing !== undefined) return existing;
    const seq = nextSeq;
    nextSeq += 1;
    firstSeq.set(turnId, seq);
    return seq;
  };
  const submitMeta = new Map<
    string,
    Pick<AgentEntityLastTurn, 'turn_origin' | 'prompt_preview' | 'intent' | 'submitted_at'>
  >();
  const recent = new Map<string, AgentEntityLastTurn>();
  for await (const event of turnsStore.stream(turnsScopeOf(identity))) {
    const turnId = event.turn_id;
    if (turnId === null) continue;
    seqOf(turnId);
    if (event.type === 'submit') {
      submitMeta.set(turnId, {
        turn_origin: event.turn_origin,
        prompt_preview: event.prompt_preview,
        intent: event.intent,
        submitted_at: event.timestamp,
      });
      continue;
    }
    if (event.type !== 'settled') continue;
    const present = recent.get(turnId);
    if (present !== undefined) {
      present.settle_status = event.settle_status;
      present.assistant = event.assistant;
      present.assistant_preview = event.assistant_preview;
      present.assistant_truncated = event.assistant_truncated;
      present.settled_at = event.timestamp;
      continue;
    }
    const submit = submitMeta.get(turnId);
    submitMeta.delete(turnId);
    recent.set(turnId, {
      turn_id: turnId,
      turn_origin: submit?.turn_origin ?? null,
      prompt_preview: submit?.prompt_preview ?? null,
      intent: submit?.intent ?? null,
      submitted_at: submit?.submitted_at ?? null,
      settled_at: event.timestamp,
      settle_status: event.settle_status,
      assistant: event.assistant,
      assistant_preview: event.assistant_preview,
      assistant_truncated: event.assistant_truncated,
    });
    if (recent.size > requestedTurns) {
      let evictId: string | undefined;
      let evictSeq = Infinity;
      for (const id of recent.keys()) {
        const seq = firstSeq.get(id) ?? Infinity;
        if (seq < evictSeq) {
          evictSeq = seq;
          evictId = id;
        }
      }
      if (evictId !== undefined) recent.delete(evictId);
    }
  }
  return [...recent.values()].sort(
    (a, b) => (firstSeq.get(a.turn_id) ?? 0) - (firstSeq.get(b.turn_id) ?? 0),
  );
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
    const hit =
      row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
    if (!hit) return false;
  }
  if (input.grep !== undefined && !recordRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.last_seen_at < input.since) return false;
  if (input.until !== undefined && row.last_seen_at > input.until) return false;
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
const LAST_TURNS_MAX = 5;

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
    row.last_prompt_preview,
    row.last_assistant_preview,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}
