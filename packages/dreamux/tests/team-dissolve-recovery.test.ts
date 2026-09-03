import { describe, expect, it, vi } from 'vitest';

import { TeamClosing, type TeamClosingDeps } from '../src/service/team-service/closing.js';
import { leaderForOpenTeam, type TeamLeaderForTeamDeps } from '../src/service/team-service/leader-agent.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import type { SchedulerService } from '../src/service/scheduler/service.js';
import type { TeammateCollection } from '../src/service/teammate-collection/index.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import type { WorkflowService } from '../src/service/workflow-service/index.js';
import type {
  WorktreeCleanupAssessment,
  WorktreeManager,
} from '../src/service/worktree/manager.js';

/**
 * A Team is dissolved only when its record durably says closed. A dissolve that
 * never got there is not undone: every durable effect it already had stands,
 * and the Team simply becomes reachable again over whatever is really on disk.
 */
const silentLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
} as unknown as TeamClosingDeps['log'];

const record = {
  dispatcher_id: 'dispatcher-1',
  team_id: 'alpha',
  leader_name: 'alpha-leader',
  repo_cwd: '/repo',
  source_repo: null,
  status: 'running',
  worktree: { mode: 'reuse-cwd', path: '/repo' },
} as unknown as TeamRecord;

const eligible: WorktreeCleanupAssessment = { status: 'eligible' };

const blocked = (
  reason: 'dirty' | 'unmerged',
): WorktreeCleanupAssessment => ({
  status: 'blocked',
  reason,
  worktree: record.worktree,
});

interface ClosingHarness {
  closing: TeamClosing;
  order: string[];
  deleteStoreFile: ReturnType<typeof vi.fn>;
  workflowStart: ReturnType<typeof vi.fn>;
  schedulerStart: ReturnType<typeof vi.fn>;
  /** What the Team is currently holding for its leader, as `leader_` does. */
  held: () => TeammateService | null;
}

function harness(overrides: {
  commit?: () => Promise<TeamRecord>;
  deleteStoreFile?: () => Promise<void>;
  assess?: () => Promise<WorktreeCleanupAssessment>;
} = {}): ClosingHarness {
  const order: string[] = [];
  const wrapper = (): TeammateService => ({
    stopForHost: async () => { order.push('leader.stopForHost'); },
  }) as unknown as TeammateService;
  // Mirrors the Team's own wiring: a Team holding no wrapper materializes one
  // from the durable identity, lets it go, and only then closes it. The Team
  // starts out holding the one it was rebuilt with.
  let built = 1;
  let holding: TeammateService | null = wrapper();
  const materialize = (): TeammateService => {
    built += 1;
    order.push(`leader.materialize#${built}`);
    return wrapper();
  };
  const workflowStart = vi.fn(async () => { order.push('workflows.start'); });
  const schedulerStart = vi.fn(async () => { order.push('scheduler.start'); });
  const deleteStoreFile = vi.fn(async () => {
    order.push('scheduler.deleteStoreFile');
    await (overrides.deleteStoreFile?.() ?? Promise.resolve());
  });
  const deps: TeamClosingDeps = {
    teamId: 'alpha',
    dispatcherId: 'dispatcher-1',
    workflows: {
      closeAdmission: () => {},
      stopAll: async () => { order.push('workflows.stopAll'); },
      start: workflowStart,
    } as unknown as WorkflowService,
    scheduler: {
      stop: () => { order.push('scheduler.stop'); },
      start: schedulerStart,
      deleteStoreFile,
    } as unknown as SchedulerService,
    members: {
      stopAllForDissolve: async () => { order.push('members.stopAll'); },
      closeAllForDissolve: async () => { order.push('members.close'); },
    } as unknown as TeammateCollection,
    worktrees: {
      assessCleanup: overrides.assess ?? (async () => eligible),
    } as unknown as WorktreeManager,
    record: () => record,
    commit: overrides.commit ?? (async () => { order.push('record.commit'); return record; }),
    log: silentLog,
    leader: () => holding,
    closeLeaderForDissolve: async () => {
      const leader = holding ?? materialize();
      holding = null;
      order.push('leader.close');
      void leader;
    },
  };
  return {
    closing: new TeamClosing(deps),
    order,
    deleteStoreFile,
    workflowStart,
    schedulerStart,
    held: () => holding,
  };
}

const dissolveInput = {
  requester: 'dispatcher' as const,
  force: false,
  note: 'bye',
};

describe('a dissolve whose record never closed leaves the Team on disk', () => {
  it('cancels scheduled work with the scheduler, before the record commit', async () => {
    const h = harness({
      commit: async () => { throw new Error('store write failed'); },
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('store write failed');

    expect(h.order).toEqual([
      // stop
      'workflows.stopAll',
      'scheduler.stop',
      'members.stopAll',
      'leader.stopForHost',
      // close
      'workflows.stopAll',
      'scheduler.stop',
      'scheduler.deleteStoreFile',
      'members.close',
      'leader.close',
      // the record commit failed here
      'workflows.start',
      'scheduler.start',
    ]);
    // The deletion is not taken back, retried, or compensated for.
    expect(h.deleteStoreFile).toHaveBeenCalledTimes(1);
  });

  it('builds no leader and starts no runtime when the commit fails', async () => {
    const h = harness({
      commit: async () => { throw new Error('store write failed'); },
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('store write failed');

    // One wrapper existed and was closed. Nothing replaced it, and nothing was
    // started: the next ordinary use is what materializes a leader again.
    expect(h.order.filter((step) => step.startsWith('leader.materialize'))).toEqual([]);
    expect(h.held()).toBeNull();
  });

  it('reopens Workflow and scheduler admission from what survived', async () => {
    const h = harness({
      commit: async () => { throw new Error('store write failed'); },
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('store write failed');

    expect(h.workflowStart).toHaveBeenCalledTimes(1);
    expect(h.schedulerStart).toHaveBeenCalledTimes(1);
  });

  it('leaves every member closed rather than reopening them', async () => {
    const h = harness({
      commit: async () => { throw new Error('store write failed'); },
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('store write failed');

    expect(h.order.filter((step) => step.startsWith('members.'))).toEqual([
      'members.stopAll',
      'members.close',
    ]);
  });

  it('fails the dissolve when the cron store could not be deleted', async () => {
    const h = harness({
      deleteStoreFile: async () => { throw new Error('cron store delete failed'); },
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('cron store delete failed');

    // The surviving file is the durable fact, and only a Team that stayed open
    // is ever rebuilt to see it: admission comes back over exactly that state.
    expect(h.order).not.toContain('record.commit');
    expect(h.schedulerStart).toHaveBeenCalledTimes(1);
  });

  it('can be asked again, and the retry closes the leader it materializes', async () => {
    const commit = vi.fn(async (): Promise<TeamRecord> => {
      throw new Error('store write failed');
    });
    const h = harness({ commit });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow('store write failed');
    commit.mockImplementation(async () => record);
    await expect(h.closing.dissolve(dissolveInput)).resolves.toBeUndefined();

    expect(h.order.filter((step) => step === 'leader.close')).toHaveLength(2);
    expect(h.order.filter((step) => step.startsWith('leader.materialize'))).toEqual([
      'leader.materialize#2',
    ]);
    expect(h.deleteStoreFile).toHaveBeenCalledTimes(2);
  });
});

describe('a refusal before anything closes costs the Team nothing', () => {
  it('keeps the cron store when the dispatcher check refuses', async () => {
    const h = harness({
      assess: async () => blocked('dirty'),
    });

    await expect(h.closing.dissolve(dissolveInput)).rejects.toThrow(/is dirty/);

    expect(h.deleteStoreFile).not.toHaveBeenCalled();
    expect(h.order).toEqual([]);
    expect(h.held()).not.toBeNull();
  });

  it('keeps the cron store when the post-stop assessment refuses', async () => {
    const h = harness({
      assess: async () => blocked('unmerged'),
    });

    await expect(
      h.closing.dissolve({ ...dissolveInput, requester: 'team_leader' }),
    ).rejects.toThrow(/is unmerged/);

    expect(h.deleteStoreFile).not.toHaveBeenCalled();
    expect(h.order).not.toContain('leader.close');
    expect(h.held()).not.toBeNull();
  });
});

describe('an open Team materializes its leader from the identity at its root', () => {
  function leaderDeps(identity: AgentEntityIdentity | null): {
    deps: Omit<TeamLeaderForTeamDeps, 'identity'>;
    read: ReturnType<typeof vi.fn>;
  } {
    const read = vi.fn(async () => identity);
    return {
      deps: { identities: { read } } as unknown as Omit<TeamLeaderForTeamDeps, 'identity'>,
      read,
    };
  }

  it('refuses an identity that is not this Team\'s leader', async () => {
    const { deps } = leaderDeps({
      dispatcher_id: 'dispatcher-1',
      team_id: 'alpha',
      name: 'someone-else',
    } as unknown as AgentEntityIdentity);

    await expect(leaderForOpenTeam({ ...deps, record })).rejects.toThrow(
      'has no aligned TeamLeader identity',
    );
  });

  it('refuses a Team with no leader identity left on disk', async () => {
    const { deps, read } = leaderDeps(null);

    await expect(leaderForOpenTeam({ ...deps, record })).rejects.toThrow(
      'has no aligned TeamLeader identity',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
});
