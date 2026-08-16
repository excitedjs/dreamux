import { readdir } from 'node:fs/promises';

import { writeFileExclusiveAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { JsonDocumentStore } from '../../platform/json-document-store.js';
import {
  validateWorkflowRunId,
  workflowRunRecordPath,
  workflowScopeDir,
  type WorkflowScopePathInput,
} from '../../platform/paths.js';
import { isRecord } from './run-support.js';
import type {
  WorkflowAgentRecord,
  WorkflowAgentStatus,
  WorkflowCallerKind,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from './types.js';

const RUN_STATUSES = new Set<WorkflowRunStatus>([
  'running',
  'completed',
  'failed',
  'stopped',
]);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>(['queued', ...RUN_STATUSES]);
const CALLER_KINDS = new Set<WorkflowCallerKind>([
  'dispatcher',
  'team_leader',
]);

/** Scope-local record store. Journal events are owned separately by WorkflowJournal. */
export class WorkflowRunStore {
  private readonly documents = new JsonDocumentStore<WorkflowRunRecord | null>({
    version: 1,
    empty: () => null,
    parse: (raw, ctx) => parseRecord(raw, this.scope, ctx.path),
  });

  constructor(private readonly scope: WorkflowScopePathInput) {}

  async create(record: WorkflowRunRecord): Promise<void> {
    assertRecordScope(record, this.scope);
    const path = this.path(record.run_id);
    const published = await writeFileExclusiveAtomic(
      path,
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (!published) {
      throw new Error(`workflow run ${JSON.stringify(record.run_id)} already exists`);
    }
  }

  async get(runId: string): Promise<WorkflowRunRecord | null> {
    return this.documents.read(this.path(runId));
  }

  async write(record: WorkflowRunRecord): Promise<void> {
    assertRecordScope(record, this.scope);
    await this.documents.write(this.path(record.run_id), record);
  }

  async list(): Promise<WorkflowRunRecord[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(workflowScopeDir(this.scope), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const records: WorkflowRunRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const record = await this.get(entry.name);
      if (record !== null) records.push(record);
    }
    return records.sort(
      (a, b) => b.created_at - a.created_at || a.run_id.localeCompare(b.run_id),
    );
  }

  private path(runId: string): string {
    return workflowRunRecordPath({
      ...this.scope,
      runId: validateWorkflowRunId(runId),
    });
  }
}

function parseRecord(
  raw: unknown,
  scope: WorkflowScopePathInput,
  path: string,
): WorkflowRunRecord {
  if (!isRecord(raw)) throw new Error(`invalid workflow record ${path}`);
  if (raw['version'] !== 1) {
    throw new Error(`unsupported workflow record version in ${path}`);
  }
  const runId = stringField(raw, 'run_id', path);
  validateWorkflowRunId(runId);
  const dispatcherId = stringField(raw, 'dispatcher_id', path);
  const teamId = nullableStringField(raw, 'team_id', path);
  const callerKind = raw['caller_kind'];
  const status = raw['status'];
  if (!CALLER_KINDS.has(callerKind as WorkflowCallerKind)) {
    throw new Error(`invalid caller_kind in workflow record ${path}`);
  }
  if (!RUN_STATUSES.has(status as WorkflowRunStatus)) {
    throw new Error(`invalid status in workflow record ${path}`);
  }
  if (!Array.isArray(raw['agents'])) {
    throw new Error(`invalid agents in workflow record ${path}`);
  }
  const record: WorkflowRunRecord = {
    version: 1,
    run_id: runId,
    dispatcher_id: dispatcherId,
    team_id: teamId,
    caller_kind: callerKind as WorkflowCallerKind,
    script_hash: stringField(raw, 'script_hash', path),
    status: status as WorkflowRunStatus,
    max_concurrency: numberField(raw, 'max_concurrency', path),
    phase: nullableStringField(raw, 'phase', path),
    last_log: nullableStringField(raw, 'last_log', path),
    agents: raw['agents'].map((agent, index) => parseAgent(agent, path, index)),
    result: raw['result'] ?? null,
    error: nullableStringField(raw, 'error', path),
    created_at: numberField(raw, 'created_at', path),
    updated_at: numberField(raw, 'updated_at', path),
    ended_at: nullableNumberField(raw, 'ended_at', path),
  };
  assertRecordScope(record, scope);
  return record;
}

function parseAgent(raw: unknown, path: string, position: number): WorkflowAgentRecord {
  if (!isRecord(raw)) {
    throw new Error(`invalid agent ${position} in workflow record ${path}`);
  }
  const status = raw['status'];
  if (!AGENT_STATUSES.has(status as WorkflowAgentStatus)) {
    throw new Error(`invalid agent status in workflow record ${path}`);
  }
  return {
    index: numberField(raw, 'index', path),
    name: nullableStringField(raw, 'name', path),
    label: nullableStringField(raw, 'label', path),
    phase: nullableStringField(raw, 'phase', path),
    status: status as WorkflowAgentStatus,
    result: raw['result'] ?? null,
    error: optionalNullableStringField(raw, 'error', path),
    created_at: numberField(raw, 'created_at', path),
    settled_at: nullableNumberField(raw, 'settled_at', path),
  };
}

function optionalNullableStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string | null {
  if (!Object.hasOwn(record, field)) return null;
  return nullableStringField(record, field, path);
}

function assertRecordScope(
  record: WorkflowRunRecord,
  scope: WorkflowScopePathInput,
): void {
  if (
    record.dispatcher_id !== scope.dispatcherId ||
    record.team_id !== scope.teamId
  ) {
    throw new Error(
      `workflow run ${JSON.stringify(record.run_id)} does not belong to this scope`,
    );
  }
}

function stringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`invalid ${field} in workflow record ${path}`);
  }
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): string | null {
  const value = record[field];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`invalid ${field} in workflow record ${path}`);
  }
  return value;
}

function numberField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${field} in workflow record ${path}`);
  }
  return value;
}

function nullableNumberField(
  record: Record<string, unknown>,
  field: string,
  path: string,
): number | null {
  const value = record[field];
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`invalid ${field} in workflow record ${path}`);
  }
  return value as number | null;
}
