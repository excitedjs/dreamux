import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { dispatcherTeamMateSessionLedgerPath } from '../../platform/paths.js';
import type {
  TeamMateIdentity,
  TeamMateSessionEventType,
  TeamMateSessionLedgerEvent,
  TeamMateSessionRow,
  TeamMateTurnOrigin,
} from './types.js';

export interface TeamMateSessionLedgerLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface TeamMateSessionAppendInput {
  identity: TeamMateIdentity;
  type: TeamMateSessionEventType;
  turnId?: string | null;
  turnOrigin?: TeamMateTurnOrigin | null;
  prompt?: string | null;
  assistant?: string | null;
  settleStatus?: 'completed' | 'failed' | 'stopped' | null;
  note?: string | null;
}

const PREVIEW_MAX = 500;
const PREVIEW_HEAD = 497;

/**
 * Hard cap on the durable assistant output captured in a `settled` event
 * (issue #188). The full final output (up to this many chars) is the
 * failed-completion-delivery fallback `last` returns; beyond it the text is
 * truncated and {@link TeamMateSessionLedgerEvent.assistant_truncated} is set.
 * This keeps the append-only ledger bounded without a new per-turn file.
 */
export const ASSISTANT_TEXT_MAX = 160_000;

/**
 * Durable, append-only TeamMate/Team session ledger (issue #182 PR-5).
 *
 * Capture is forward-only: lifecycle facts are appended as events at the
 * service boundaries (spawn/create, send, turn settled, close/dissolve) into a
 * single per-dispatcher `sessions.jsonl`. Each event denormalizes the recovery
 * metadata so a session is reconstructable from the ledger alone. A write
 * failure is logged and swallowed — capturing a session fact must never fail a
 * lifecycle verb (the same contract as the per-name history index).
 *
 * Reads stream the file line-by-line (no whole-file load) and `read` accepts a
 * `limit` that keeps only the most recent N events; the public cursored read
 * surface is built on this in PR-6.
 */
export class TeamMateSessionLedger {
  constructor(private readonly log: TeamMateSessionLedgerLog) {}

  async append(input: TeamMateSessionAppendInput): Promise<void> {
    const identity = input.identity;
    const sessionId = identity.session_id;
    if (sessionId === null) {
      // Every spawn mints a session id before any append; a null here means a
      // pre-PR-5 record reached a lifecycle verb without one. Skip rather than
      // write a session-less, unlinkable event.
      this.log.warn('skipping session ledger event without a session id', {
        dispatcher_id: identity.dispatcher_id,
        name: identity.name,
        type: input.type,
      });
      return;
    }
    try {
      const now = Date.now();
      // Capture the full final assistant output up to the hard cap (issue #188);
      // the preview stays the compact form. A capped capture sets the truncated
      // flag so `last` can report completeness honestly.
      const rawAssistant =
        input.assistant !== undefined && input.assistant !== null
          ? input.assistant
          : null;
      const assistantTruncated =
        rawAssistant !== null && rawAssistant.length > ASSISTANT_TEXT_MAX;
      const assistant =
        rawAssistant === null
          ? null
          : assistantTruncated
            ? rawAssistant.slice(0, ASSISTANT_TEXT_MAX)
            : rawAssistant;
      const event: TeamMateSessionLedgerEvent = {
        version: 1,
        session_id: sessionId,
        event_id: now,
        timestamp: now,
        type: input.type,
        dispatcher_id: identity.dispatcher_id,
        name: identity.name,
        display_name: identity.display_name,
        role: identity.role,
        team_id: identity.team_id,
        leader_name: leaderNameFor(identity),
        owner: identity.owner,
        agent_runtime: identity.agent_runtime,
        source_repo: identity.source_repo,
        source_cwd: identity.source_cwd,
        cwd: identity.cwd,
        worktree_slug: identity.worktree.slug,
        worktree_path: identity.worktree.path,
        branch: identity.worktree.branch,
        base_ref: identity.worktree.base_ref,
        intent: identity.intent,
        checkpoint_kind: identity.checkpoint?.kind ?? null,
        session_ref: identity.checkpoint?.id ?? null,
        status: identity.status,
        turn_id: input.turnId ?? null,
        turn_origin: input.turnOrigin ?? null,
        prompt_preview:
          input.prompt !== undefined && input.prompt !== null
            ? preview(input.prompt)
            : null,
        assistant_preview: rawAssistant !== null ? preview(rawAssistant) : null,
        assistant,
        assistant_truncated: assistantTruncated,
        settle_status: input.settleStatus ?? null,
        note: input.note ?? null,
      };
      const path = dispatcherTeamMateSessionLedgerPath(identity.dispatcher_id);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch (err) {
      this.log.warn('TeamMate session ledger append failed', {
        dispatcher_id: identity.dispatcher_id,
        name: identity.name,
        type: input.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stream the ledger events for one dispatcher in append order. `limit` keeps
   * only the most recent N events (a bounded tail), read without loading the
   * whole file into one string. A missing ledger reads as an empty list.
   */
  async read(
    dispatcherId: string,
    options: { limit?: number } = {},
  ): Promise<TeamMateSessionLedgerEvent[]> {
    const path = dispatcherTeamMateSessionLedgerPath(dispatcherId);
    const limit = options.limit;
    const events: TeamMateSessionLedgerEvent[] = [];
    let stream;
    try {
      stream = createReadStream(path, { encoding: 'utf8' });
    } catch {
      return [];
    }
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: TeamMateSessionLedgerEvent;
        try {
          parsed = JSON.parse(line) as TeamMateSessionLedgerEvent;
        } catch {
          continue; // skip a torn/partial line rather than fail the read
        }
        events.push(parsed);
        if (limit !== undefined && limit > 0 && events.length > limit) {
          events.shift();
        }
      }
    } catch (err) {
      if (!isNotFound(err)) {
        this.log.warn('TeamMate session ledger read failed', {
          dispatcher_id: dispatcherId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return events;
    } finally {
      lines.close();
    }
    return events;
  }

  /**
   * Stream the ledger events of exactly one `session_id` in append order
   * (issue #188), yielding line by line so the caller folds with bounded memory
   * rather than materializing the whole session (a settled event can carry up to
   * 160k chars of assistant text, so a long session must never be buffered whole
   * — this is why #188 scans `sessions.jsonl` directly instead of adding a
   * per-turn index). It never starts or resumes a runtime, so it serves a closed
   * or stopped teammate from the durable ledger alone. A missing ledger or
   * unknown session yields nothing.
   */
  async *streamSession(
    dispatcherId: string,
    sessionId: string,
  ): AsyncGenerator<TeamMateSessionLedgerEvent> {
    for await (const event of this.streamEvents(dispatcherId)) {
      if (event.session_id === sessionId) yield event;
    }
  }

  /**
   * Stream every ledger event for one dispatcher in append order, yielding line
   * by line so callers fold with bounded memory rather than buffering the whole
   * file (a settled event can carry up to 160k chars of assistant text, so the
   * long-lived append-only ledger must never be materialized whole — issue #182
   * final gate). A missing ledger yields nothing; a torn/partial line is skipped.
   */
  private async *streamEvents(
    dispatcherId: string,
  ): AsyncGenerator<TeamMateSessionLedgerEvent> {
    const path = dispatcherTeamMateSessionLedgerPath(dispatcherId);
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: TeamMateSessionLedgerEvent;
        try {
          parsed = JSON.parse(line) as TeamMateSessionLedgerEvent;
        } catch {
          continue; // skip a torn/partial line rather than fail the read
        }
        yield parsed;
      }
    } catch (err) {
      if (!isNotFound(err)) {
        this.log.warn('TeamMate session ledger read failed', {
          dispatcher_id: dispatcherId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      lines.close();
    }
  }

  /**
   * Fold the ledger into one {@link TeamMateSessionRow} per `session_id` — the
   * recovery view a session can be reconstructed from, and the source the public
   * `history` surface filters/paginates over. Folds over a STREAMING reader so it
   * never buffers the whole append-only ledger: only one event is live at a time
   * and the rows hold bounded aggregates/previews (never the full assistant
   * text), so memory scales with the session count, not the ledger length or the
   * captured-output size (issue #182 final gate).
   */
  async materializeSessions(dispatcherId: string): Promise<TeamMateSessionRow[]> {
    const rows = new Map<string, TeamMateSessionRow>();
    for await (const event of this.streamEvents(dispatcherId)) {
      const existing = rows.get(event.session_id);
      const row = existing ?? newSessionRow(event);
      row.last_seen_at = Math.max(row.last_seen_at, event.timestamp);
      // Always advance the recovery metadata to the latest known values so a
      // resumed thread id / branch / status reflects the most recent event.
      row.status = event.status;
      row.checkpoint_kind = event.checkpoint_kind;
      row.session_ref = event.session_ref;
      row.intent = event.intent;
      row.worktree_slug = event.worktree_slug;
      row.worktree_path = event.worktree_path;
      row.branch = event.branch;
      row.base_ref = event.base_ref;
      row.source_repo = event.source_repo;
      row.source_cwd = event.source_cwd;
      row.cwd = event.cwd;
      row.leader_name = event.leader_name;
      if (event.display_name !== null) row.display_name = event.display_name;
      if (event.type === 'spawn' || event.type === 'send') {
        row.turn_count += 1;
        if (event.prompt_preview !== null) row.last_prompt_preview = event.prompt_preview;
      }
      if (event.type === 'settled' && event.assistant_preview !== null) {
        row.last_assistant_preview = event.assistant_preview;
      }
      if (event.type === 'close' && event.note !== null) {
        row.close_note_preview = preview(event.note);
      }
      rows.set(event.session_id, row);
    }
    return [...rows.values()].sort((a, b) => a.created_at - b.created_at);
  }
}

function newSessionRow(event: TeamMateSessionLedgerEvent): TeamMateSessionRow {
  return {
    session_id: event.session_id,
    dispatcher_id: event.dispatcher_id,
    name: event.name,
    display_name: event.display_name,
    role: event.role,
    team_id: event.team_id,
    leader_name: event.leader_name,
    agent_runtime: event.agent_runtime,
    checkpoint_kind: event.checkpoint_kind,
    session_ref: event.session_ref,
    source_repo: event.source_repo,
    source_cwd: event.source_cwd,
    cwd: event.cwd,
    worktree_slug: event.worktree_slug,
    worktree_path: event.worktree_path,
    branch: event.branch,
    base_ref: event.base_ref,
    intent: event.intent,
    created_at: event.timestamp,
    last_seen_at: event.timestamp,
    status: event.status,
    turn_count: 0,
    last_prompt_preview: null,
    last_assistant_preview: null,
    close_note_preview: null,
  };
}

function leaderNameFor(identity: TeamMateIdentity): string | null {
  if (identity.owner.kind === 'team') return identity.owner.leader_name;
  if (identity.role === 'team_leader') return identity.name;
  return null;
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_MAX ? collapsed : `${collapsed.slice(0, PREVIEW_HEAD)}...`;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
