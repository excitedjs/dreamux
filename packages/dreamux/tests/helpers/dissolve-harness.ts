import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { vi } from 'vitest';

import { AgentIdentityStore } from '../../src/service/agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../../src/service/agent-entity/types.js';
import { TeamService } from '../../src/service/team-service/index.js';
import { TeamClosing, type TeamClosingDeps } from '../../src/service/team-service/closing.js';
import type { TeamServiceDeps } from '../../src/service/team-service/types.js';
import type { TeammateService } from '../../src/service/teammate-service/index.js';
import type { SchedulerService } from '../../src/service/scheduler/service.js';
import type { TeammateCollection } from '../../src/service/teammate-collection/index.js';
import type { WorkflowService } from '../../src/service/workflow-service/index.js';
import type { TeamDissolveCommand, TeamRecord } from '../../src/service/team-collection/types.js';
import {
  reuseCwdWorktree,
  WorktreeManager,
  type WorktreeCleanupAssessment,
} from '../../src/service/worktree/manager.js';

/**
 * Shared fixtures for the dissolve coverage cell (Stage 9, node `team-dissolve`).
 *
 * Two boundaries are exercised across the three test files that use this
 * helper, and each gets its own harness style:
 *
 * - {@link TeamClosing} is the stop-and-close half of one Team. Its ordering
 *   contract (preflight before/after the stop it fences, the mandatory
 *   post-stop recheck, what `force` skips) is proven with {@link closingHarness},
 *   which mocks every collaborator and records the call order.
 * - {@link TeamService} is the one submission surface both a Dispatcher and a
 *   self-dissolving TeamLeader go through. Its receipt shape, its timing (the
 *   receipt returns before any stop runs), and its fence (a second submission
 *   never re-triggers the close) are proven with {@link bootDissolveTeam}, a
 *   real `TeamService` over a real identity store and a real (temp-rooted)
 *   Workflow/Scheduler pair.
 */

export const silentLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLog,
} as unknown as TeamClosingDeps['log'];

export const eligible: WorktreeCleanupAssessment = { status: 'eligible' };

export function blockedAssessment(
  reason: 'dirty' | 'unmerged',
  worktree: TeamRecord['worktree'],
): WorktreeCleanupAssessment {
  return { status: 'blocked', reason, worktree };
}

// ---------------------------------------------------------------------------
// TeamClosing-level harness: every collaborator mocked, call order recorded.
// ---------------------------------------------------------------------------

export interface ClosingHarness {
  closing: TeamClosing;
  /** Every collaborator call, in the order `TeamClosing` actually made it. */
  order: string[];
  /** How many worktree assessments this closing sequence performed. */
  assessCalls: () => number;
  commit: ReturnType<typeof vi.fn>;
  workflowStart: ReturnType<typeof vi.fn>;
  schedulerStart: ReturnType<typeof vi.fn>;
  leaderStopForHost: ReturnType<typeof vi.fn>;
}

/**
 * A `TeamClosing` wired to fakes for every collaborator it holds, recording
 * the order every fake was actually invoked in. `assessSequence` is consumed
 * FIFO (repeating its last entry once exhausted), so a test can make the
 * TeamLeader check pass and the final post-stop assessment fail.
 */
export function closingHarness(overrides: {
  record?: TeamRecord;
  assessSequence?: WorktreeCleanupAssessment[];
  commit?: () => Promise<TeamRecord>;
  deleteStoreFile?: () => Promise<void>;
} = {}): ClosingHarness {
  const record = overrides.record ?? fakeTeamRecord();
  const order: string[] = [];
  let assessCallCount = 0;
  const sequence = overrides.assessSequence ?? [eligible];
  const assessCleanup = vi.fn(async (): Promise<WorktreeCleanupAssessment> => {
    order.push('assess');
    assessCallCount += 1;
    const index = Math.min(assessCallCount - 1, sequence.length - 1);
    return sequence[index] ?? eligible;
  });
  const leaderStopForHost = vi.fn(async () => {
    order.push('leader.stopForHost');
  });
  const leaderClose = vi.fn(async () => {
    order.push('leader.close');
  });
  const workflowStart = vi.fn(async () => {
    order.push('workflows.start');
  });
  const schedulerStart = vi.fn(async () => {
    order.push('scheduler.start');
  });
  const commit = vi.fn(
    overrides.commit ?? (async () => {
      order.push('record.commit');
      return record;
    }),
  );
  const deleteStoreFile = vi.fn(async () => {
    order.push('scheduler.deleteStoreFile');
    await (overrides.deleteStoreFile?.() ?? Promise.resolve());
  });

  const deps: TeamClosingDeps = {
    teamId: record.team_id,
    dispatcherId: record.dispatcher_id,
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
    worktrees: { assessCleanup } as unknown as WorktreeManager,
    record: () => record,
    commit,
    log: silentLog,
    // A fixed, never-null leader wrapper: this harness is about *ordering*,
    // not about the leader-materialization churn `team-dissolve-recovery.test.ts`
    // already covers.
    leader: () => ({
      stopForHost: leaderStopForHost,
    }) as unknown as TeammateService,
    closeLeaderForDissolve: leaderClose,
  };
  return {
    closing: new TeamClosing(deps),
    order,
    assessCalls: () => assessCallCount,
    commit,
    workflowStart,
    schedulerStart,
    leaderStopForHost,
  };
}

export function fakeTeamRecord(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    dispatcher_id: 'dispatcher-1',
    team_id: 'alpha',
    leader_name: 'alpha-leader',
    repo_cwd: '/repo',
    source_repo: null,
    status: 'running',
    worktree: { mode: 'reuse-cwd', path: '/repo' },
    ...overrides,
  } as unknown as TeamRecord;
}

export const dispatcherDissolve: TeamDissolveCommand = {
  requester: 'dispatcher',
  force: false,
  note: 'bye',
};

export const teamLeaderDissolve: TeamDissolveCommand = {
  requester: 'team_leader',
  force: false,
  note: 'bye',
};

// ---------------------------------------------------------------------------
// TeamService-level harness: a real Team, over a real (temp-rooted) identity
// store, Workflow scope, and Scheduler/cron store.
// ---------------------------------------------------------------------------

export interface DissolveTeamHarness {
  service: TeamService;
  teamId: string;
  leaderName: string;
  /** This Team's own root directory — where its `cron-jobs.json` lives. */
  teamRoot: string;
  /** The leader wrapper the Team currently holds, exactly as the entity holds it. */
  leader: () => TeammateService | null;
  durableLeaderIdentity: () => Promise<AgentEntityIdentity | null>;
  setAssessment: (fn: () => Promise<WorktreeCleanupAssessment>) => void;
  setCommitFails: (fails: boolean) => void;
  /** Resolves once this Team's `closed` fact publishes. */
  waitClosed: () => Promise<void>;
  /** Resolves the next time a dissolve attempt logs a failure. */
  waitDissolveFailed: () => Promise<void>;
  cleanup: () => Promise<void>;
}

let dissolveHarnessCounter = 0;

/**
 * Boot one real `TeamService`, its leader already materialized from a durable
 * identity, exactly as `TeamCollection` would rebuild an open Team.
 *
 * `DREAMUX_ROOT` is redirected to a fresh temp directory for the lifetime of
 * this harness (restored by `cleanup()`), so the Team's real Workflow scope
 * and cron store never touch the operator's actual `~/.dreamux`.
 */
export async function bootDissolveTeam(): Promise<DissolveTeamHarness> {
  dissolveHarnessCounter += 1;
  const dispatcherId = `dissolve-harness-${dissolveHarnessCounter}`;
  const teamId = 'alpha';
  const leaderName = 'alpha-leader';

  const previousDreamuxRoot = process.env['DREAMUX_ROOT'];
  const stateHome = await mkdtemp(join(tmpdir(), 'dreamux-dissolve-state-'));
  process.env['DREAMUX_ROOT'] = stateHome;

  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-dissolve-team-'));

  const now = Date.now();
  let record: TeamRecord = {
    version: 1,
    dispatcher_id: dispatcherId,
    team_id: teamId,
    name: teamId,
    repo_cwd: teamRoot,
    source_repo: null,
    leader_name: leaderName,
    leader_agent_runtime: 'fake-runtime',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: teamRoot,
    worktree: reuseCwdWorktree(teamRoot),
    status: 'running',
    intent: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
    worktree_cleanup_force: false,
  };

  const identities = new AgentIdentityStore({
    dir: teamRoot,
    dispatcherId,
    expectedName: null,
    log: silentLog,
  });
  await identities.create({
    name: leaderName,
    teamId,
    agentRuntime: 'fake-runtime',
    sourceCwd: teamRoot,
    sourceRepo: null,
    cwd: teamRoot,
    runtimeCwd: teamRoot,
    worktree: reuseCwdWorktree(teamRoot),
    intent: null,
    identityPrompt: null,
    sessionId: 'provider-session-1',
    status: 'running',
  });

  let assess: () => Promise<WorktreeCleanupAssessment> = async () => eligible;
  let commitFails = false;

  const closedWaiters: Array<() => void> = [];
  const failureWaiters: Array<() => void> = [];

  const deps = {
    dispatcherId,
    config: { agents: {} },
    agentRuntimeProviders: {},
    worktrees: { assessCleanup: async () => assess() },
    teamRoot,
    names: {},
    admissions: {},
    completionDelivery: {},
    leaderCompletionInitiator: async () => null,
    admitOperation: <T>(task: () => Promise<T>) => task(),
    leaderMcp: () => ({}),
    store: {
      get: async () => record,
      update: async (
        previous: TeamRecord,
        patch: Partial<TeamRecord> & { status?: string },
      ) => {
        if (commitFails && patch.status === 'closed') {
          throw new Error('store write failed');
        }
        record = { ...previous, ...patch } as TeamRecord;
        return record;
      },
      publishRosterState: () => {},
    },
    log: {
      ...silentLog,
      error: () => {
        for (const waiter of failureWaiters.splice(0)) waiter();
      },
    },
    workflowLog: silentLog,
  } as unknown as TeamServiceDeps;

  const { service } = await TeamService.rebuild(deps, record);
  service.onClosed(() => {
    for (const waiter of closedWaiters.splice(0)) waiter();
  });

  return {
    service,
    teamId,
    leaderName,
    teamRoot,
    leader: () => (service as unknown as { leader_: TeammateService | null }).leader_,
    durableLeaderIdentity: () => identities.read(),
    setAssessment: (fn) => { assess = fn; },
    setCommitFails: (fails) => { commitFails = fails; },
    waitClosed: () =>
      new Promise<void>((resolve) => { closedWaiters.push(resolve); }),
    waitDissolveFailed: () =>
      new Promise<void>((resolve) => { failureWaiters.push(resolve); }),
    cleanup: async () => {
      if (previousDreamuxRoot === undefined) delete process.env['DREAMUX_ROOT'];
      else process.env['DREAMUX_ROOT'] = previousDreamuxRoot;
      await rm(stateHome, { recursive: true, force: true });
      await rm(teamRoot, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Real-git helpers for the `WorktreeManager` force/containment tests.
// ---------------------------------------------------------------------------

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd });
  return result.stdout;
}

/** Initialize a real, minimally-configured git repository with one commit. */
export async function initGitRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main']);
  await git(dir, ['config', 'user.email', 'dissolve-harness@example.com']);
  await git(dir, ['config', 'user.name', 'Dissolve Harness']);
  await execa('sh', ['-c', 'echo seed > seed.txt'], { cwd: dir });
  await git(dir, ['add', 'seed.txt']);
  await git(dir, ['commit', '-m', 'initial']);
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function newWorktreeManager(): WorktreeManager {
  return new WorktreeManager();
}
