import { readdir, readFile } from 'node:fs/promises';

import { TransactionalStore } from '@excitedjs/dreamux-utils';

import { errorMessage } from '../../platform/error-info.js';
import { LegacyStateError } from '../../platform/errors.js';
import { isNotFound } from '../../platform/fs-errors.js';
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

const RECORD_VERSION = 1;

const RUN_STATUSES = new Set<WorkflowRunStatus>([
  'running',
  'completed',
  'failed',
  'stopped',
]);
const AGENT_STATUSES = new Set<WorkflowAgentStatus>([
  'queued',
  ...RUN_STATUSES,
]);
const CALLER_KINDS = new Set<WorkflowCallerKind>(['dispatcher', 'team_leader']);

/** Scope-local record store. Journal events are owned separately by WorkflowJournal. */
export class WorkflowRunStore {
  /** One `TransactionalStore` per run id, built lazily and held for the life
   * of this scope's collection — a run's record is read once and served from
   * memory afterward, until this run's own write path replaces it. */
  private readonly stores = new Map<string, TransactionalStore<WorkflowRunRecord | null>>();

  constructor(private readonly scope: WorkflowScopePathInput) {}

  /**
   * This run's own `TransactionalStore`, for an owner (`WorkflowRun`) that
   * holds a synchronous reference across its lifetime — reading the last
   * committed value (`.current`) or draining pending writes (`.drain()`) —
   * instead of a fresh async round trip through {@link get}/{@link write}
   * each time.
   */
  handle(runId: string): TransactionalStore<WorkflowRunRecord | null> {
    return this.storeFor(runId);
  }

  private storeFor(runId: string): TransactionalStore<WorkflowRunRecord | null> {
    const id = validateWorkflowRunId(runId);
    let store = this.stores.get(id);
    if (store === undefined) {
      store = new TransactionalStore<WorkflowRunRecord | null>({
        path: this.path(id),
        load: () => this.load(id),
      });
      this.stores.set(id, store);
    }
    return store;
  }

  /**
   * Publish a brand-new run record, no-clobber. `create` stores the value it
   * is handed as this run's committed reference, so a clone goes in — never
   * the caller's own live, still-mutating draft — the same way {@link write}
   * always clones its argument before committing it.
   */
  async create(record: WorkflowRunRecord): Promise<void> {
    assertRecordScope(record, this.scope);
    await this.storeFor(record.run_id).create(structuredClone(record));
  }

  async get(runId: string): Promise<WorkflowRunRecord | null> {
    return this.storeFor(runId).load();
  }

  /**
   * Publish `record` as this run's next committed value. `WorkflowRun` is
   * this record's sole mutator — there is no second writer whose committed
   * value a merge would need to reconcile against — so this always publishes
   * the caller's already-built next value rather than computing one from
   * whatever is currently committed.
   */
  async write(record: WorkflowRunRecord): Promise<void> {
    assertRecordScope(record, this.scope);
    await this.storeFor(record.run_id).update(() => structuredClone(record));
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

  /**
   * This run's whole validation contract, inlined from the now-deleted
   * generic `JsonDocumentStore`: a missing file is a successful `null`, a
   * version mismatch or malformed document is a `LegacyStateError` (Dreamux
   * 0.x does not migrate old state), and a parsed record must belong to this
   * scope.
   */
  private async load(runId: string): Promise<WorkflowRunRecord | null> {
    const path = this.path(runId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || value['version'] !== RECORD_VERSION) {
        throw new LegacyStateError(
          `JSON document ${path} is not version ${RECORD_VERSION}. ` +
            'Dreamux 0.x does not migrate old state; delete the file to rebuild it.',
        );
      }
      return parseRecord(value, this.scope, path);
    } catch (err) {
      if (err instanceof LegacyStateError) throw err;
      throw new LegacyStateError(
        `JSON document ${path} is malformed or incompatible. Dreamux 0.x does ` +
          `not migrate old state; delete the file to rebuild it. Cause: ${errorMessage(err)}`,
      );
    }
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

function parseAgent(
  raw: unknown,
  path: string,
  position: number,
): WorkflowAgentRecord {
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
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error(`invalid ${field} in workflow record ${path}`);
  }
  return value as number | null;
}
