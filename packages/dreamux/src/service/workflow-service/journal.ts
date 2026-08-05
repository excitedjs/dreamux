import { appendJsonLine } from '../../platform/jsonl.js';
import { writeFileExclusiveAtomic } from '../../platform/atomic-write.js';

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
      turn_id: string | null;
      created_at: number;
    }
  | {
      kind: 'result';
      index: number;
      status: 'completed' | 'failed' | 'stopped';
      settled_at: number;
    }
  | {
      kind: 'phase' | 'log';
      message: string;
      created_at: number;
    }
  | {
      kind: 'end';
      status: 'completed' | 'failed' | 'stopped';
      ended_at: number;
    };

/** Serializes every append and latches the first write failure. */
export class WorkflowJournal {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  create(event: Extract<WorkflowJournalEvent, { kind: 'run' }>): Promise<void> {
    this.tail = this.tail.then(async () => {
      const created = await writeFileExclusiveAtomic(
        this.path,
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      );
      if (!created) throw new Error(`workflow journal ${this.path} already exists`);
    });
    return this.tail;
  }

  append(event: WorkflowJournalEvent): Promise<void> {
    this.tail = this.tail.then(() => appendJsonLine(this.path, event));
    return this.tail;
  }
}
