import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AGENT_TASK_SOURCE } from '../src/service/submission-sources.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { TeamService } from '../src/service/team-service/index.js';
import type { TeamServiceDeps } from '../src/service/team-service/types.js';
import type { TeammateService } from '../src/service/teammate-service/index.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';

/**
 * The leader an open Team answers with comes from the identity at its root.
 *
 * A dissolve that attempted the leader close and then failed to write a closed
 * record leaves a Team that still exists over resources that really are closed.
 * Nothing is restored: the Team lets the old wrapper go, and the next ordinary
 * use builds a leader from the identity still on disk.
 */
const DISPATCHER = 'dispatcher-1';
const TEAM = 'alpha';
const LEADER = 'alpha-leader';

const silentLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLog,
} as unknown as TeamServiceDeps['log'];

/** The Team's private leader slot, as the entity itself holds it. */
type LeaderSlot = { leader_: TeammateService | null };

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function teamRecord(teamRoot: string): TeamRecord {
  const now = Date.now();
  return {
    version: 1,
    dispatcher_id: DISPATCHER,
    team_id: TEAM,
    name: TEAM,
    repo_cwd: teamRoot,
    source_repo: null,
    leader_name: LEADER,
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
}

async function bootTeam(): Promise<{
  service: TeamService;
  slot: LeaderSlot;
  /** The leader identity exactly as it is on disk right now. */
  durableLeader: () => Promise<AgentEntityIdentity | null>;
  failCommit: (fail: boolean) => void;
  dissolveSettled: () => Promise<void>;
}> {
  const teamRoot = await mkdtemp(join(tmpdir(), 'dreamux-team-'));
  roots.push(teamRoot);
  let record = teamRecord(teamRoot);
  const identities = new AgentIdentityStore({
    dir: teamRoot,
    dispatcherId: DISPATCHER,
    expectedName: null,
    log: silentLog,
  });
  await identities.create({
    name: LEADER,
    teamId: TEAM,
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

  let fail = true;
  // A dissolve runs behind its receipt, so the only thing a caller can observe
  // is the Team stating the failure. That is what these tests wait on.
  const waiters: Array<() => void> = [];
  const settleAll = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  const deps = {
    dispatcherId: DISPATCHER,
    config: { agents: {} },
    agentRuntimeProviders: {},
    worktrees: { assessCleanup: async () => ({ status: 'eligible' }) },
    teamRoot,
    names: {},
    admissions: {},
    completionDelivery: {},
    leaderCompletionInitiator: async () => null,
    admitOperation: <T>(task: () => Promise<T>) => task(),
    leaderMcp: () => ({}),
    store: {
      get: async () => record,
      update: async (previous: TeamRecord, patch: Partial<TeamRecord> & { status?: string }) => {
        if (fail && patch.status === 'closed') {
          throw new Error('store write failed');
        }
        record = { ...previous, ...patch } as TeamRecord;
        return record;
      },
      publishRosterState: () => {},
    },
    log: { ...silentLog, error: () => { settleAll(); } },
    workflowLog: silentLog,
  } as unknown as TeamServiceDeps;

  const { service } = await TeamService.rebuild(deps, record);
  return {
    service,
    slot: service as unknown as LeaderSlot,
    durableLeader: () => identities.read(),
    failCommit: (next: boolean) => {
      fail = next;
    },
    dissolveSettled: () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
  };
}

const dissolveInput = {
  requester: 'dispatcher' as const,
  force: false,
  note: 'bye',
};

describe('a Team whose dissolve never committed a closed record', () => {
  it('lets the closed leader wrapper go instead of putting it back', async () => {
    const team = await bootTeam();
    const original = team.slot.leader_;
    expect(original).not.toBeNull();

    const settled = team.dissolveSettled();
    team.service.dissolve(dissolveInput);
    await settled;

    // Its phase is not authoritative any more; the identity on disk is — and
    // that identity really is closed, because nothing put the close back.
    expect(team.slot.leader_).toBeNull();
    expect((await team.durableLeader())?.status).toBe('closed');
  });

  it('materializes the same leader again on the next ordinary use', async () => {
    const team = await bootTeam();
    const original = team.slot.leader_;

    const settled = team.dissolveSettled();
    team.service.dissolve(dissolveInput);
    await settled;

    const status = await team.service.status();

    const restored = team.slot.leader_;
    expect(restored).not.toBeNull();
    // A different object over the same durable identity: same name, same
    // provider session, same creation, never rewritten or restamped.
    expect(restored).not.toBe(original);
    expect(status.leader?.name).toBe(LEADER);
    expect(restored?.current().session_id).toBe('provider-session-1');
    expect(restored?.current().created_at).toBe(original?.current().created_at);
  });

  it('builds one leader when two ordinary uses arrive together', async () => {
    const team = await bootTeam();

    const settled = team.dissolveSettled();
    team.service.dissolve(dissolveInput);
    await settled;

    const read = vi.spyOn(
      (team.service as unknown as { leaderIdentity: AgentIdentityStore }).leaderIdentity,
      'read',
    );
    let reads: number;
    try {
      const [first, second] = await Promise.all([
        team.service.status(),
        team.service.status(),
      ]);
      expect(first.leader?.name).toBe(LEADER);
      expect(second.leader?.name).toBe(LEADER);
      reads = read.mock.calls.length;
    } finally {
      read.mockRestore();
    }

    // One read of the leader identity, so one wrapper. Two would be two Agents
    // over one identity, each with its own runtime generation.
    expect(reads).toBe(1);
  });

  it('submits through the leader it materialized', async () => {
    const team = await bootTeam();

    const settled = team.dissolveSettled();
    team.service.dissolve(dissolveInput);
    await settled;

    await team.service.status();
    const restored = team.slot.leader_;
    expect(restored).not.toBeNull();
    const submitInput = vi
      .spyOn(restored as TeammateService, 'submitInput')
      .mockResolvedValue({ status: 'skipped' });

    await team.service.submitToLeader({
      source: AGENT_TASK_SOURCE,
      text: 'work for the restored leader',
    });

    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(team.slot.leader_).toBe(restored);
  });

  it('can be dissolved again, closing the leader it materializes', async () => {
    const team = await bootTeam();

    const failed = team.dissolveSettled();
    team.service.dissolve(dissolveInput);
    await failed;
    expect(team.slot.leader_).toBeNull();

    team.failCommit(false);
    const closed = new Promise<void>((resolve) => {
      team.service.onClosed(() => {
        resolve();
      });
    });
    team.service.dissolve(dissolveInput);
    await closed;

    expect(team.service.view().status).toBe('closed');
  });
});
