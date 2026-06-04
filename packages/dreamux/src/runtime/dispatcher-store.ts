import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { DispatcherConfig, DreamuxConfig } from './config.js';
import { dispatcherStatusPath } from './paths.js';

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
  codex_args_json: string;
  codex_cwd: string | null;
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
  codex_args_json?: string;
  codex_cwd?: string | null;
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

  constructor(config: DreamuxConfig) {
    const now = Date.now();
    for (const dispatcher of config.dispatchers) {
      const row = rowFromConfig(dispatcher, now);
      this.rows.set(row.dispatcher_id, row);
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
      codex_args_json: input.codex_args_json ?? '{}',
      codex_cwd: input.codex_cwd ?? null,
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
      codex_args_json: input.codex_args_json ?? existing.codex_args_json,
      codex_cwd: input.codex_cwd ?? existing.codex_cwd,
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

  remove(id: string): void {
    this.rows.delete(id);
    rmSync(dispatcherStatusPath(id), { force: true });
  }

  setStatus(
    id: string,
    status: DispatcherStatus,
    extras: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    } = {},
  ): void {
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
    this.persist(row);
  }

  setThreadId(id: string, threadId: string): void {
    const row = this.mustRow(id);
    row.thread_id = threadId;
    row.updated_at = Date.now();
    this.persist(row);
  }

  recordLostThread(
    id: string,
    lostThreadId: string,
    newThreadId: string,
    error: string,
  ): void {
    const row = this.mustRow(id);
    row.thread_id = newThreadId;
    row.last_lost_thread_id = lostThreadId;
    row.last_error = error;
    row.updated_at = Date.now();
    this.persist(row);
  }

  private mustRow(id: string): DispatcherRow {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`no dispatcher '${id}'`);
    return row;
  }

  private persist(row: DispatcherRow): void {
    mkdirSync(dirname(dispatcherStatusPath(row.dispatcher_id)), {
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
    writeFileSync(
      dispatcherStatusPath(row.dispatcher_id),
      `${JSON.stringify(status, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

function rowFromConfig(config: DispatcherConfig, now: number): DispatcherRow {
  const status = readStatusFile(config.id);
  return {
    dispatcher_id: config.id,
    bot_app_id: config.feishu.app_id,
    bot_secret_ref: `config:${config.id}`,
    codex_args_json: dispatcherCodexArgsJson(config),
    codex_cwd: config.cwd,
    thread_id: status?.thread_id ?? null,
    status: status?.status ?? 'declared',
    enabled: config.enabled ? 1 : 0,
    created_at: status?.updated_at ?? now,
    updated_at: status?.updated_at ?? now,
    last_started_at: status?.last_started_at ?? null,
    last_ready_at: status?.last_ready_at ?? null,
    last_error: status?.last_error ?? null,
    last_lost_thread_id: status?.last_lost_thread_id ?? null,
  };
}

function dispatcherCodexArgsJson(config: DispatcherConfig): string {
  const raw: Record<string, unknown> = {};
  if (config.codex.approval_policy !== null) {
    raw['approvalPolicy'] = config.codex.approval_policy;
  }
  if (config.codex.sandbox_mode !== null) {
    raw['sandboxMode'] = config.codex.sandbox_mode;
  }
  if (config.codex.extra_args.length > 0) {
    raw['extraArgs'] = config.codex.extra_args;
  }
  // codex.extra_env is applied to the child process environment, not encoded
  // into CLI args.
  return JSON.stringify(raw);
}

function readStatusFile(id: string): DispatcherStatusFile | null {
  const path = dispatcherStatusPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatcherStatusFile>;
    if (raw.version !== 1 || raw.dispatcher_id !== id) return null;
    return {
      version: 1,
      dispatcher_id: id,
      thread_id: typeof raw.thread_id === 'string' ? raw.thread_id : null,
      status: isDispatcherStatus(raw.status) ? raw.status : 'declared',
      updated_at:
        typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at)
          ? raw.updated_at
          : Date.now(),
      last_started_at: numberOrNull(raw.last_started_at),
      last_ready_at: numberOrNull(raw.last_ready_at),
      last_error: stringOrNull(raw.last_error),
      last_lost_thread_id: stringOrNull(raw.last_lost_thread_id),
    };
  } catch {
    return null;
  }
}

function isDispatcherStatus(value: unknown): value is DispatcherStatus {
  return value === 'declared' ||
    value === 'starting' ||
    value === 'ready' ||
    value === 'degraded' ||
    value === 'stopping' ||
    value === 'stopped';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeEnabled(value: 0 | 1 | boolean): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}
