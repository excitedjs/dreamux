import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  dispatcherTeamMateLedgerPath,
  dispatcherTeamMateTasksDir,
} from '../runtime/paths.js';

export const TEAMMATE_LEDGER_VERSION = 1;
export const TEAMMATE_TASK_VERSION = 1;

export const TEAMMATE_TASK_STATUSES = [
  'accepted',
  'running',
  'completed',
  'failed',
  'delivery_failed',
  'delivered',
] as const;

export type TeamMateTaskStatus = typeof TEAMMATE_TASK_STATUSES[number];

export type TeamMateScheduleCallerKind = 'dispatcher' | 'teammate';

export interface TeamMateLedgerFile {
  version: typeof TEAMMATE_LEDGER_VERSION;
  dispatcher_id: string;
  created_at: number;
  updated_at: number;
}

export interface TeamMateTaskHistoryEntry {
  status: TeamMateTaskStatus;
  at: number;
  message?: string;
}

export interface TeamMateTaskRecord {
  version: typeof TEAMMATE_TASK_VERSION;
  task_id: string;
  dispatcher_id: string;
  status: TeamMateTaskStatus;
  title: string;
  prompt: string;
  teammate_id: string | null;
  scheduled_by: {
    kind: TeamMateScheduleCallerKind;
  };
  history: TeamMateTaskHistoryEntry[];
  created_at: number;
  updated_at: number;
}

export interface AcceptTeamMateTaskInput {
  title: string;
  prompt: string;
  callerKind: TeamMateScheduleCallerKind;
  teammateId?: string;
  now?: number;
  taskId?: string;
}

export interface UpdateTeamMateTaskStatusInput {
  status: TeamMateTaskStatus;
  now?: number;
}

export class TeamMateLedgerCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamMateLedgerCompatibilityError';
  }
}

export class NestedTeamMateDispatchError extends Error {
  constructor() {
    super('TeamMate tasks cannot schedule more TeamMate tasks');
    this.name = 'NestedTeamMateDispatchError';
  }
}

const TASK_ID_PATTERN = /^tmtsk_[a-z0-9]+_[a-z0-9]+$/;
const TEAMMATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 20_000;
let tmpCounter = 0;

export class TeamMateTaskLedger {
  constructor(readonly dispatcherId: string) {}

  async acceptTask(input: AcceptTeamMateTaskInput): Promise<TeamMateTaskRecord> {
    if (input.callerKind === 'teammate') {
      throw new NestedTeamMateDispatchError();
    }
    const title = validateBoundedString(
      input.title,
      'title',
      MAX_TITLE_LENGTH,
    );
    const prompt = validateBoundedString(
      input.prompt,
      'prompt',
      MAX_PROMPT_LENGTH,
    );
    const teammateId = validateOptionalTeamMateId(input.teammateId);
    await this.ensureRoot(input.now);

    const now = input.now ?? Date.now();
    const task: TeamMateTaskRecord = {
      version: TEAMMATE_TASK_VERSION,
      task_id: input.taskId ?? newTaskId(),
      dispatcher_id: this.dispatcherId,
      status: 'accepted',
      title,
      prompt,
      teammate_id: teammateId,
      scheduled_by: { kind: input.callerKind },
      history: [{ status: 'accepted', at: now }],
      created_at: now,
      updated_at: now,
    };
    validateTaskId(task.task_id);
    await mkdir(dispatcherTeamMateTasksDir(this.dispatcherId), {
      recursive: true,
    });
    await writeJsonNew(taskPath(this.dispatcherId, task.task_id), task);
    await this.writeRoot({
      ...(await this.readRoot()),
      updated_at: now,
    });
    return cloneTask(task);
  }

  async getTask(taskId: string): Promise<TeamMateTaskRecord | null> {
    validateTaskId(taskId);
    await this.ensureRoot();
    try {
      return cloneTask(
        readTaskFile(
          this.dispatcherId,
          taskId,
          await readFile(taskPath(this.dispatcherId, taskId), 'utf8'),
        ),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listTasks(): Promise<TeamMateTaskRecord[]> {
    await this.ensureRoot();
    let names: string[];
    try {
      names = await readdir(dispatcherTeamMateTasksDir(this.dispatcherId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const tasks: TeamMateTaskRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -'.json'.length);
      validateTaskId(taskId);
      tasks.push(
        readTaskFile(
          this.dispatcherId,
          taskId,
          await readFile(join(dispatcherTeamMateTasksDir(this.dispatcherId), name), 'utf8'),
        ),
      );
    }
    return tasks
      .sort((a, b) => a.created_at - b.created_at || a.task_id.localeCompare(b.task_id))
      .map(cloneTask);
  }

  async updateTaskStatus(
    taskId: string,
    input: UpdateTeamMateTaskStatusInput,
  ): Promise<TeamMateTaskRecord> {
    if (!isTeamMateTaskStatus(input.status)) {
      throw new Error(`unsupported TeamMate task status: ${String(input.status)}`);
    }
    const existing = await this.getTask(taskId);
    if (existing === null) {
      throw new Error(`TeamMate task ${JSON.stringify(taskId)} does not exist`);
    }
    const updated: TeamMateTaskRecord = {
      ...existing,
      status: input.status,
      updated_at: input.now ?? Date.now(),
    };
    updated.history = [
      ...existing.history,
      { status: input.status, at: updated.updated_at },
    ];
    await writeJsonAtomic(taskPath(this.dispatcherId, taskId), updated);
    await this.writeRoot({
      ...(await this.readRoot()),
      updated_at: updated.updated_at,
    });
    return cloneTask(updated);
  }

  private async ensureRoot(now = Date.now()): Promise<TeamMateLedgerFile> {
    try {
      return await this.readRoot();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const root: TeamMateLedgerFile = {
      version: TEAMMATE_LEDGER_VERSION,
      dispatcher_id: this.dispatcherId,
      created_at: now,
      updated_at: now,
    };
    await mkdir(dispatcherTeamMateTasksDir(this.dispatcherId), {
      recursive: true,
    });
    await this.writeRoot(root);
    return root;
  }

  private async readRoot(): Promise<TeamMateLedgerFile> {
    const path = dispatcherTeamMateLedgerPath(this.dispatcherId);
    return readLedgerRoot(this.dispatcherId, await readFile(path, 'utf8'));
  }

  private async writeRoot(root: TeamMateLedgerFile): Promise<void> {
    await mkdir(dirname(dispatcherTeamMateLedgerPath(this.dispatcherId)), {
      recursive: true,
    });
    await writeJsonAtomic(dispatcherTeamMateLedgerPath(this.dispatcherId), root);
  }
}

function readLedgerRoot(
  dispatcherId: string,
  raw: string,
): TeamMateLedgerFile {
  const parsed = parseJson(raw, `dispatcher '${dispatcherId}' TeamMate ledger`);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate ledger root must be an object`,
    );
  }
  const file = parsed as Partial<TeamMateLedgerFile>;
  if (file.version !== TEAMMATE_LEDGER_VERSION) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate ledger has unsupported version ` +
        `${versionForMessage(file.version)}; expected ${TEAMMATE_LEDGER_VERSION}`,
    );
  }
  if (file.dispatcher_id !== dispatcherId) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate ledger belongs to ` +
        `${JSON.stringify(file.dispatcher_id)}`,
    );
  }
  if (
    !isFiniteNumber(file.created_at) ||
    !isFiniteNumber(file.updated_at)
  ) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate ledger has malformed v1 fields`,
    );
  }
  return {
    version: TEAMMATE_LEDGER_VERSION,
    dispatcher_id: dispatcherId,
    created_at: file.created_at,
    updated_at: file.updated_at,
  };
}

function readTaskFile(
  dispatcherId: string,
  taskId: string,
  raw: string,
): TeamMateTaskRecord {
  const parsed = parseJson(
    raw,
    `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)}`,
  );
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'must be an object',
    );
  }
  const file = parsed as Partial<TeamMateTaskRecord>;
  if (file.version !== TEAMMATE_TASK_VERSION) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        `has unsupported version ${versionForMessage(file.version)}; ` +
        `expected ${TEAMMATE_TASK_VERSION}`,
    );
  }
  if (file.dispatcher_id !== dispatcherId || file.task_id !== taskId) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has mismatched identity fields',
    );
  }
  if (
    !isTeamMateTaskStatus(file.status) ||
    typeof file.title !== 'string' ||
    file.title === '' ||
    typeof file.prompt !== 'string' ||
    file.prompt === '' ||
    !isNullableString(file.teammate_id) ||
    !isScheduledBy(file.scheduled_by) ||
    !isTaskHistory(file.history) ||
    !isFiniteNumber(file.created_at) ||
    !isFiniteNumber(file.updated_at)
  ) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has malformed v1 fields',
    );
  }
  return {
    version: TEAMMATE_TASK_VERSION,
    task_id: taskId,
    dispatcher_id: dispatcherId,
    status: file.status,
    title: file.title,
    prompt: file.prompt,
    teammate_id: file.teammate_id ?? null,
    scheduled_by: { kind: file.scheduled_by.kind },
    history: file.history.map(cloneHistoryEntry),
    created_at: file.created_at,
    updated_at: file.updated_at,
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TeamMateLedgerCompatibilityError(
      `${label} is not valid JSON: ${message}`,
    );
  }
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

function taskPath(dispatcherId: string, taskId: string): string {
  validateTaskId(taskId);
  return join(dispatcherTeamMateTasksDir(dispatcherId), `${taskId}.json`);
}

function newTaskId(): string {
  return `tmtsk_${Date.now().toString(36)}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`;
}

function validateTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`invalid TeamMate task id ${JSON.stringify(taskId)}`);
  }
}

function validateBoundedString(
  value: string,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters`);
  }
  return value;
}

function validateOptionalTeamMateId(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!TEAMMATE_ID_PATTERN.test(value)) {
    throw new Error(
      'teammate_id must start with a letter or digit and contain only ' +
        'letters, digits, dot, underscore, or dash',
    );
  }
  return value;
}

export function isTeamMateTaskStatus(
  value: unknown,
): value is TeamMateTaskStatus {
  return TEAMMATE_TASK_STATUSES.includes(value as TeamMateTaskStatus);
}

function isCallerKind(value: unknown): value is TeamMateScheduleCallerKind {
  return value === 'dispatcher' || value === 'teammate';
}

function isScheduledBy(
  value: unknown,
): value is TeamMateTaskRecord['scheduled_by'] {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isCallerKind((value as Partial<TeamMateTaskRecord['scheduled_by']>).kind)
  );
}

function isTaskHistory(value: unknown): value is TeamMateTaskHistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        isTeamMateTaskStatus(
          (entry as Partial<TeamMateTaskHistoryEntry>).status,
        ) &&
        isFiniteNumber((entry as Partial<TeamMateTaskHistoryEntry>).at) &&
        (
          (entry as Partial<TeamMateTaskHistoryEntry>).message === undefined ||
          typeof (entry as Partial<TeamMateTaskHistoryEntry>).message ===
            'string'
        ),
    )
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function cloneTask(task: TeamMateTaskRecord): TeamMateTaskRecord {
  return {
    ...task,
    scheduled_by: { ...task.scheduled_by },
    history: task.history.map(cloneHistoryEntry),
  };
}

function cloneHistoryEntry(
  entry: TeamMateTaskHistoryEntry,
): TeamMateTaskHistoryEntry {
  return {
    status: entry.status,
    at: entry.at,
    ...(entry.message !== undefined ? { message: entry.message } : {}),
  };
}

function versionForMessage(value: unknown): string {
  return value === undefined ? 'missing' : JSON.stringify(value);
}
