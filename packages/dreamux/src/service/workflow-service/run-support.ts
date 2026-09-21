import { writeFileAtomic } from '../../platform/atomic-write.js';
import { workflowRunOutputPath } from '../../platform/paths.js';
import type { WorkflowAgentTally } from '../completion-router/index.js';
import type { WorkflowAgentOptions } from './protocol.js';
import type { WorkflowAgentRecord, WorkflowRunRecord } from './types.js';

/**
 * Write the terminal result where the caller is told to find it.
 *
 * The completion notification names this file instead of carrying the result,
 * so every terminal record has one: a run stopped with nobody to notify and a
 * run recovered as terminal after a restart included. It is rewritten
 * identically when the terminal task is retried.
 */
export async function publishWorkflowRunOutput(
  record: WorkflowRunRecord,
): Promise<string> {
  const path = workflowRunOutputPath({
    dispatcherId: record.dispatcher_id,
    teamId: record.team_id,
    runId: record.run_id,
  });
  const output = {
    run_id: record.run_id,
    status: record.status,
    result: record.result,
    error: record.error,
    agents: record.agents
      .filter((agent) => agent.name !== null)
      .map((agent) => ({ index: agent.index, name: agent.name })),
  };
  await writeFileAtomic(path, `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

/** Count how a run's Agents came out, for the one line that reports it. */
export function tallyWorkflowAgents(
  agents: readonly WorkflowAgentRecord[],
): WorkflowAgentTally {
  return {
    total: agents.length,
    succeeded: agents.filter((agent) => agent.status === 'completed').length,
    failed: agents.filter((agent) => agent.status === 'failed').length,
  };
}

export class WorkflowSemaphore {
  private active = 0;
  private closedError: Error | null = null;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  isFull(): boolean {
    return this.active >= this.limit;
  }

  acquire(): Promise<() => void> {
    if (this.closedError !== null) return Promise.reject(this.closedError);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  close(error: Error): void {
    if (this.closedError !== null) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter !== undefined && this.closedError === null) {
        waiter.resolve(this.releaseOnce());
      } else {
        this.active -= 1;
      }
    };
  }
}

export class WorkflowPersistenceError extends Error {}

export function normalizeAgentOptions(
  options: WorkflowAgentOptions,
): WorkflowAgentOptions {
  const normalized: WorkflowAgentOptions = {};
  for (const key of ['label', 'phase', 'agentType', 'intent', 'identity'] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`workflow agent option ${key} must be a string`);
    }
    normalized[key] = value;
  }
  if (options.schema !== undefined) {
    if (!isRecord(options.schema)) {
      throw new Error('workflow agent option schema must be an object');
    }
    normalized.schema = options.schema;
  }
  return normalized;
}

export function nonEmpty(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
