import {
  type DispatcherConfig,
  type DreamuxConfig,
} from '../config/config.js';

export type DispatcherStatus = 'declared';

export interface DispatcherRow {
  dispatcher_id: string;
  /**
   * The dispatcher's neutral, provider-reported channel identity (issue #209
   * de-leak) — the primary channel's `getIdentity`, surfaced for status display.
   * Core never interprets it and never names the channel provider's config
   * fields. Empty string when the primary channel reports no identity.
   */
  channel_identity: string;
  status: DispatcherStatus;
  enabled: 0 | 1;
  created_at: number;
  updated_at: number;
}

export interface DispatcherCreateInput {
  dispatcher_id: string;
  channel_identity: string;
  enabled?: 0 | 1 | boolean;
}

export class DispatcherStore {
  private readonly rows = new Map<string, DispatcherRow>();

  constructor(config: DreamuxConfig) {
    const now = Date.now();
    for (const dispatcher of config.dispatchers) {
      this.rows.set(dispatcher.id, rowDefaults(dispatcher, now));
    }
  }

  create(input: DispatcherCreateInput): DispatcherRow {
    if (this.rows.has(input.dispatcher_id)) {
      throw new Error(`dispatcher '${input.dispatcher_id}' already exists`);
    }
    const now = Date.now();
    const row: DispatcherRow = {
      dispatcher_id: input.dispatcher_id,
      channel_identity: input.channel_identity,
      status: 'declared',
      enabled: normalizeEnabled(input.enabled ?? 1),
      created_at: now,
      updated_at: now,
    };
    this.rows.set(row.dispatcher_id, row);
    return { ...row };
  }

  upsert(input: DispatcherCreateInput): DispatcherRow {
    const existing = this.rows.get(input.dispatcher_id);
    if (existing === undefined) return this.create(input);
    const row: DispatcherRow = {
      ...existing,
      channel_identity: input.channel_identity,
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
  }
}

/** Config-only row; runtime state lives on the dispatcher root identity. */
function rowDefaults(config: DispatcherConfig, now: number): DispatcherRow {
  // Best-effort identity: seed the dispatcher's primary (first) channel's
  // neutral, provider-reported identity (issue #209 de-leak). Core never reaches
  // into a channel provider's config fields — the identity is what that channel's
  // `getIdentity` reported at config-load. Fail-soft: an unrunnable shape fails
  // loud at the dispatcher service launch guard, not here during construction.
  return {
    dispatcher_id: config.id,
    channel_identity: config.channels[0]?.identity ?? '',
    status: 'declared',
    enabled: config.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
}

function normalizeEnabled(value: 0 | 1 | boolean): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}
