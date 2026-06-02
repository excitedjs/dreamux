-- Server-owned Codex teammate daemons.

CREATE TABLE codex_teammates (
  name                 TEXT PRIMARY KEY,
  cwd                  TEXT NOT NULL,
  codex_args_json      TEXT NOT NULL DEFAULT '{}',
  thread_id            TEXT,
  status               TEXT NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared','starting','ready','degraded','stopping','stopped')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_started_at      INTEGER,
  last_ready_at        INTEGER,
  last_error           TEXT,
  last_turn_id         TEXT,
  last_assistant_text  TEXT
);
