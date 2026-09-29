import { readFile } from 'node:fs/promises';

import { publishFileExclusive } from '@excitedjs/dreamux-utils';

import { appendJsonLine } from '../../platform/jsonl.js';
import type { WorkflowAgentRecord, WorkflowRunRecord } from './types.js';

export interface WorkflowTerminalJournalEvent {
  kind: 'end';
  status: 'completed' | 'failed' | 'stopped';
  result: unknown | null;
  error: string | null;
  ended_at: number;
}

export interface WorkflowAgentResultJournalEvent {
  kind: 'result';
  index: number;
  status: 'completed' | 'failed' | 'stopped';
  result: unknown | null;
  error: string | null;
  settled_at: number;
}

export type WorkflowJournalEvent =
  | {
      kind: 'run';
      version: 1;
      run_id: string;
      script_hash: string;
      caller: { kind: 'dispatcher' | 'team_leader' };
      dispatcher_id: string;
      team_id: string | null;
      created_at: number;
    }
  | {
      kind: 'submit';
      index: number;
      name: string;
      created_at: number;
    }
  | WorkflowAgentResultJournalEvent
  | {
      kind: 'phase' | 'log';
      message: string;
      created_at: number;
    }
  | WorkflowTerminalJournalEvent;

/** Serializes every write while leaving a failed operation retryable. */
export class WorkflowJournal {
  private tail: Promise<void> = Promise.resolve();
  private facts: WorkflowJournalFacts | null = null;

  constructor(private readonly path: string) {}

  create(event: Extract<WorkflowJournalEvent, { kind: 'run' }>): Promise<void> {
    return this.enqueue(async () => {
      try {
        const created = await publishFileExclusive(
          this.path,
          `${JSON.stringify(event)}\n`,
          { mode: 0o600 },
        );
        if (!created) {
          throw new Error(`workflow journal ${this.path} already exists`);
        }
        this.facts = { results: new Map(), terminal: null };
      } catch (error) {
        this.facts = null;
        throw error;
      }
    });
  }

  append(
    event: Exclude<WorkflowJournalEvent, { kind: 'result' | 'end' }>,
  ): Promise<void> {
    return this.enqueue(() => appendJsonLine(this.path, event));
  }

  terminal(): Promise<WorkflowTerminalJournalEvent | null> {
    return this.enqueue(async () => (await this.loadFacts()).terminal);
  }

  resultEvents(): Promise<readonly WorkflowAgentResultJournalEvent[]> {
    return this.enqueue(async () => [
      ...(await this.loadFacts()).results.values(),
    ]);
  }

  ensureAgentResult(
    event: WorkflowAgentResultJournalEvent,
  ): Promise<WorkflowAgentResultJournalEvent> {
    const expected = normalizeAgentResultEvent(event);
    return this.enqueue(async () => {
      const facts = await this.loadFacts();
      const existing = facts.results.get(expected.index);
      if (existing !== undefined) {
        if (!sameAgentResultEvent(existing, expected)) {
          throw new Error(
            `workflow journal ${this.path} has a conflicting result for Agent ${expected.index}`,
          );
        }
        return existing;
      }
      try {
        await appendJsonLine(this.path, expected);
      } catch (error) {
        this.facts = null;
        throw error;
      }
      facts.results.set(expected.index, expected);
      return expected;
    });
  }

  ensureTerminal(
    event: WorkflowTerminalJournalEvent,
  ): Promise<WorkflowTerminalJournalEvent> {
    const expected = normalizeTerminalEvent(event);
    return this.enqueue(async () => {
      const facts = await this.loadFacts();
      const existing = facts.terminal;
      if (existing === null) {
        try {
          await appendJsonLine(this.path, expected);
        } catch (error) {
          this.facts = null;
          throw error;
        }
        facts.terminal = expected;
        return expected;
      }
      if (!sameTerminalEvent(existing, expected)) {
        throw new Error(
          `workflow journal ${this.path} has a conflicting terminal event`,
        );
      }
      return existing;
    });
  }

  /**
   * Reconcile a stored `'running'` record, in place, against this run's own
   * journal.
   *
   * `record` is the caller's already-cloned draft (the store's committed
   * reference is never mutated in place — that stays the caller's own
   * invariant to hold) and `now` is the caller's one clock reading for this
   * reconciliation; this journal owns no clock of its own. Backfills a
   * `'stopped'` terminal when the journal never committed one, or completes
   * the record from an already-committed terminal event otherwise. Resolves
   * `true` when this run was backfilled to `'stopped'`, `false` when a
   * committed terminal already existed.
   */
  async recover(record: WorkflowRunRecord, now: number): Promise<boolean> {
    for (const result of await this.resultEvents()) {
      const agent = record.agents.find((item) => item.index === result.index);
      if (agent === undefined) {
        throw new Error(
          `workflow ${JSON.stringify(record.run_id)} journal has a result for unknown Agent ${result.index}`,
        );
      }
      if (
        agent.status !== 'queued' &&
        agent.status !== 'running' &&
        !agentMatchesJournalResult(agent, result)
      ) {
        throw new Error(
          `workflow ${JSON.stringify(record.run_id)} record conflicts with journal result for Agent ${result.index}`,
        );
      }
      agent.status = result.status;
      agent.result = result.result;
      agent.error = result.error;
      agent.settled_at = result.settled_at;
    }
    const committedTerminal = await this.terminal();
    if (committedTerminal === null) {
      const endedAt = now;
      record.status = 'stopped';
      record.result = null;
      record.error =
        'Dreamux stopped before the workflow reached a terminal result';
      record.ended_at = endedAt;
      record.updated_at = endedAt;
      for (const agent of record.agents) {
        if (agent.status !== 'queued' && agent.status !== 'running') continue;
        const result = await this.ensureAgentResult({
          kind: 'result',
          index: agent.index,
          status: 'stopped',
          result: null,
          error: record.error,
          settled_at: endedAt,
        });
        agent.status = result.status;
        agent.result = result.result;
        agent.error = result.error;
        agent.settled_at = result.settled_at;
      }
      await this.ensureTerminal({
        kind: 'end',
        status: 'stopped',
        result: null,
        error: record.error,
        ended_at: endedAt,
      });
      return true;
    }
    const activeAgent = record.agents.find(
      (agent) => agent.status === 'queued' || agent.status === 'running',
    );
    if (activeAgent !== undefined) {
      throw new Error(
        `workflow ${JSON.stringify(record.run_id)} terminal journal conflicts with active Agent ${activeAgent.index}`,
      );
    }
    record.status = committedTerminal.status;
    record.result = committedTerminal.result;
    record.error = committedTerminal.error;
    record.ended_at = committedTerminal.ended_at;
    record.updated_at = committedTerminal.ended_at;
    return false;
  }

  private async loadFacts(): Promise<WorkflowJournalFacts> {
    if (this.facts === null) {
      this.facts = parseJournalFacts(
        await readFile(this.path, 'utf8'),
        this.path,
      );
    }
    return this.facts;
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(write);
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

interface WorkflowJournalFacts {
  results: Map<number, WorkflowAgentResultJournalEvent>;
  terminal: WorkflowTerminalJournalEvent | null;
}

function parseJournalFacts(
  content: string,
  path: string,
): WorkflowJournalFacts {
  const facts: WorkflowJournalFacts = {
    results: new Map(),
    terminal: null,
  };
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid workflow journal row in ${path}`, {
        cause: error,
      });
    }
    if (!isObject(value)) continue;
    if (value['kind'] === 'result') {
      const parsed = normalizeAgentResultEvent({
        kind: 'result',
        index: nonNegativeInteger(value['index'], path),
        status: terminalStatus(value['status'], path),
        result: value['result'] ?? null,
        error: nullableString(value['error'], path),
        settled_at: finiteNumber(value['settled_at'], path),
      });
      if (facts.results.has(parsed.index)) {
        throw new Error(
          `workflow journal ${path} has multiple results for Agent ${parsed.index}`,
        );
      }
      facts.results.set(parsed.index, parsed);
      continue;
    }
    if (value['kind'] !== 'end') continue;
    const parsed = normalizeTerminalEvent({
      kind: 'end',
      status: terminalStatus(value['status'], path),
      result: value['result'] ?? null,
      error: nullableString(value['error'], path),
      ended_at: finiteNumber(value['ended_at'], path),
    });
    if (facts.terminal !== null) {
      throw new Error(`workflow journal ${path} has multiple terminal events`);
    }
    facts.terminal = parsed;
  }
  return facts;
}

function agentMatchesJournalResult(
  agent: WorkflowAgentRecord,
  result: WorkflowAgentResultJournalEvent,
): boolean {
  return (
    agent.status === result.status &&
    agent.settled_at === result.settled_at &&
    agent.error === result.error &&
    JSON.stringify(agent.result) === JSON.stringify(result.result)
  );
}

function normalizeAgentResultEvent(
  event: WorkflowAgentResultJournalEvent,
): WorkflowAgentResultJournalEvent {
  return {
    ...event,
    result: event.status === 'completed' ? (event.result ?? null) : null,
  };
}

function sameAgentResultEvent(
  left: WorkflowAgentResultJournalEvent,
  right: WorkflowAgentResultJournalEvent,
): boolean {
  return (
    left.index === right.index &&
    left.status === right.status &&
    left.settled_at === right.settled_at &&
    left.error === right.error &&
    JSON.stringify(left.result) === JSON.stringify(right.result)
  );
}

function normalizeTerminalEvent(
  event: WorkflowTerminalJournalEvent,
): WorkflowTerminalJournalEvent {
  return {
    ...event,
    result: event.status === 'completed' ? (event.result ?? null) : null,
  };
}

function sameTerminalEvent(
  left: WorkflowTerminalJournalEvent,
  right: WorkflowTerminalJournalEvent,
): boolean {
  return (
    left.status === right.status &&
    left.ended_at === right.ended_at &&
    left.error === right.error &&
    JSON.stringify(left.result) === JSON.stringify(right.result)
  );
}

function terminalStatus(
  value: unknown,
  path: string,
): WorkflowTerminalJournalEvent['status'] {
  if (value === 'completed' || value === 'failed' || value === 'stopped') {
    return value;
  }
  throw new Error(`invalid workflow terminal status in ${path}`);
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error(`invalid workflow terminal error in ${path}`);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`invalid workflow terminal timestamp in ${path}`);
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  throw new Error(`invalid workflow Agent index in ${path}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
