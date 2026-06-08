import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dispatcherFeishuConfig,
  type DispatcherConfig,
  type DreamuxConfig,
} from '../config/config.js';
import { dispatcherStatusPath } from '../platform/paths.js';

/**
 * Warn sink for non-fatal recovery problems. `status.json` is server-owned,
 * rebuildable recovery state (issue #98): an incompatible/corrupt file must not
 * hard-fatal the server, but it must not be discarded silently either — the
 * loss of a resumable thread_id is observable. Defaults to `console.warn` so
 * direct callers and tests still surface it; the server passes its logger.
 */
export type StatusWarnLog = (message: string) => void;
const defaultStatusWarn: StatusWarnLog = (message) => console.warn(message);

export type DispatcherStatus =
  | 'declared'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped';

export interface DispatcherRow {
  dispatcher_id: string;
  bot_app_id: string;
  bot_secret_ref: string;
  thread_id: string | null;
  status: DispatcherStatus;
  enabled: 0 | 1;
  created_at: number;
  updated_at: number;
  last_started_at: number | null;
  last_ready_at: number | null;
  last_error: string | null;
  last_lost_thread_id: string | null;
}

export interface DispatcherCreateInput {
  dispatcher_id: string;
  bot_app_id: string;
  bot_secret_ref?: string;
  enabled?: 0 | 1 | boolean;
}

interface DispatcherStatusFile {
  version: 1;
  dispatcher_id: string;
  thread_id: string | null;
  status: DispatcherStatus;
  updated_at: number;
  last_started_at: number | null;
  last_ready_at: number | null;
  last_error: string | null;
  last_lost_thread_id: string | null;
}

export class DispatcherStore {
  private readonly rows = new Map<string, DispatcherRow>();
  private readonly seedDispatchers: readonly DispatcherConfig[];

  constructor(config: DreamuxConfig) {
    const now = Date.now();
    this.seedDispatchers = config.dispatchers;
    // Build in-memory rows from config only. Persisted per-dispatcher status
    // files are merged later by `hydrate()`: that read is async and must not
    // run in a constructor.
    for (const dispatcher of config.dispatchers) {
      this.rows.set(dispatcher.id, rowDefaults(dispatcher, now));
    }
  }

  /**
   * Merge each dispatcher's persisted `status.json` into its in-memory row.
   * Restores thread_id / status / timestamps across restarts. The server calls
   * this once during `start()`, before any dispatcher is launched. Idempotent.
   */
  async hydrate(warn: StatusWarnLog = defaultStatusWarn): Promise<void> {
    const now = Date.now();
    for (const dispatcher of this.seedDispatchers) {
      this.rows.set(dispatcher.id, await rowFromConfig(dispatcher, now, warn));
    }
  }

  create(input: DispatcherCreateInput): DispatcherRow {
    if (this.rows.has(input.dispatcher_id)) {
      throw new Error(`dispatcher '${input.dispatcher_id}' already exists`);
    }
    const duplicateApp = this.list().find(
      (row) => row.bot_app_id === input.bot_app_id,
    );
    if (duplicateApp !== undefined) {
      throw new Error(
        `bot_app_id '${input.bot_app_id}' is already used by dispatcher '${duplicateApp.dispatcher_id}'`,
      );
    }
    const now = Date.now();
    const row: DispatcherRow = {
      dispatcher_id: input.dispatcher_id,
      bot_app_id: input.bot_app_id,
      bot_secret_ref: input.bot_secret_ref ?? `config:${input.dispatcher_id}`,
      thread_id: null,
      status: 'declared',
      enabled: normalizeEnabled(input.enabled ?? 1),
      created_at: now,
      updated_at: now,
      last_started_at: null,
      last_ready_at: null,
      last_error: null,
      last_lost_thread_id: null,
    };
    this.rows.set(row.dispatcher_id, row);
    return { ...row };
  }

  upsert(input: DispatcherCreateInput): DispatcherRow {
    const existing = this.rows.get(input.dispatcher_id);
    if (existing === undefined) return this.create(input);
    const row: DispatcherRow = {
      ...existing,
      bot_app_id: input.bot_app_id,
      bot_secret_ref: input.bot_secret_ref ?? existing.bot_secret_ref,
      enabled: normalizeEnabled(input.enabled ?? existing.enabled),
      updated_at: Date.now(),
    };
    this.rows.set(row.dispatcher_id, row);
    return { ...row };
  }

  get(id: string): DispatcherRow | null {
    const row = this.rows.get(id);
    return row === undefined ? null : { ...row };
  }

  list(): DispatcherRow[] {
    return Array.from(this.rows.values())
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({ ...row }));
  }

  listEnabled(): DispatcherRow[] {
    return this.list().filter((row) => row.enabled === 1);
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
    await rm(dispatcherStatusPath(id), { force: true });
  }

  async setStatus(
    id: string,
    status: DispatcherStatus,
    extras: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    } = {},
  ): Promise<void> {
    const row = this.mustRow(id);
    row.status = status;
    row.updated_at = Date.now();
    if ('last_error' in extras) row.last_error = extras.last_error ?? null;
    if (extras.last_started_at !== undefined) {
      row.last_started_at = extras.last_started_at;
    }
    if (extras.last_ready_at !== undefined) {
      row.last_ready_at = extras.last_ready_at;
    }
    await this.persist(row);
  }

  async setThreadId(id: string, threadId: string): Promise<void> {
    const row = this.mustRow(id);
    row.thread_id = threadId;
    row.updated_at = Date.now();
    await this.persist(row);
  }

  async recordLostThread(
    id: string,
    lostThreadId: string,
    newThreadId: string,
    error: string,
  ): Promise<void> {
    const row = this.mustRow(id);
    row.thread_id = newThreadId;
    row.last_lost_thread_id = lostThreadId;
    row.last_error = error;
    row.updated_at = Date.now();
    await this.persist(row);
  }

  private mustRow(id: string): DispatcherRow {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no dispatcher '${id}'`);
    return row;
  }

  private async persist(row: DispatcherRow): Promise<void> {
    await mkdir(dirname(dispatcherStatusPath(row.dispatcher_id)), {
      recursive: true,
    });
    const status: DispatcherStatusFile = {
      version: 1,
      dispatcher_id: row.dispatcher_id,
      thread_id: row.thread_id,
      status: row.status,
      updated_at: row.updated_at,
      last_started_at: row.last_started_at,
      last_ready_at: row.last_ready_at,
      last_error: row.last_error,
      last_lost_thread_id: row.last_lost_thread_id,
    };
    await writeFile(
      dispatcherStatusPath(row.dispatcher_id),
      `${JSON.stringify(status, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

/** Config-only row (no persisted status); used before `hydrate()` runs. */
function rowDefaults(config: DispatcherConfig, now: number): DispatcherRow {
  const feishu = dispatcherFeishuConfig(config);
  return {
    dispatcher_id: config.id,
    bot_app_id: feishu.app_id,
    bot_secret_ref: `config:${config.id}`,
    thread_id: null,
    status: 'declared',
    enabled: config.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
    last_started_at: null,
    last_ready_at: null,
    last_error: null,
    last_lost_thread_id: null,
  };
}

async function rowFromConfig(
  config: DispatcherConfig,
  now: number,
  warn: StatusWarnLog,
): Promise<DispatcherRow> {
  const status = await readStatusFile(config.id, warn);
  return {
    ...rowDefaults(config, now),
    thread_id: status?.thread_id ?? null,
    status: status?.status ?? 'declared',
    created_at: status?.updated_at ?? now,
    updated_at: status?.updated_at ?? now,
    last_started_at: status?.last_started_at ?? null,
    last_ready_at: status?.last_ready_at ?? null,
    last_error: status?.last_error ?? null,
    last_lost_thread_id: status?.last_lost_thread_id ?? null,
  };
}

async function readStatusFile(
  id: string,
  warn: StatusWarnLog,
): Promise<DispatcherStatusFile | null> {
  const path = dispatcherStatusPath(id);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A readable file that fails for any other reason: rebuild, but say so.
    warn(
      `dispatcher '${id}' status file ${path} could not be read ` +
        `(${errMessage(err)}); rebuilding dispatcher status from config defaults.`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(
      `dispatcher '${id}' status file ${path} is not valid JSON ` +
        `(${errMessage(err)}); rebuilding dispatcher status; ` +
        'a saved thread_id may not be resumed.',
    );
    return null;
  }

  // Valid JSON that is not an object (e.g. `null`) would crash the field reads
  // below; treat it like any other corrupt status file.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(
      `dispatcher '${id}' status file ${path} ignored: top-level must be an ` +
        'object; rebuilding dispatcher status from config defaults; ' +
        'a saved thread_id will not be resumed.',
    );
    return null;
  }
  const raw = parsed as Partial<DispatcherStatusFile>;

  if (raw.version !== 1 || raw.dispatcher_id !== id) {
    const reason =
      raw.version !== 1
        ? `unsupported version (found ${raw.version === undefined ? 'missing' : JSON.stringify(raw.version)}, expected 1)`
        : `dispatcher id mismatch (file recorded ${JSON.stringify(raw.dispatcher_id)})`;
    warn(
      `dispatcher '${id}' status file ${path} ignored: ${reason}; ` +
        'rebuilding dispatcher status from config defaults; ' +
        'a saved thread_id will not be resumed.',
    );
    return null;
  }

  // A correctly-versioned, id-matched file can still carry malformed key
  // fields. Silently coercing them (a numeric thread_id → null, a bad status →
  // 'declared', a non-finite updated_at → now) would lose a resumable thread or
  // change status without a trace. Treat a wrong-typed field as a corrupt file:
  // warn + rebuild. An *absent* nullable field is benign and defaults to null;
  // the required `status` / `updated_at` must be present and well-typed.
  if (
    !isNullableString(raw.thread_id) ||
    !isDispatcherStatus(raw.status) ||
    !(typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at)) ||
    !isNullableNumber(raw.last_started_at) ||
    !isNullableNumber(raw.last_ready_at) ||
    !isNullableString(raw.last_error) ||
    !isNullableString(raw.last_lost_thread_id)
  ) {
    warn(
      `dispatcher '${id}' status file ${path} ignored: malformed v1 fields; ` +
        'rebuilding dispatcher status from config defaults; ' +
        'a saved thread_id will not be resumed.',
    );
    return null;
  }

  return {
    version: 1,
    dispatcher_id: id,
    thread_id: raw.thread_id ?? null,
    status: raw.status,
    updated_at: raw.updated_at,
    last_started_at: raw.last_started_at ?? null,
    last_ready_at: raw.last_ready_at ?? null,
    last_error: raw.last_error ?? null,
    last_lost_thread_id: raw.last_lost_thread_id ?? null,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Accept an absent (defaults to null), explicit null, or string field. */
function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** Accept an absent (defaults to null), explicit null, or finite-number field. */
function isNullableNumber(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isDispatcherStatus(value: unknown): value is DispatcherStatus {
  return value === 'declared' ||
    value === 'starting' ||
    value === 'ready' ||
    value === 'degraded' ||
    value === 'stopping' ||
    value === 'stopped';
}

function normalizeEnabled(value: 0 | 1 | boolean): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}
