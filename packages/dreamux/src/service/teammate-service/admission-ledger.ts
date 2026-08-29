/**
 * Core's one bounded, process-local duplicate-admission ledger.
 *
 * Deduplication is Core's. The Agent Runtime seam carries only text, so a
 * Provider has no source identity to deduplicate with and never returns a
 * `duplicate` admission. Core reserves the key *before* runtime admission,
 * which is what keeps a repeat from creating a second `RuntimeSubmission` or a
 * second turn id.
 *
 * A key is `[target entity, source id]` and nothing else. There is no
 * invocation-origin scope in it: the owner that picks a source id — a Channel
 * message id, a cron fire counter, a restart notice — is the owner responsible
 * for it being stable and distinguishable, and a scope component only ever
 * split one owner's window into several. Core does not need to understand where
 * a submission came from to refuse a repeat of it.
 *
 * One ledger serves the whole Dispatcher. It has to outlive any single entity's
 * service object, which is deleted and rematerialized on reopen or retire, and
 * a per-entity child ledger would grow a second registry with every entity the
 * process ever hosted. The committed window is global and bounded for the same
 * reason.
 *
 * The ledger is deliberately process-local: it carries no cross-restart
 * delivery guarantee.
 */
import type { TurnAdmission } from './turn-recording.js';

/**
 * Committed keys retained across the whole Dispatcher. Bounded so a long-lived
 * process cannot grow the ledger without limit; the depth matches what the
 * per-entity ledgers held before deduplication became one window.
 */
export const ADMISSION_SOURCE_WINDOW = 1024;

/** Identifies the one agent entity a submission targets. */
export interface AgentEntityLedgerKey {
  readonly dispatcherId: string;
  readonly teamId: string | null;
  readonly name: string;
}

/**
 * Encode a tuple of components as one map key, injectively.
 *
 * Components are arbitrary operator-, Channel-, and source-supplied strings, so
 * they are never concatenated with a delimiter. JSON encodes both the component
 * boundaries and the tuple length, so no component value can forge another
 * tuple's key and no component character is forbidden.
 */
function tupleKey(components: readonly (string | null)[]): string {
  return JSON.stringify(components);
}

export class AdmissionLedger {
  private readonly committed = new Set<string>();
  private readonly committedOrder: string[] = [];
  private readonly pending = new Map<string, Promise<TurnAdmission>>();

  /**
   * Admit `operation` under `entity` and `sourceId`.
   *
   * An omitted or empty source id bypasses the ledger entirely. A repeat that
   * arrives while the first admission is still pending awaits that same
   * admission — and therefore observes the same turn. A repeat after
   * `submitted` or `ambiguous` returns `duplicate` without touching the
   * runtime. `failed`, `stopped`, and `skipped` release the key so a real retry
   * is still possible.
   */
  admit(
    entity: AgentEntityLedgerKey,
    sourceId: string | undefined,
    operation: () => Promise<TurnAdmission>,
  ): Promise<TurnAdmission> {
    if (sourceId === undefined || sourceId === '') return operation();
    // `teamId` stays nullable in the tuple: JSON keeps a team-less entity
    // distinct from one whose team id is the empty string.
    const key = tupleKey([
      entity.dispatcherId,
      entity.teamId,
      entity.name,
      sourceId,
    ]);
    if (this.committed.has(key)) {
      return Promise.resolve({ status: 'duplicate' });
    }
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return inFlight;
    const task = Promise.resolve().then(operation);
    this.pending.set(key, task);
    void task.then(
      (admission) => {
        this.release(key, task, admission.status);
      },
      () => {
        // A rejection is pre-admission. Everything past the runtime boundary is
        // owned by the turn coordinator, which turns a failed or uncertain
        // provider submit into an explicit `failed` / `ambiguous` TurnAdmission
        // instead of a thrown error. So a throw here means the submission never
        // reached the Provider seam — start or materialization — and the
        // reservation must be released so a genuine retry still works.
        this.releaseUncommitted(key, task);
      },
    );
    return task;
  }

  private release(
    key: string,
    task: Promise<TurnAdmission>,
    status: TurnAdmission['status'],
  ): void {
    if (status === 'submitted' || status === 'ambiguous') this.commit(key);
    this.releaseUncommitted(key, task);
  }

  private releaseUncommitted(key: string, task: Promise<TurnAdmission>): void {
    if (this.pending.get(key) === task) this.pending.delete(key);
  }

  private commit(key: string): void {
    if (this.committed.has(key)) return;
    this.committed.add(key);
    this.committedOrder.push(key);
    while (this.committedOrder.length > ADMISSION_SOURCE_WINDOW) {
      const evicted = this.committedOrder.shift();
      if (evicted !== undefined) this.committed.delete(evicted);
    }
  }
}
