import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  dispatcherTeamMateLedgerPath,
  dispatcherTeamMateTasksDir,
} from '../runtime/paths.js';

export const TEAMMATE_LEDGER_VERSION = 1;
/**
 * Task record version. Bumped to 2 for the TeamMate MCP parity work (issue
 * #126): lifecycle/delivery separation, a monotonic per-task event stream, a
 * steerable multi-input session, and runtime/target/close placeholders. The
 * reader still loads v1 records (issue #110 PR7/PR8) by migrating them in
 * memory — no on-disk rewrite is forced — and fails loud only on an unknown
 * future version.
 */
export const TEAMMATE_TASK_VERSION = 2;
export const TEAMMATE_TASK_READABLE_VERSIONS = [1, 2] as const;

/**
 * Lifecycle of the task itself, independent of how its result is delivered back
 * to the scheduling dispatcher. (issue #126.)
 */
export const TEAMMATE_LIFECYCLE_STATUSES = [
  'accepted',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TeamMateLifecycleStatus =
  typeof TEAMMATE_LIFECYCLE_STATUSES[number];

/** Delivery state of a retained result, separate from the task lifecycle. */
export const TEAMMATE_DELIVERY_STATUSES = [
  'none',
  'pending',
  'delivered',
  'delivery_failed',
] as const;
export type TeamMateDeliveryStatus =
  typeof TEAMMATE_DELIVERY_STATUSES[number];

/** How the worker should be placed against the target (issue #126). */
export const TEAMMATE_TARGET_MODES = ['managed_worktree', 'in_place'] as const;
export type TeamMateTargetMode = typeof TEAMMATE_TARGET_MODES[number];

/** Follow-up input delivery mode for a steerable session (issue #126). */
export const TEAMMATE_INPUT_MODES = ['steer', 'queue', 'interrupt'] as const;
export type TeamMateInputMode = typeof TEAMMATE_INPUT_MODES[number];

export const TEAMMATE_EVENT_TYPES = [
  'accepted',
  'queued',
  'running',
  'completed',
  'failed',
  'delivered',
  'delivery_failed',
  'input_queued',
  'closed',
] as const;
export type TeamMateEventType = typeof TEAMMATE_EVENT_TYPES[number];

/** Operator close dispositions; mirrors `tm kill --status` plus MCP additions. */
export const TEAMMATE_CLOSE_STATUSES = [
  'merged',
  'done',
  'shelved',
  'abandoned',
  'blocked',
  'cancelled',
  'duplicate',
  'failed',
] as const;
export type TeamMateCloseStatus = typeof TEAMMATE_CLOSE_STATUSES[number];

/**
 * Legacy v1 combined status. Retained as a back-compat projection for the
 * server/MCP read boundary (summaries, pull) — it is no longer persisted.
 */
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

/** One entry in the monotonic per-task event stream. `event_id` starts at 1. */
export interface TeamMateTaskEvent {
  event_id: number;
  type: TeamMateEventType;
  at: number;
  input_id?: string;
  message?: string;
}

/** A follow-up input recorded against a steerable session (issue #126). */
export interface TeamMateTaskInput {
  input_id: string;
  text: string;
  mode: TeamMateInputMode;
  status: 'queued' | 'submitted' | 'superseded';
  created_at: number;
}

/** Where the worker will run. Paths are local state, kept out of public text. */
export interface TeamMateTaskTarget {
  kind: 'path';
  path: string;
}

/** Provider runtime handle placeholders; `null` until a worker actually runs. */
export interface TeamMateRuntimeHandle {
  provider_ref: string | null;
  session_id: string | null;
  thread_id: string | null;
  state: 'starting' | 'running' | 'stopped' | 'orphaned' | null;
  last_seen_at: number | null;
}

/** Final operator close metadata for a task (issue #126). */
export interface TeamMateTaskClose {
  status: TeamMateCloseStatus;
  note: string | null;
  at: number;
}

/**
 * Team Mode reservation (issue #126). A future Team owns an Epic workspace with
 * a leader plus author/reviewer members; this block reserves the routing
 * identity without PR1 implementing any of it. All fields are nullable and
 * unused (always `null`) in PR1 — the reader accepts them so a later slice can
 * populate them additively, and ordinary TeamMates still cannot nested-dispatch
 * regardless of role (the scheduling-authority boundary lives in the service).
 */
export interface TeamMateTeamRef {
  team_id: string | null;
  epic_id: string | null;
  /** Member role within the Team (e.g. leader/author/reviewer), reserved. */
  role: string | null;
  /** The leader task that owns this task's Epic, reserved. */
  leader_task_id: string | null;
}

/** The retained final result of a TeamMate task (issue #110 PR8). */
export interface TeamMateTaskResult {
  /** Whether the task itself completed or failed. */
  outcome: 'completed' | 'failed';
  /** The final result text retained for delivery and pull retrieval. */
  text: string;
  at: number;
}

/** Delivery retry bookkeeping for a completed task (issue #110 PR8). */
export interface TeamMateDeliveryState {
  attempts: number;
  last_error: string | null;
  last_attempt_at: number | null;
}

export interface TeamMateTaskRecord {
  version: typeof TEAMMATE_TASK_VERSION;
  task_id: string;
  dispatcher_id: string;
  /** Lifecycle of the task itself. */
  lifecycle_status: TeamMateLifecycleStatus;
  /** Delivery state of the retained result, separate from the lifecycle. */
  delivery_status: TeamMateDeliveryStatus;
  title: string;
  prompt: string;
  teammate_id: string | null;
  /** Free-form intent label for history/diagnostics. */
  intent: string | null;
  /** Local execution target. `null` for compatibility `schedule` tasks. */
  target: TeamMateTaskTarget | null;
  target_mode: TeamMateTargetMode | null;
  provider_ref: string | null;
  /** Idempotency key for the creating operation (issue #126). */
  operation_id: string | null;
  /**
   * Source/origin of the task (e.g. `dispatcher`). Reserved so external Epic
   * sources or operator-created Epics can be distinguished later (issue #126).
   */
  origin: string | null;
  /** Branch/worktree ownership for the task, reserved for Team Mode. */
  branch: string | null;
  /** Team/Epic routing identity, reserved for Team Mode; `null` in PR1. */
  team: TeamMateTeamRef | null;
  scheduled_by: {
    kind: TeamMateScheduleCallerKind;
  };
  /** Monotonic event stream; source of truth for the wait broker. */
  events: TeamMateTaskEvent[];
  /** Steerable session inputs. */
  inputs: TeamMateTaskInput[];
  /** Provider runtime handle; `null` until a worker runs (placeholder in PR1). */
  runtime: TeamMateRuntimeHandle | null;
  /**
   * The retained final result, once the task has completed or failed. `null`
   * for accepted/running tasks.
   */
  result: TeamMateTaskResult | null;
  /** Delivery retry bookkeeping; `null` until the first delivery attempt. */
  delivery: TeamMateDeliveryState | null;
  /** Final operator close metadata; `null` until the task is closed. */
  close: TeamMateTaskClose | null;
  created_at: number;
  updated_at: number;
}

export interface AcceptTeamMateTaskInput {
  title: string;
  prompt: string;
  callerKind: TeamMateScheduleCallerKind;
  teammateId?: string;
  intent?: string;
  target?: TeamMateTaskTarget;
  targetMode?: TeamMateTargetMode;
  providerRef?: string;
  operationId?: string;
  /** Source/origin label; defaults to `dispatcher` (Team Mode reservation). */
  origin?: string;
  now?: number;
  taskId?: string;
}

export interface AppendTeamMateInputInput {
  text: string;
  mode: TeamMateInputMode;
  now?: number;
}

export interface RecordTeamMateResultInput {
  outcome: 'completed' | 'failed';
  text: string;
  now?: number;
}

export interface RecordTeamMateCloseInput {
  status: TeamMateCloseStatus;
  note?: string;
  now?: number;
}

/** Thrown when a ledger transition is not allowed from the current status. */
export class TeamMateTaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TeamMateLifecycleStatus | TeamMateDeliveryStatus,
    readonly to: string,
  ) {
    super(
      `TeamMate task ${JSON.stringify(taskId)} cannot transition from ` +
        `${from} to ${to}`,
    );
    this.name = 'TeamMateTaskTransitionError';
  }
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
const MAX_RESULT_LENGTH = 200_000;
const MAX_INPUT_LENGTH = 20_000;
const MAX_INTENT_LENGTH = 200;
const MAX_PROVIDER_REF_LENGTH = 200;
const MAX_OPERATION_ID_LENGTH = 200;
const MAX_ORIGIN_LENGTH = 200;
const MAX_TARGET_PATH_LENGTH = 4_096;
const MAX_CLOSE_NOTE_LENGTH = 2_000;
let tmpCounter = 0;

/** Lifecycle states from which a result may still be recorded. */
const RESULT_RECORDABLE: ReadonlySet<TeamMateLifecycleStatus> = new Set([
  'accepted',
  'queued',
  'running',
]);

/** Lifecycle states with a retained result that delivery can act on. */
function isResultReady(lifecycle: TeamMateLifecycleStatus): boolean {
  return lifecycle === 'completed' || lifecycle === 'failed';
}

/**
 * Back-compat projection of the separated lifecycle/delivery state into the v1
 * single-status enum, for the server/MCP read boundary. Delivery state wins
 * once it is terminal; otherwise the lifecycle is reported.
 */
export function legacyTaskStatus(task: TeamMateTaskRecord): string {
  if (task.delivery_status === 'delivered') return 'delivered';
  if (task.delivery_status === 'delivery_failed') return 'delivery_failed';
  if (task.lifecycle_status === 'queued') return 'accepted';
  return task.lifecycle_status;
}

/** Increment the delivery attempt counter and stamp the latest attempt/error. */
function bumpDelivery(
  existing: TeamMateDeliveryState | null,
  error: string | null,
  now: number,
): TeamMateDeliveryState {
  return {
    attempts: (existing?.attempts ?? 0) + 1,
    last_error: error,
    last_attempt_at: now,
  };
}

function nextEventId(task: TeamMateTaskRecord): number {
  const last = task.events[task.events.length - 1];
  return (last?.event_id ?? 0) + 1;
}

function appendEvent(
  task: TeamMateTaskRecord,
  event: Omit<TeamMateTaskEvent, 'event_id'>,
): TeamMateTaskEvent[] {
  return [...task.events, { event_id: nextEventId(task), ...event }];
}

export class TeamMateTaskLedger {
  constructor(readonly dispatcherId: string) {}

  async acceptTask(input: AcceptTeamMateTaskInput): Promise<TeamMateTaskRecord> {
    if (input.callerKind === 'teammate') {
      throw new NestedTeamMateDispatchError();
    }
    const title = validateBoundedString(input.title, 'title', MAX_TITLE_LENGTH);
    const prompt = validateBoundedString(
      input.prompt,
      'prompt',
      MAX_PROMPT_LENGTH,
    );
    const teammateId = validateOptionalTeamMateId(input.teammateId);
    const intent = validateOptionalBounded(input.intent, 'intent', MAX_INTENT_LENGTH);
    const target =
      input.target !== undefined ? validateTarget(input.target) : null;
    const targetMode = validateOptionalTargetMode(input.targetMode);
    const providerRef = validateOptionalBounded(
      input.providerRef,
      'provider_ref',
      MAX_PROVIDER_REF_LENGTH,
    );
    const operationId = validateOptionalBounded(
      input.operationId,
      'operation_id',
      MAX_OPERATION_ID_LENGTH,
    );
    const origin =
      validateOptionalBounded(input.origin, 'origin', MAX_ORIGIN_LENGTH) ??
      'dispatcher';
    await this.ensureRoot(input.now);

    // Best-effort operation_id idempotency (issue #126): replaying the same
    // operation id returns the prior task instead of creating a duplicate. The
    // scan is single-threaded per server event loop; a true cross-process index
    // is deferred (documented in the PR body).
    if (operationId !== null) {
      const existing = await this.findByOperationId(operationId);
      if (existing !== null) return cloneTask(existing);
    }

    const now = input.now ?? Date.now();
    const task: TeamMateTaskRecord = {
      version: TEAMMATE_TASK_VERSION,
      task_id: input.taskId ?? newTaskId(),
      dispatcher_id: this.dispatcherId,
      lifecycle_status: 'accepted',
      delivery_status: 'none',
      title,
      prompt,
      teammate_id: teammateId,
      intent,
      target,
      target_mode: targetMode,
      provider_ref: providerRef,
      operation_id: operationId,
      origin,
      branch: null,
      team: null,
      scheduled_by: { kind: input.callerKind },
      events: [{ event_id: 1, type: 'accepted', at: now }],
      inputs: [],
      runtime: null,
      result: null,
      delivery: null,
      close: null,
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

  /**
   * List all readable task records, oldest first. Resilient for retrieval: a
   * file with an invalid name or corrupt/incompatible content is skipped and
   * reported via {@link onCorrupt} rather than failing the whole listing — one
   * bad file must not make every task unreadable. Use {@link getTask} when a
   * caller asks for one specific task (that path stays fail-loud).
   */
  async listTasks(
    options: { onCorrupt?: (taskId: string, error: Error) => void } = {},
  ): Promise<TeamMateTaskRecord[]> {
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
      try {
        validateTaskId(taskId);
        tasks.push(
          readTaskFile(
            this.dispatcherId,
            taskId,
            await readFile(
              join(dispatcherTeamMateTasksDir(this.dispatcherId), name),
              'utf8',
            ),
          ),
        );
      } catch (err) {
        options.onCorrupt?.(
          taskId,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
    return tasks
      .sort((a, b) => a.created_at - b.created_at || a.task_id.localeCompare(b.task_id))
      .map(cloneTask);
  }

  /**
   * The most recent task (by created_at) whose result is retained, optionally
   * restricted to a set of lifecycle states. Backs the "pull the latest result"
   * path, including after push delivery failed. Corrupt files are skipped via
   * {@link listTasks}.
   */
  async latestResultTask(
    lifecycleStatuses?: ReadonlySet<TeamMateLifecycleStatus>,
  ): Promise<TeamMateTaskRecord | null> {
    const tasks = await this.listTasks();
    const candidates = tasks.filter(
      (task) =>
        task.result !== null &&
        (lifecycleStatuses === undefined ||
          lifecycleStatuses.has(task.lifecycle_status)),
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, task) =>
      task.created_at >= latest.created_at ? task : latest,
    );
  }

  private async findByOperationId(
    operationId: string,
  ): Promise<TeamMateTaskRecord | null> {
    const tasks = await this.listTasks();
    return tasks.find((task) => task.operation_id === operationId) ?? null;
  }

  /** Mark an accepted/queued task as running (provider worker started). */
  async markRunning(
    taskId: string,
    options: { now?: number } = {},
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (
      existing.lifecycle_status !== 'accepted' &&
      existing.lifecycle_status !== 'queued'
    ) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'running',
      );
    }
    const now = options.now ?? Date.now();
    return this.writeTask({
      ...existing,
      lifecycle_status: 'running',
      events: appendEvent(existing, { type: 'running', at: now }),
      updated_at: now,
    });
  }

  /** Mark an accepted task as queued for execution. */
  async markQueued(
    taskId: string,
    options: { now?: number } = {},
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (existing.lifecycle_status !== 'accepted') {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'queued',
      );
    }
    const now = options.now ?? Date.now();
    return this.writeTask({
      ...existing,
      lifecycle_status: 'queued',
      events: appendEvent(existing, { type: 'queued', at: now }),
      updated_at: now,
    });
  }

  /**
   * Append a follow-up input to a steerable session (issue #126). Allowed while
   * the session is live (accepted/queued/running); a terminal or cancelled task
   * rejects further input. In PR1 there is no worker, so the input is recorded
   * as `queued` regardless of mode and waits for a future worker.
   */
  async appendInput(
    taskId: string,
    input: AppendTeamMateInputInput,
  ): Promise<{ task: TeamMateTaskRecord; input: TeamMateTaskInput }> {
    const existing = await this.mustGetTask(taskId);
    if (!RESULT_RECORDABLE.has(existing.lifecycle_status)) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'input',
      );
    }
    const text = validateBoundedString(input.text, 'input text', MAX_INPUT_LENGTH);
    if (!isInputMode(input.mode)) {
      throw new Error(`unsupported send_input mode: ${String(input.mode)}`);
    }
    const now = input.now ?? Date.now();
    const inputId = `input_${existing.inputs.length + 1}`;
    const recorded: TeamMateTaskInput = {
      input_id: inputId,
      text,
      mode: input.mode,
      status: 'queued',
      created_at: now,
    };
    const updated = await this.writeTask({
      ...existing,
      inputs: [...existing.inputs, recorded],
      events: appendEvent(existing, {
        type: 'input_queued',
        at: now,
        input_id: inputId,
      }),
      updated_at: now,
    });
    return { task: updated, input: { ...recorded } };
  }

  /**
   * Record a task's final result. The result is persisted durably here, BEFORE
   * any delivery attempt — so a crash or a downed runtime can never lose it; a
   * later delivery only transitions an already-saved result to
   * `delivered`/`delivery_failed`. Allowed only from a live lifecycle; a second
   * report throws {@link TeamMateTaskTransitionError}, which also guards the
   * same-task update race.
   */
  async recordResult(
    taskId: string,
    input: RecordTeamMateResultInput,
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (!RESULT_RECORDABLE.has(existing.lifecycle_status)) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        input.outcome,
      );
    }
    const text = validateBoundedString(input.text, 'result text', MAX_RESULT_LENGTH);
    const now = input.now ?? Date.now();
    return this.writeTask({
      ...existing,
      lifecycle_status: input.outcome,
      delivery_status: 'pending',
      result: { outcome: input.outcome, text, at: now },
      events: appendEvent(existing, { type: input.outcome, at: now }),
      updated_at: now,
    });
  }

  /** Mark a completed task as delivered into the dispatcher context. */
  async recordDelivered(
    taskId: string,
    options: { now?: number } = {},
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (!isResultReady(existing.lifecycle_status)) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'delivered',
      );
    }
    const now = options.now ?? Date.now();
    return this.writeTask({
      ...existing,
      delivery_status: 'delivered',
      delivery: bumpDelivery(existing.delivery, null, now),
      events: appendEvent(existing, { type: 'delivered', at: now }),
      updated_at: now,
    });
  }

  /** Record one failed delivery attempt; state stays put (still deliverable). */
  async recordDeliveryAttemptFailure(
    taskId: string,
    options: { error: string; now?: number },
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (!isResultReady(existing.lifecycle_status)) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'delivery-attempt',
      );
    }
    const now = options.now ?? Date.now();
    return this.writeTask({
      ...existing,
      delivery: bumpDelivery(existing.delivery, options.error, now),
      updated_at: now,
    });
  }

  /**
   * Terminal delivery failure after bounded retries; result stays pull-able.
   * This is the terminal marker, not a new attempt, so it preserves the attempt
   * count already recorded by {@link recordDeliveryAttemptFailure}.
   */
  async recordDeliveryFailed(
    taskId: string,
    options: { error?: string; now?: number } = {},
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (!isResultReady(existing.lifecycle_status)) {
      throw new TeamMateTaskTransitionError(
        taskId,
        existing.lifecycle_status,
        'delivery_failed',
      );
    }
    const now = options.now ?? Date.now();
    return this.writeTask({
      ...existing,
      delivery_status: 'delivery_failed',
      delivery: {
        attempts: existing.delivery?.attempts ?? 0,
        last_error: options.error ?? existing.delivery?.last_error ?? null,
        last_attempt_at: now,
      },
      events: appendEvent(existing, { type: 'delivery_failed', at: now }),
      updated_at: now,
    });
  }

  /**
   * Record final operator close metadata (issue #126). A live task is also
   * transitioned to `cancelled`; a task that already completed/failed keeps its
   * terminal lifecycle and only gains close metadata (e.g. completed → merged).
   */
  async recordClose(
    taskId: string,
    input: RecordTeamMateCloseInput,
  ): Promise<TeamMateTaskRecord> {
    const existing = await this.mustGetTask(taskId);
    if (!isCloseStatus(input.status)) {
      throw new Error(`unsupported close status: ${String(input.status)}`);
    }
    const note =
      input.note === undefined
        ? null
        : validateBoundedString(input.note, 'close note', MAX_CLOSE_NOTE_LENGTH);
    const now = input.now ?? Date.now();
    const stillLive = RESULT_RECORDABLE.has(existing.lifecycle_status);
    return this.writeTask({
      ...existing,
      lifecycle_status: stillLive ? 'cancelled' : existing.lifecycle_status,
      close: { status: input.status, note, at: now },
      events: appendEvent(existing, { type: 'closed', at: now }),
      updated_at: now,
    });
  }

  private async mustGetTask(taskId: string): Promise<TeamMateTaskRecord> {
    const existing = await this.getTask(taskId);
    if (existing === null) {
      throw new Error(`TeamMate task ${JSON.stringify(taskId)} does not exist`);
    }
    return existing;
  }

  private async writeTask(task: TeamMateTaskRecord): Promise<TeamMateTaskRecord> {
    await writeJsonAtomic(taskPath(this.dispatcherId, task.task_id), task);
    await this.writeRoot({
      ...(await this.readRoot()),
      updated_at: task.updated_at,
    });
    return cloneTask(task);
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

interface LegacyV1HistoryEntry {
  status: TeamMateTaskStatus;
  at: number;
  message?: string;
}

/**
 * Parse and validate a task file, accepting both v2 (native) and v1 (migrated
 * in memory) records. Unknown versions fail loud.
 */
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
  const file = parsed as { version?: unknown };
  if (file.version === 1) {
    return migrateV1Task(dispatcherId, taskId, parsed as Record<string, unknown>);
  }
  if (file.version === TEAMMATE_TASK_VERSION) {
    return readV2Task(dispatcherId, taskId, parsed as Record<string, unknown>);
  }
  throw new TeamMateLedgerCompatibilityError(
    `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
      `has unsupported version ${versionForMessage(file.version)}; ` +
      `expected one of ${TEAMMATE_TASK_READABLE_VERSIONS.join(', ')}`,
  );
}

/** Read a native v2 task record. */
function readV2Task(
  dispatcherId: string,
  taskId: string,
  file: Record<string, unknown>,
): TeamMateTaskRecord {
  if (file['dispatcher_id'] !== dispatcherId || file['task_id'] !== taskId) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has mismatched identity fields',
    );
  }
  if (
    !isLifecycleStatus(file['lifecycle_status']) ||
    !isDeliveryStatus(file['delivery_status']) ||
    typeof file['title'] !== 'string' ||
    file['title'] === '' ||
    typeof file['prompt'] !== 'string' ||
    file['prompt'] === '' ||
    !isNullableString(file['teammate_id']) ||
    !isNullableString(file['intent']) ||
    !isNullableString(file['provider_ref']) ||
    !isNullableString(file['operation_id']) ||
    !isNullableString(file['origin']) ||
    !isNullableString(file['branch']) ||
    !isNullableTeam(file['team']) ||
    !isScheduledBy(file['scheduled_by']) ||
    !isEventStream(file['events']) ||
    !isInputList(file['inputs']) ||
    !isNullableTarget(file['target']) ||
    !isNullableTargetMode(file['target_mode']) ||
    !isNullableRuntime(file['runtime']) ||
    !isNullableClose(file['close']) ||
    !isFiniteNumber(file['created_at']) ||
    !isFiniteNumber(file['updated_at'])
  ) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has malformed v2 fields',
    );
  }
  if (!isNullableResult(file['result']) || !isNullableDelivery(file['delivery'])) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has a malformed result/delivery field',
    );
  }
  const target = file['target'] as TeamMateTaskTarget | null | undefined;
  const runtime = file['runtime'] as TeamMateRuntimeHandle | null | undefined;
  const close = file['close'] as TeamMateTaskClose | null | undefined;
  const result = file['result'] as TeamMateTaskResult | null | undefined;
  const delivery = file['delivery'] as TeamMateDeliveryState | null | undefined;
  return {
    version: TEAMMATE_TASK_VERSION,
    task_id: taskId,
    dispatcher_id: dispatcherId,
    lifecycle_status: file['lifecycle_status'] as TeamMateLifecycleStatus,
    delivery_status: file['delivery_status'] as TeamMateDeliveryStatus,
    title: file['title'] as string,
    prompt: file['prompt'] as string,
    teammate_id: (file['teammate_id'] as string | null | undefined) ?? null,
    intent: (file['intent'] as string | null | undefined) ?? null,
    target: target ?? null,
    target_mode:
      (file['target_mode'] as TeamMateTargetMode | null | undefined) ?? null,
    provider_ref: (file['provider_ref'] as string | null | undefined) ?? null,
    operation_id: (file['operation_id'] as string | null | undefined) ?? null,
    origin: (file['origin'] as string | null | undefined) ?? null,
    branch: (file['branch'] as string | null | undefined) ?? null,
    team: cloneTeam(file['team'] as TeamMateTeamRef | null | undefined),
    scheduled_by: {
      kind: (file['scheduled_by'] as { kind: TeamMateScheduleCallerKind }).kind,
    },
    events: (file['events'] as TeamMateTaskEvent[]).map(cloneEvent),
    inputs: (file['inputs'] as TeamMateTaskInput[]).map(cloneInput),
    runtime: runtime ?? null,
    result: result ?? null,
    delivery: delivery ?? null,
    close: close ?? null,
    created_at: file['created_at'] as number,
    updated_at: file['updated_at'] as number,
  };
}

/**
 * Migrate a v1 task record (issue #110 PR7/PR8) into the v2 shape in memory.
 * Lossless: the separated lifecycle/delivery state and the event stream are
 * derived from the v1 `status`, `result`, and `history`.
 */
function migrateV1Task(
  dispatcherId: string,
  taskId: string,
  file: Record<string, unknown>,
): TeamMateTaskRecord {
  if (file['dispatcher_id'] !== dispatcherId || file['task_id'] !== taskId) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has mismatched identity fields',
    );
  }
  if (
    !isLegacyTaskStatus(file['status']) ||
    typeof file['title'] !== 'string' ||
    file['title'] === '' ||
    typeof file['prompt'] !== 'string' ||
    file['prompt'] === '' ||
    !isNullableString(file['teammate_id']) ||
    !isScheduledBy(file['scheduled_by']) ||
    !isLegacyHistory(file['history']) ||
    !isFiniteNumber(file['created_at']) ||
    !isFiniteNumber(file['updated_at'])
  ) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has malformed v1 fields',
    );
  }
  if (!isNullableResult(file['result']) || !isNullableDelivery(file['delivery'])) {
    throw new TeamMateLedgerCompatibilityError(
      `dispatcher '${dispatcherId}' TeamMate task ${JSON.stringify(taskId)} ` +
        'has a malformed result/delivery field',
    );
  }
  const status = file['status'] as TeamMateTaskStatus;
  const result = (file['result'] as TeamMateTaskResult | null | undefined) ?? null;
  const delivery =
    (file['delivery'] as TeamMateDeliveryState | null | undefined) ?? null;
  const history = file['history'] as LegacyV1HistoryEntry[];
  const lifecycle = migrateLifecycle(status, result);
  const deliveryStatus = migrateDeliveryStatus(status, lifecycle);
  return {
    version: TEAMMATE_TASK_VERSION,
    task_id: taskId,
    dispatcher_id: dispatcherId,
    lifecycle_status: lifecycle,
    delivery_status: deliveryStatus,
    title: file['title'] as string,
    prompt: file['prompt'] as string,
    teammate_id: (file['teammate_id'] as string | null | undefined) ?? null,
    intent: null,
    target: null,
    target_mode: null,
    provider_ref: null,
    operation_id: null,
    origin: null,
    branch: null,
    team: null,
    scheduled_by: {
      kind: (file['scheduled_by'] as { kind: TeamMateScheduleCallerKind }).kind,
    },
    events: history.map((entry, index) => ({
      event_id: index + 1,
      type: entry.status,
      at: entry.at,
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    })),
    inputs: [],
    runtime: null,
    result,
    delivery,
    close: null,
    created_at: file['created_at'] as number,
    updated_at: file['updated_at'] as number,
  };
}

function migrateLifecycle(
  status: TeamMateTaskStatus,
  result: TeamMateTaskResult | null,
): TeamMateLifecycleStatus {
  switch (status) {
    case 'accepted':
      return 'accepted';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'delivered':
    case 'delivery_failed':
      // A delivered/delivery_failed v1 task always has a recorded result whose
      // outcome is the true lifecycle.
      return result?.outcome ?? 'completed';
    default:
      return 'completed';
  }
}

function migrateDeliveryStatus(
  status: TeamMateTaskStatus,
  lifecycle: TeamMateLifecycleStatus,
): TeamMateDeliveryStatus {
  if (status === 'delivered') return 'delivered';
  if (status === 'delivery_failed') return 'delivery_failed';
  return isResultReady(lifecycle) ? 'pending' : 'none';
}

function isNullableResult(value: unknown): value is TeamMateTaskResult | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<TeamMateTaskResult>;
  return (
    (r.outcome === 'completed' || r.outcome === 'failed') &&
    typeof r.text === 'string' &&
    isFiniteNumber(r.at)
  );
}

function isNullableDelivery(
  value: unknown,
): value is TeamMateDeliveryState | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Partial<TeamMateDeliveryState>;
  return (
    isFiniteNumber(d.attempts) &&
    (d.last_error === null || typeof d.last_error === 'string') &&
    (d.last_attempt_at === null || isFiniteNumber(d.last_attempt_at))
  );
}

function isEventStream(value: unknown): value is TeamMateTaskEvent[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previousId = 0;
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
    const e = entry as Partial<TeamMateTaskEvent>;
    if (
      !Number.isInteger(e.event_id) ||
      (e.event_id as number) <= previousId ||
      !isEventType(e.type) ||
      !isFiniteNumber(e.at) ||
      (e.input_id !== undefined && typeof e.input_id !== 'string') ||
      (e.message !== undefined && typeof e.message !== 'string')
    ) {
      return false;
    }
    previousId = e.event_id as number;
  }
  return true;
}

function isInputList(value: unknown): value is TeamMateTaskInput[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }
    const i = entry as Partial<TeamMateTaskInput>;
    return (
      typeof i.input_id === 'string' &&
      i.input_id !== '' &&
      typeof i.text === 'string' &&
      isInputMode(i.mode) &&
      (i.status === 'queued' ||
        i.status === 'submitted' ||
        i.status === 'superseded') &&
      isFiniteNumber(i.created_at)
    );
  });
}

function isNullableTarget(
  value: unknown,
): value is TeamMateTaskTarget | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Partial<TeamMateTaskTarget>;
  return t.kind === 'path' && typeof t.path === 'string' && t.path !== '';
}

function isNullableTargetMode(
  value: unknown,
): value is TeamMateTargetMode | null | undefined {
  return (
    value === undefined ||
    value === null ||
    TEAMMATE_TARGET_MODES.includes(value as TeamMateTargetMode)
  );
}

function isNullableRuntime(
  value: unknown,
): value is TeamMateRuntimeHandle | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Partial<TeamMateRuntimeHandle>;
  return (
    isNullableString(r.provider_ref) &&
    isNullableString(r.session_id) &&
    isNullableString(r.thread_id) &&
    (r.state === null ||
      r.state === undefined ||
      r.state === 'starting' ||
      r.state === 'running' ||
      r.state === 'stopped' ||
      r.state === 'orphaned') &&
    (r.last_seen_at === null ||
      r.last_seen_at === undefined ||
      isFiniteNumber(r.last_seen_at))
  );
}

function isNullableTeam(
  value: unknown,
): value is TeamMateTeamRef | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Partial<TeamMateTeamRef>;
  return (
    isNullableString(t.team_id) &&
    isNullableString(t.epic_id) &&
    isNullableString(t.role) &&
    isNullableString(t.leader_task_id)
  );
}

function isNullableClose(
  value: unknown,
): value is TeamMateTaskClose | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Partial<TeamMateTaskClose>;
  return (
    isCloseStatus(c.status) &&
    (c.note === null || typeof c.note === 'string') &&
    isFiniteNumber(c.at)
  );
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

function validateOptionalBounded(
  value: string | undefined,
  label: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === '') return null;
  return validateBoundedString(value, label, maxLength);
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

function validateOptionalTargetMode(
  value: TeamMateTargetMode | undefined,
): TeamMateTargetMode | null {
  if (value === undefined) return null;
  if (!TEAMMATE_TARGET_MODES.includes(value)) {
    throw new Error(
      `target_mode must be one of ${TEAMMATE_TARGET_MODES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Resolve and contain a task target path against the dispatcher directory
 * (issue #126 owner decision). Absolute and relative paths are both accepted;
 * relative paths resolve against `dispatcherDir`, the result is lexically
 * canonicalized (`..`/`.` collapsed), and it must land inside `dispatcherDir`.
 * The path is local state and must be kept out of public artifacts. Symlink
 * (realpath) hardening is deferred to the worker slice, where the path is
 * actually used and is guaranteed to exist.
 */
export function resolveTeammateTarget(
  rawPath: string,
  dispatcherDir: string,
): TeamMateTaskTarget {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('target.path must be a non-empty string');
  }
  if (rawPath.length > MAX_TARGET_PATH_LENGTH) {
    throw new Error(
      `target.path must be at most ${MAX_TARGET_PATH_LENGTH} characters`,
    );
  }
  if (rawPath.includes('\0')) {
    throw new Error('target.path must not contain a null byte');
  }
  if (
    typeof dispatcherDir !== 'string' ||
    dispatcherDir.trim() === '' ||
    !isAbsolute(dispatcherDir)
  ) {
    throw new Error(
      'dispatcher working directory is not configured; cannot resolve a path ' +
        'target',
    );
  }
  const baseDir = resolve(dispatcherDir);
  const resolved = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(baseDir, rawPath);
  const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (resolved !== baseDir && !resolved.startsWith(prefix)) {
    throw new Error(
      'target.path must resolve to a location inside the dispatcher directory',
    );
  }
  return { kind: 'path', path: resolved };
}

/**
 * Validate the shape of an already-resolved target stored on a task. Resolution
 * and containment happen upstream in {@link resolveTeammateTarget}; this only
 * guards the stored record against a malformed value.
 */
export function validateTarget(target: TeamMateTaskTarget): TeamMateTaskTarget {
  if (target === null || typeof target !== 'object') {
    throw new Error('target must be an object');
  }
  if (target.kind !== 'path') {
    throw new Error("target.kind must be 'path'");
  }
  const raw = target.path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('target.path must be a non-empty string');
  }
  if (!isAbsolute(raw)) {
    throw new Error('target.path must be an absolute path');
  }
  return { kind: 'path', path: raw };
}

export function isTeamMateTaskStatus(
  value: unknown,
): value is TeamMateTaskStatus {
  return TEAMMATE_TASK_STATUSES.includes(value as TeamMateTaskStatus);
}

function isLegacyTaskStatus(value: unknown): value is TeamMateTaskStatus {
  return TEAMMATE_TASK_STATUSES.includes(value as TeamMateTaskStatus);
}

export function isTeamMateLifecycleStatus(
  value: unknown,
): value is TeamMateLifecycleStatus {
  return TEAMMATE_LIFECYCLE_STATUSES.includes(value as TeamMateLifecycleStatus);
}

function isLifecycleStatus(value: unknown): value is TeamMateLifecycleStatus {
  return TEAMMATE_LIFECYCLE_STATUSES.includes(value as TeamMateLifecycleStatus);
}

function isDeliveryStatus(value: unknown): value is TeamMateDeliveryStatus {
  return TEAMMATE_DELIVERY_STATUSES.includes(value as TeamMateDeliveryStatus);
}

function isInputMode(value: unknown): value is TeamMateInputMode {
  return TEAMMATE_INPUT_MODES.includes(value as TeamMateInputMode);
}

function isEventType(value: unknown): value is TeamMateEventType {
  return TEAMMATE_EVENT_TYPES.includes(value as TeamMateEventType);
}

function isCloseStatus(value: unknown): value is TeamMateCloseStatus {
  return TEAMMATE_CLOSE_STATUSES.includes(value as TeamMateCloseStatus);
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

function isLegacyHistory(value: unknown): value is LegacyV1HistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        isLegacyTaskStatus((entry as Partial<LegacyV1HistoryEntry>).status) &&
        isFiniteNumber((entry as Partial<LegacyV1HistoryEntry>).at) &&
        ((entry as Partial<LegacyV1HistoryEntry>).message === undefined ||
          typeof (entry as Partial<LegacyV1HistoryEntry>).message === 'string'),
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
    target: task.target === null ? null : { ...task.target },
    team: cloneTeam(task.team),
    events: task.events.map(cloneEvent),
    inputs: task.inputs.map(cloneInput),
    runtime: task.runtime === null ? null : { ...task.runtime },
    result: task.result === null ? null : { ...task.result },
    delivery: task.delivery === null ? null : { ...task.delivery },
    close: task.close === null ? null : { ...task.close },
  };
}

function cloneTeam(
  team: TeamMateTeamRef | null | undefined,
): TeamMateTeamRef | null {
  return team === null || team === undefined ? null : { ...team };
}

function cloneEvent(event: TeamMateTaskEvent): TeamMateTaskEvent {
  return {
    event_id: event.event_id,
    type: event.type,
    at: event.at,
    ...(event.input_id !== undefined ? { input_id: event.input_id } : {}),
    ...(event.message !== undefined ? { message: event.message } : {}),
  };
}

function cloneInput(input: TeamMateTaskInput): TeamMateTaskInput {
  return { ...input };
}

function versionForMessage(value: unknown): string {
  return value === undefined ? 'missing' : JSON.stringify(value);
}
