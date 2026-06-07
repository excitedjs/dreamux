import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  dispatcherTeamMateHistoryPath,
  dispatcherTeamMateIdentitiesDir,
  dispatcherTeamMateIdentityPath,
} from '../../runtime/paths.js';
import {
  validateTeamMateName,
  type TeamMateHistoryEvent,
  type TeamMateHistoryEventType,
  type TeamMateIdentity,
  type TeamMateIdentityStatus,
} from './types.js';
import type { AgentRuntimeResumeCheckpoint } from '../../agent-runtime/index.js';

export interface TeamMateIdentityStoreLog {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface TeamMateIdentityCreateInput {
  dispatcherId: string;
  name: string;
  providerRef: string;
  cwd: string;
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
  status?: TeamMateIdentityStatus;
}

export interface TeamMateIdentityUpdateInput {
  providerRef?: string;
  cwd?: string;
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
  status?: TeamMateIdentityStatus;
  lastError?: string | null;
  closedAt?: number | null;
  closeNote?: string | null;
}

export interface TeamMateHistoryAppendInput {
  type: TeamMateHistoryEventType;
  prompt?: string | null;
  turnId?: string | null;
  note?: string | null;
}

export class TeamMateIdentityStore {
  constructor(private readonly log: TeamMateIdentityStoreLog) {}

  async get(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateIdentity | null> {
    validateTeamMateName(name);
    try {
      return readIdentity(
        dispatcherId,
        name,
        await readFile(dispatcherTeamMateIdentityPath(dispatcherId, name), 'utf8'),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dispatcherId: string): Promise<TeamMateIdentity[]> {
    let entries: string[];
    try {
      entries = await readdir(dispatcherTeamMateIdentitiesDir(dispatcherId));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const identities: TeamMateIdentity[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      try {
        const identity = await this.get(dispatcherId, name);
        if (identity !== null) identities.push(identity);
      } catch (err) {
        this.log.warn('skipping unreadable TeamMate identity', {
          dispatcher_id: dispatcherId,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return identities;
  }

  async create(input: TeamMateIdentityCreateInput): Promise<TeamMateIdentity> {
    validateTeamMateName(input.name);
    const now = Date.now();
    const identity: TeamMateIdentity = {
      version: 1,
      dispatcher_id: input.dispatcherId,
      name: input.name,
      provider_ref: input.providerRef,
      cwd: input.cwd,
      created_at: now,
      updated_at: now,
      status: input.status ?? 'starting',
      checkpoint: input.checkpoint ?? null,
      last_error: null,
      closed_at: null,
      close_note: null,
    };
    await this.write(identity);
    return identity;
  }

  async update(
    identity: TeamMateIdentity,
    input: TeamMateIdentityUpdateInput,
  ): Promise<TeamMateIdentity> {
    const updated: TeamMateIdentity = {
      ...identity,
      ...(input.providerRef !== undefined ? { provider_ref: input.providerRef } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
      ...(input.closedAt !== undefined ? { closed_at: input.closedAt } : {}),
      ...(input.closeNote !== undefined ? { close_note: input.closeNote } : {}),
      updated_at: Date.now(),
    };
    await this.write(updated);
    return updated;
  }

  async appendHistory(
    identity: TeamMateIdentity,
    input: TeamMateHistoryAppendInput,
  ): Promise<void> {
    try {
      const event: TeamMateHistoryEvent = {
        version: 1,
        event_id: Date.now(),
        timestamp: Date.now(),
        dispatcher_id: identity.dispatcher_id,
        name: identity.name,
        type: input.type,
        provider_ref: identity.provider_ref,
        cwd: identity.cwd,
        checkpoint: identity.checkpoint,
        prompt_preview:
          input.prompt !== undefined && input.prompt !== null
            ? preview(input.prompt)
            : null,
        turn_id: input.turnId ?? null,
        status: identity.status,
        note: input.note ?? null,
      };
      const path = dispatcherTeamMateHistoryPath(
        identity.dispatcher_id,
        identity.name,
      );
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch (err) {
      this.log.warn('TeamMate history append failed', {
        dispatcher_id: identity.dispatcher_id,
        name: identity.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async history(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateHistoryEvent[]> {
    validateTeamMateName(name);
    let raw: string;
    try {
      raw = await readFile(dispatcherTeamMateHistoryPath(dispatcherId, name), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const events: TeamMateHistoryEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      events.push(readHistoryEvent(dispatcherId, name, JSON.parse(line) as unknown));
    }
    return events.sort((a, b) => a.timestamp - b.timestamp || a.event_id - b.event_id);
  }

  private async write(identity: TeamMateIdentity): Promise<void> {
    const path = dispatcherTeamMateIdentityPath(
      identity.dispatcher_id,
      identity.name,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function readIdentity(
  dispatcherId: string,
  name: string,
  raw: string,
): TeamMateIdentity {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    value['version'] !== 1 ||
    value['dispatcher_id'] !== dispatcherId ||
    value['name'] !== name ||
    typeof value['provider_ref'] !== 'string' ||
    typeof value['cwd'] !== 'string'
  ) {
    throw new Error(`invalid TeamMate identity ${JSON.stringify(name)}`);
  }
  return value as unknown as TeamMateIdentity;
}

function readHistoryEvent(
  dispatcherId: string,
  name: string,
  value: unknown,
): TeamMateHistoryEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid TeamMate history event');
  }
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    record['dispatcher_id'] !== dispatcherId ||
    record['name'] !== name ||
    typeof record['timestamp'] !== 'number' ||
    typeof record['event_id'] !== 'number'
  ) {
    throw new Error(`invalid TeamMate history event for ${JSON.stringify(name)}`);
  }
  return record as unknown as TeamMateHistoryEvent;
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
