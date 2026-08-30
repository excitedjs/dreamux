import type { TeamStore } from './store.js';
import type { WorktreeManager } from '../worktree/manager.js';

/**
 * Finish what a closed Team left in the filesystem, from its stored record.
 *
 * A closed Team is a record and nothing else: no `TeamService` is constructed
 * here, because there is no live Team left to construct. The dissolve that just
 * closed one and a later start that finds the same pending fact both enter
 * through {@link settle} and do exactly the same thing, since the record is the
 * only input either of them has.
 */
export class TeamWorktreeCleanup {
  constructor(
    private readonly opts: {
      store: TeamStore;
      worktrees: WorktreeManager;
    },
  ) {}

  /**
   * Reclaim the managed checkout this Team still owes.
   *
   * The Team's record is the only owner of that checkout and the only place its
   * result is written: the Agents that ran inside the directory never held a
   * copy of this fact, so there is nothing downstream to notify. A failure
   * throws without writing a second fact — the `cleanup-pending` one stands and
   * the next start finds the same work to do, which is why there is no retry
   * ledger.
   */
  async settle(teamId: string): Promise<void> {
    const record = await this.opts.store.get(teamId);
    if (record === null || record.worktree.cleanup_state !== 'cleanup-pending') {
      return;
    }
    const cleaned = await this.opts.worktrees.cleanup(
      {
        source_cwd: record.repo_cwd,
        source_repo: record.source_repo,
        worktree: record.worktree,
      },
      { force: record.worktree_cleanup_force },
    );
    if (cleaned.cleanup_state === 'retained-error') {
      throw new Error(
        cleaned.cleanup_error ?? 'managed worktree cleanup failed',
      );
    }
    // The authorization goes with the pending work it authorized.
    await this.opts.store.update(record, {
      worktree: { ...cleaned, cleanup_error: null },
      cleanupForce: false,
    });
  }
}
