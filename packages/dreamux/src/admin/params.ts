import type { Server } from '../server.js';
import { validateDispatcherId } from '../state/dispatcher-id.js';
import type {
  AgentEntityHistoryQuery,
  AgentEntityIdentityStatus,
} from '../service/agent-entity/types.js';
import type { TeamMateWorktreeRequest } from '../service/teammate-collection/types.js';
import { AdminError } from './protocol.js';

export function mustString(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  if (params === undefined || typeof params[key] !== 'string') {
    throw new AdminError('BAD_REQUEST', `missing or non-string param '${key}'`);
  }
  return params[key] as string;
}

export function mustNonEmptyString(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = mustString(params, key);
  if (value === '') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a non-empty string`);
  }
  return value;
}

export function mustRecord(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = params?.[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

export function mustDispatcherId(
  params: Record<string, unknown> | undefined,
): string {
  const id = mustString(params, 'dispatcher_id');
  try {
    return validateDispatcherId(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdminError('BAD_REQUEST', message);
  }
}

export function optionalString(
  params: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (params === undefined) return null;
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a string`);
  }
  return v;
}

export function optionalNonBlankString(
  params: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value.trim() === '') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a non-empty string`);
  }
  return value;
}

export function repoRequest(
  params: Record<string, unknown> | undefined,
  key: string,
): { cwd: string | null; worktree: TeamMateWorktreeRequest | null } | null {
  if (params === undefined) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const mode = mustString(obj, 'mode');
  if (mode !== 'reuse-cwd' && mode !== 'managed') {
    throw new AdminError(
      'BAD_REQUEST',
      `param '${key}.mode' must be 'reuse-cwd' or 'managed'`,
    );
  }
  const cwd = optionalString(obj, 'path');
  if (mode === 'reuse-cwd') {
    return { cwd, worktree: { mode: 'reuse-cwd' } };
  }
  const cleanup = optionalString(obj, 'cleanup');
  if (cleanup !== null && cleanup !== 'keep' && cleanup !== 'delete-on-close') {
    throw new AdminError(
      'BAD_REQUEST',
      `param '${key}.cleanup' must be 'keep' or 'delete-on-close'`,
    );
  }
  return {
    cwd,
    worktree: {
      mode,
      ...optionalStringProp(obj, 'slug'),
      ...optionalStringProp(obj, 'base_ref'),
      ...optionalStringProp(obj, 'branch'),
      ...(cleanup !== null ? { cleanup } : {}),
    },
  };
}

export function historyQuery(
  params: Record<string, unknown> | undefined,
): AgentEntityHistoryQuery {
  const name = optionalString(params, 'name');
  const status = optionalTeammateStatus(params, 'status');
  const agentRuntime = optionalString(params, 'agent_runtime');
  const repo = optionalString(params, 'repo');
  const grep = optionalString(params, 'grep');
  const since = optionalInteger(params, 'since');
  const until = optionalInteger(params, 'until');
  const cursor = optionalString(params, 'cursor');
  const limit = optionalInteger(params, 'limit');
  return {
    ...(name !== null ? { name } : {}),
    ...(status !== null ? { status } : {}),
    ...(agentRuntime !== null ? { agentRuntime } : {}),
    ...(repo !== null ? { repo } : {}),
    ...(grep !== null ? { grep } : {}),
    ...(since !== null ? { since } : {}),
    ...(until !== null ? { until } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

export function optionalTeamStatus(
  params: Record<string, unknown> | undefined,
  key: string,
): 'starting' | 'running' | 'closed' | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (value === 'starting' || value === 'running' || value === 'closed') return value;
  throw new AdminError(
    'BAD_REQUEST',
    `param '${key}' must be starting, running, or closed`,
  );
}

export function optionalInteger(
  params: Record<string, unknown> | undefined,
  key: string,
): number | null {
  if (params === undefined) return null;
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an integer`);
  }
  return value as number;
}

export function optionalStringField(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, string> {
  const value = optionalString(params, key);
  return value === null ? {} : { [key]: value };
}

export function optionalNullableStringField(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, string | null> {
  if (params === undefined || !(key in params)) return {};
  const value = params[key];
  if (value === null) return { [key]: null };
  if (typeof value !== 'string') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a string or null`);
  }
  return { [key]: value };
}

export function optionalBooleanField(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, boolean> {
  if (params === undefined || !(key in params)) return {};
  const value = params[key];
  if (typeof value !== 'boolean') {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be a boolean`);
  }
  return { [key]: value };
}

export function optionalRecordField(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, Record<string, unknown>> {
  if (params === undefined || !(key in params)) return {};
  const value = params[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object`);
  }
  return { [key]: value as Record<string, unknown> };
}

export function optionalNullableRecordField(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, Record<string, unknown> | null> {
  if (params === undefined || !(key in params)) return {};
  const value = params[key];
  if (value === null) return { [key]: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminError('BAD_REQUEST', `param '${key}' must be an object or null`);
  }
  return { [key]: value as Record<string, unknown> };
}

export function mustExistingDispatcher(server: Server, id: string): void {
  const row = server.repos.dispatchers.get(id);
  if (row === null) {
    throw new AdminError('DISPATCHER_NOT_FOUND', `no dispatcher with id '${id}'`);
  }
}

export function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function optionalTeammateStatus(
  params: Record<string, unknown> | undefined,
  key: string,
): AgentEntityIdentityStatus | null {
  const value = optionalString(params, key);
  if (value === null) return null;
  if (
    value === 'starting' ||
    value === 'running' ||
    value === 'degraded' ||
    value === 'closed' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new AdminError(
    'BAD_REQUEST',
    `param '${key}' must be starting, running, degraded, closed, or stopped`,
  );
}

function optionalStringProp(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = optionalString(params, key);
  return value === null ? {} : { [key]: value };
}
