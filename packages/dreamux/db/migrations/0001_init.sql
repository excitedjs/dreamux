-- dreamux MVP schema (issue excitedjs/dreamux#2)
-- Version tracked via PRAGMA user_version, not a schema_version table.

CREATE TABLE dispatchers (
  dispatcher_id        TEXT PRIMARY KEY,
  bot_app_id           TEXT NOT NULL UNIQUE,
  bot_secret_ref       TEXT NOT NULL,
  codex_args_json      TEXT NOT NULL DEFAULT '{}',
  codex_cwd            TEXT,
  thread_id            TEXT,
  status               TEXT NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared','starting','ready','degraded','stopping','stopped')),
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_started_at      INTEGER,
  last_ready_at        INTEGER,
  last_error           TEXT,
  last_lost_thread_id  TEXT
);

CREATE TABLE inbound_buffer (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatcher_id            TEXT NOT NULL REFERENCES dispatchers(dispatcher_id),
  source_chat_id           TEXT NOT NULL,
  source_message_id        TEXT,
  sender_id                TEXT,
  feishu_event_json        TEXT NOT NULL,
  parsed_text              TEXT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','awaiting_outbound',
                     'completed','outbound_failed','failed','unknown')),
  codex_turn_id            TEXT,
  assistant_text           TEXT,
  feishu_message_ids_json  TEXT,
  outbound_error           TEXT,
  received_at              INTEGER NOT NULL,
  started_at               INTEGER,
  completed_at             INTEGER,
  failed_at                INTEGER,
  error                    TEXT
);

CREATE INDEX idx_inbound_dispatcher_state
  ON inbound_buffer(dispatcher_id, state, id);

CREATE UNIQUE INDEX idx_inbound_message_dedupe
  ON inbound_buffer(dispatcher_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
