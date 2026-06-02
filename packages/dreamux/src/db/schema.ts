import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_USER_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

export interface OpenDbOptions {
  path: string;
}

export function openDatabase(opts: OpenDbOptions): Database.Database {
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrateIfNeeded(db);
  return db;
}

function migrateIfNeeded(db: Database.Database): void {
  const row = db.pragma('user_version', { simple: true }) as number;
  if (row >= CURRENT_USER_VERSION) return;

  const tx = db.transaction(() => {
    if (row < 1) {
      const sql = readFileSync(join(migrationsDir, '0001_init.sql'), 'utf8');
      db.exec(sql);
    }
    db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
  });
  tx();
}
