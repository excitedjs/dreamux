import { Buffer } from 'node:buffer';

import type { AgentRuntime } from '@excitedjs/dreamux-types';

import { TeamMateIdentityStore } from './identity-store.js';
import { TeamMateTurnsStore, turnsScopeOf } from './turns-store.js';
import {
  validateTeamMateName,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateLastTurn,
  type TeamMateRecordRow,
  type TeamMateRuntimeStatus,
} from './types.js';

export interface TeammateReadModelOptions {
  dispatcherId: string;
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  runtimeFor: (name: string) => AgentRuntime | null;
}

export class TeammateReadModel {
  constructor(private readonly opts: TeammateReadModelOptions) {}

  private get dispatcherId(): string {
    return this.opts.dispatcherId;
  }

  async list(teamId?: string): Promise<TeamMateRuntimeStatus[]> {
    return (await this.rosterList(teamId)).map((identity) =>
      this.toStatus(identity, this.opts.runtimeFor(identity.name)),
    );
  }

  async status(name: string, teamId?: string): Promise<TeamMateRuntimeStatus> {
    const identity = await this.mustIdentity(validateTeamMateName(name), teamId);
    return this.toStatus(identity, this.opts.runtimeFor(identity.name));
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    const rows: TeamMateRecordRow[] = [];
    for (const identity of await this.rosterList(input.teamId)) {
      const row = this.toRecordRow(identity);
      if (matchesRecordQuery(row, input)) {
        rows.push(row);
      }
    }
    rows.sort((a, b) =>
      b.last_seen_at - a.last_seen_at ||
      b.updated_at - a.updated_at ||
      a.name.localeCompare(b.name),
    );
    const start = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
    const limit = clampHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeCursor(next) : null,
    };
  }

  async last(
    name: string,
    turns?: number,
    teamId?: string,
  ): Promise<TeamMateLastResult> {
    const requestedTurns = validateLastTurns(turns);
    const identity = await this.mustIdentity(validateTeamMateName(name), teamId);
    const teammate = this.toStatus(identity, this.opts.runtimeFor(identity.name));
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
      Pick<TeamMateLastTurn, 'turn_origin' | 'prompt_preview' | 'intent' | 'submitted_at'>
    >();
    const recent = new Map<string, TeamMateLastTurn>();
    for await (const event of this.opts.turnsStore.stream(turnsScopeOf(identity))) {
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
    const lastTurns = [...recent.values()].sort(
      (a, b) => (firstSeq.get(a.turn_id) ?? 0) - (firstSeq.get(b.turn_id) ?? 0),
    );
    return {
      teammate,
      requested_turns: requestedTurns,
      returned_turns: lastTurns.length,
      turns: lastTurns,
    };
  }

  async mustIdentity(
    name: string,
    teamId?: string,
  ): Promise<TeamMateIdentity> {
    const identity = await this.opts.identities.get(
      this.dispatcherId,
      name,
      teamId,
    );
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    this.assertInRoster(identity, teamId);
    return identity;
  }

  assertInRoster(identity: TeamMateIdentity, teamId?: string): void {
    if (this.identityInRoster(identity, teamId)) return;
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }

  toStatus(
    identity: TeamMateIdentity,
    runtime: AgentRuntime | null,
  ): TeamMateRuntimeStatus {
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

  private async rosterList(teamId?: string): Promise<TeamMateIdentity[]> {
    // Physical scoping is the roster (issue #233): a dispatcher-scope list reads
    // only `teammate/<name>/`, a team-scope list only that team's MEMBERS under
    // `team/<team>/teammate/<name>/`. The leader lives at the team root and is a
    // contained `TeammateService` on the `TeamService`, never a member row (Phase
    // 4). No post-filter is needed.
    return this.opts.identities.list(this.dispatcherId, teamId);
  }

  private identityInRoster(
    identity: TeamMateIdentity,
    teamId?: string,
  ): boolean {
    if (identity.dispatcher_id !== this.dispatcherId) return false;
    if (teamId === undefined) {
      return (
        identity.team_id === null &&
        identity.role === 'teammate'
      );
    }
    return (
      identity.team_id === teamId &&
      (identity.role === 'team_leader' || identity.role === 'team_member')
    );
  }

  private toRecordRow(identity: TeamMateIdentity): TeamMateRecordRow {
    const runtime = this.opts.runtimeFor(identity.name);
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
}

function matchesRecordQuery(
  row: TeamMateRecordRow,
  input: Omit<TeamMateHistoryQuery, 'dispatcherId'>,
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

function clampHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

const LAST_TURNS_DEFAULT = 1;
const LAST_TURNS_MAX = 5;

function validateLastTurns(input: number | undefined): number {
  if (input === undefined) return LAST_TURNS_DEFAULT;
  if (!Number.isInteger(input) || input < 1 || input > LAST_TURNS_MAX) {
    throw new Error(`last turns must be an integer in 1..${LAST_TURNS_MAX}`);
  }
  return input;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
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

function recordRowMatchesText(row: TeamMateRecordRow, grep: string): boolean {
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
