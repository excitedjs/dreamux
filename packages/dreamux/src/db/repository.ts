import type Database from 'better-sqlite3';
import type {
  DispatcherCreateInput,
  DispatcherRow,
  DispatcherStatus,
  InboundCreateInput,
  InboundRow,
  InboundState,
} from './types.js';

const DISPATCHER_COLUMNS = `
  dispatcher_id, bot_app_id, bot_secret_ref, codex_args_json, codex_cwd,
  thread_id, status, enabled, created_at, updated_at,
  last_started_at, last_ready_at, last_error, last_lost_thread_id
`;

const INBOUND_COLUMNS = `
  id, dispatcher_id, source_chat_id, source_message_id, sender_id,
  feishu_event_json, parsed_text, state, codex_turn_id, assistant_text,
  feishu_message_ids_json, outbound_error, received_at, started_at,
  completed_at, failed_at, error
`;

export class DispatcherRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: DispatcherCreateInput): DispatcherRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO dispatchers (
          dispatcher_id, bot_app_id, bot_secret_ref, codex_args_json,
          codex_cwd, status, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'declared', 1, ?, ?)`,
      )
      .run(
        input.dispatcher_id,
        input.bot_app_id,
        input.bot_secret_ref,
        input.codex_args_json ?? '{}',
        input.codex_cwd ?? null,
        now,
        now,
      );
    return this.get(input.dispatcher_id)!;
  }

  get(id: string): DispatcherRow | null {
    const row = this.db
      .prepare(`SELECT ${DISPATCHER_COLUMNS} FROM dispatchers WHERE dispatcher_id = ?`)
      .get(id) as DispatcherRow | undefined;
    return row ?? null;
  }

  list(): DispatcherRow[] {
    return this.db
      .prepare(`SELECT ${DISPATCHER_COLUMNS} FROM dispatchers ORDER BY created_at ASC`)
      .all() as DispatcherRow[];
  }

  listEnabled(): DispatcherRow[] {
    return this.db
      .prepare(
        `SELECT ${DISPATCHER_COLUMNS} FROM dispatchers WHERE enabled = 1 ORDER BY created_at ASC`,
      )
      .all() as DispatcherRow[];
  }

  remove(id: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM inbound_buffer WHERE dispatcher_id = ?`)
        .run(id);
      this.db.prepare(`DELETE FROM dispatchers WHERE dispatcher_id = ?`).run(id);
    });
    tx();
  }

  setStatus(
    id: string,
    status: DispatcherStatus,
    extras: { last_error?: string | null; last_started_at?: number; last_ready_at?: number } = {},
  ): void {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const values: unknown[] = [status, Date.now()];
    if ('last_error' in extras) {
      fields.push('last_error = ?');
      values.push(extras.last_error ?? null);
    }
    if (extras.last_started_at !== undefined) {
      fields.push('last_started_at = ?');
      values.push(extras.last_started_at);
    }
    if (extras.last_ready_at !== undefined) {
      fields.push('last_ready_at = ?');
      values.push(extras.last_ready_at);
    }
    values.push(id);
    this.db
      .prepare(`UPDATE dispatchers SET ${fields.join(', ')} WHERE dispatcher_id = ?`)
      .run(...values);
  }

  setThreadId(id: string, threadId: string): void {
    this.db
      .prepare(
        `UPDATE dispatchers SET thread_id = ?, updated_at = ? WHERE dispatcher_id = ?`,
      )
      .run(threadId, Date.now(), id);
  }

  recordLostThread(id: string, lostThreadId: string, newThreadId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE dispatchers
         SET thread_id = ?, last_lost_thread_id = ?, last_error = ?, updated_at = ?
         WHERE dispatcher_id = ?`,
      )
      .run(newThreadId, lostThreadId, error, Date.now(), id);
  }
}

export class InboundRepo {
  constructor(private readonly db: Database.Database) {}

  /** Returns null when this message was already buffered (dedupe). */
  enqueue(input: InboundCreateInput): InboundRow | null {
    try {
      const now = Date.now();
      const result = this.db
        .prepare(
          `INSERT INTO inbound_buffer (
            dispatcher_id, source_chat_id, source_message_id, sender_id,
            feishu_event_json, parsed_text, state, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          input.dispatcher_id,
          input.source_chat_id,
          input.source_message_id,
          input.sender_id,
          input.feishu_event_json,
          input.parsed_text,
          now,
        );
      return this.getById(Number(result.lastInsertRowid));
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  getById(id: number): InboundRow | null {
    const row = this.db
      .prepare(`SELECT ${INBOUND_COLUMNS} FROM inbound_buffer WHERE id = ?`)
      .get(id) as InboundRow | undefined;
    return row ?? null;
  }

  /** Pull the oldest queued row for a dispatcher; returns null if none. */
  takeNextQueued(dispatcherId: string): InboundRow | null {
    const row = this.db
      .prepare(
        `SELECT ${INBOUND_COLUMNS} FROM inbound_buffer
         WHERE dispatcher_id = ? AND state = 'queued'
         ORDER BY id ASC LIMIT 1`,
      )
      .get(dispatcherId) as InboundRow | undefined;
    return row ?? null;
  }

  markRunning(id: number, turnId: string | null): void {
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'running', started_at = ?, codex_turn_id = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(Date.now(), turnId, id);
  }

  markAwaitingOutbound(id: number, assistantText: string): void {
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'awaiting_outbound', assistant_text = ?
         WHERE id = ?`,
      )
      .run(assistantText, id);
  }

  markCompleted(id: number, feishuMessageIds: string[]): void {
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'completed', feishu_message_ids_json = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(feishuMessageIds), Date.now(), id);
  }

  markOutboundFailed(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'outbound_failed', outbound_error = ?
         WHERE id = ?`,
      )
      .run(error, id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'failed', error = ?, failed_at = ?
         WHERE id = ?`,
      )
      .run(error, Date.now(), id);
  }

  /** Crash recovery: anything still 'running' from a previous server life. */
  markRunningAsUnknown(dispatcherId: string): InboundRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${INBOUND_COLUMNS} FROM inbound_buffer
         WHERE dispatcher_id = ? AND state = 'running'`,
      )
      .all(dispatcherId) as InboundRow[];
    if (rows.length === 0) return [];
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE inbound_buffer
         SET state = 'unknown', error = 'server restarted while turn was running', failed_at = ?
         WHERE dispatcher_id = ? AND state = 'running'`,
      )
      .run(now, dispatcherId);
    return rows;
  }

  /** Crash recovery: turn finished but outbound never completed (safe to retry). */
  listAwaitingOrFailedOutbound(dispatcherId: string): InboundRow[] {
    return this.db
      .prepare(
        `SELECT ${INBOUND_COLUMNS} FROM inbound_buffer
         WHERE dispatcher_id = ? AND state IN ('awaiting_outbound','outbound_failed')
         ORDER BY id ASC`,
      )
      .all(dispatcherId) as InboundRow[];
  }

  countByState(dispatcherId: string): Record<InboundState, number> {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM inbound_buffer
         WHERE dispatcher_id = ? GROUP BY state`,
      )
      .all(dispatcherId) as Array<{ state: InboundState; n: number }>;
    const out: Record<InboundState, number> = {
      queued: 0,
      running: 0,
      awaiting_outbound: 0,
      completed: 0,
      outbound_failed: 0,
      failed: 0,
      unknown: 0,
    };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
