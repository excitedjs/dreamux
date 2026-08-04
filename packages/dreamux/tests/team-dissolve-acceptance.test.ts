import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamStore } from '../src/service/team-collection/store.js';
import {
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
  TeamUnavailableError,
} from '../src/service/team-collection/errors.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import {
  createTeamDissolveFixture,
  waitFor,
} from './helpers/team-dissolve-fixture.js';
import {
  deferred,
  FakeInitiator,
  FakeRuntime,
} from './helpers/fake-team-runtime.js';

let fixture: ReturnType<typeof createTeamDissolveFixture>;

beforeEach(() => {
  fixture = createTeamDissolveFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function makeTeams(
  input: Parameters<ReturnType<typeof createTeamDissolveFixture>['makeTeams']>[0],
) {
  return fixture.makeTeams(input);
}

function terminalAssessments(worktrees: WorktreeManager) {
  return fixture.terminalAssessments(worktrees);
}

describe('Team dissolve acceptance and availability', () => {
  it('persists before receipt, joins by generation, gates every work path, and waits for leader plus member', async () => {
    const leaderIdle = deferred<void>();
    const memberIdle = deferred<void>();
    let createdRuntime = 0;
    let leaderWaits = 0;
    let memberWaits = 0;
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    const assessments = terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      createRuntime: () => {
        const leader = createdRuntime++ === 0;
        return new FakeRuntime({
          waitIdle: () => {
            if (leader) {
              leaderWaits += 1;
              return leaderIdle.promise;
            }
            memberWaits += 1;
            return memberIdle.promise;
          },
        });
      },
    });
    const created = await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'finish alpha safely',
      prompt: 'lead alpha',
    });
    const team = await teams.get('alpha');
    await team.spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'write shared work',
      agentRuntime: 'agent-a',
    });
    const completion = await teams.completionInitiatorForLeader('alpha');
    expect(completion).not.toBeNull();

    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'first accepted note',
      requester: {
        kind: 'team_leader',
        leaderName: created.team.leader_name,
      },
    });
    const durable = await new TeamStore().get('dispatcher-a', 'alpha');
    expect(durable?.dissolve).toMatchObject({
      operation_id: accepted.operationId,
      note: 'first accepted note',
      phase: 'waiting_for_team_idle',
      leader_name: created.team.leader_name,
    });
    const activeProjection = {
      dissolve_phase: 'waiting_for_team_idle',
      dissolve_accepted_at: durable!.dissolve!.accepted_at,
      worktree_cleanup: 'not-managed',
      dissolve_error: null,
    };
    await expect(team.status()).resolves.toMatchObject({
      team: activeProjection,
    });
    await expect(teams.list()).resolves.toMatchObject([activeProjection]);
    await expect(teams.history({})).resolves.toMatchObject({
      items: [activeProjection],
    });
    const joined = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'must not replace the first note',
      requester: {
        kind: 'team_leader',
        leaderName: created.team.leader_name,
      },
    });
    expect(joined).toBe(accepted);
    await expect(teams.acceptDissolve({
      teamId: 'alpha',
      note: 'stale generation',
      requester: { kind: 'team_leader', leaderName: 'tl-stale' },
    })).rejects.toBeInstanceOf(TeamUnavailableError);

    await expect(teams.sendToLeader('alpha', {
      prompt: 'late send',
      initiator: new FakeInitiator(),
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    await expect(teams.deliverToLeader('alpha', {
      sourceId: 'late-inbound',
      text: 'late inbound',
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    await expect(
      teams.requireRoutableTeamProjection('alpha'),
    ).rejects.toBeInstanceOf(TeamUnavailableError);
    await expect(
      teams.withTeamLeaderLease({
        teamId: 'alpha',
        leaderName: created.team.leader_name,
      }, async () => undefined),
    ).rejects.toBeInstanceOf(TeamUnavailableError);
    await expect(team.workflows.run({ script: 'export default {}' }))
      .rejects.toThrow(/admission is closed/);
    const scheduler = await teams.scheduler('alpha');
    await expect(scheduler.create({
      cron: '0 * * * *',
      prompt: 'late cron',
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    await expect(completion!.completionInput({
      kind: 'teammate',
      source: 'worker',
      id: 'turn-1',
      status: 'completed',
      result: 'done',
    })).resolves.toMatchObject({ status: 'unsupported' });
    const readLease = await teams.teamLeaderReadLease('alpha');
    await expect(teams.withTeamLeaderReadLease(
      readLease,
      (service) => service.status(),
    )).resolves.toMatchObject({ team: { status: 'running' } });

    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await waitFor(() => leaderWaits === 1 && memberWaits === 1);
    expect(close).not.toHaveBeenCalled();
    leaderIdle.resolve();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    memberIdle.resolve();
    await expect(accepted.completed).resolves.toMatchObject({
      team: { status: 'closed', close_note: 'first accepted note' },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(assessments).toHaveBeenCalledTimes(2);
    await teams.stopAll();
  });

  it('does not let an older active-join snapshot regress the operation view', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    vi.spyOn(worktrees, 'assessCleanup').mockResolvedValue({
      status: 'eligible',
    });
    vi.spyOn(worktrees, 'cleanup').mockImplementation(async (identity) => ({
      ...identity.worktree,
      cleanup_state: 'retained-error',
      cleanup_error: 'keep cleanup pending',
    }));
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'join without regressing phase',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'first note',
      requester: { kind: 'dispatcher' },
    });

    const joinEntered = deferred<void>();
    const releaseJoin = deferred<void>();
    const get = teams.get.bind(teams);
    let blockNextGet = true;
    vi.spyOn(teams, 'get').mockImplementation(async (teamId) => {
      if (blockNextGet) {
        blockNextGet = false;
        joinEntered.resolve();
        await releaseJoin.promise;
      }
      return get(teamId);
    });
    const joining = teams.acceptDissolve({
      teamId: 'alpha',
      note: 'must keep first note and latest phase',
      requester: { kind: 'dispatcher' },
    });
    await joinEntered.promise;

    teams.startAcceptedDissolve(accepted, (input) =>
      teams.closeAcceptedResources(input),
    );
    await expect(accepted.logicalClosed).resolves.toMatchObject({
      team: { status: 'closed' },
    });
    expect(accepted.dissolveSnapshot().phase)
      .toBe('worktree_cleanup_pending');

    releaseJoin.resolve();
    await expect(joining).resolves.toBe(accepted);
    expect(accepted.dissolveSnapshot()).toMatchObject({
      note: 'first note',
      phase: 'worktree_cleanup_pending',
    });
    teams.interruptDissolvesForShutdown();
    await teams.stopAll();
  });

  it('rejects missing waitIdle and first-preflight blockers before any lifecycle mutation', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    const assessments = terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'protect alpha',
      prompt: 'lead',
    });
    Object.defineProperty(runtimes[0]!, 'waitIdle', {
      value: undefined,
      configurable: true,
    });
    await expect(teams.acceptDissolve({
      teamId: 'alpha',
      note: 'cannot prove idle',
      requester: { kind: 'dispatcher' },
    })).rejects.toBeInstanceOf(TeamDissolveFailedError);
    expect(assessments).not.toHaveBeenCalled();
    expect((await new TeamStore().get('dispatcher-a', 'alpha'))?.dissolve)
      .toBeNull();

    delete (runtimes[0] as unknown as { waitIdle?: unknown }).waitIdle;
    assessments.mockImplementation(async (identity) => ({
      status: 'blocked',
      reason: 'dirty',
      worktree: {
        ...identity.worktree,
        cleanup_state: 'retained-dirty',
      },
    }));
    await expect(teams.acceptDissolve({
      teamId: 'alpha',
      note: 'dirty worktree',
      requester: { kind: 'dispatcher' },
    })).rejects.toMatchObject({ reason: 'dirty' });
    expect((await new TeamStore().get('dispatcher-a', 'alpha'))?.dissolve)
      .toBeNull();
    await expect(teams.sendToLeader('alpha', {
      prompt: 'still available',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  });

  it('bounds route-lease admission and never persists a timed-out dissolve later', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    const assessments = terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    const created = await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'bounded dissolve admission',
      prompt: 'lead',
    });
    const leaseEntered = deferred<void>();
    const releaseLease = deferred<void>();
    const heldLease = teams.withTeamLeaderLease({
      teamId: 'alpha',
      leaderName: created.team.leader_name,
    }, async () => {
      leaseEntered.resolve();
      await releaseLease.promise;
    });
    await leaseEntered.promise;

    await expect(teams.acceptDissolve({
      teamId: 'alpha',
      note: 'must not arrive after deadline',
      requester: { kind: 'dispatcher' },
      decisionDeadlineAt: Date.now() + 25,
    })).rejects.toThrow(/deadline exceeded/);
    expect(assessments).not.toHaveBeenCalled();
    expect((await new TeamStore().get('dispatcher-a', 'alpha'))?.dissolve)
      .toBeNull();

    let laterLeaseSettled = false;
    const laterLease = teams.teamLeaderReadLease('alpha').then((lease) => {
      laterLeaseSettled = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(laterLeaseSettled).toBe(false);
    releaseLease.resolve();
    await heldLease;
    await expect(laterLease).resolves.toMatchObject({ teamId: 'alpha' });
    expect((await new TeamStore().get('dispatcher-a', 'alpha'))?.dissolve)
      .toBeNull();
    await teams.stopAll();
  });

  it('rejects dissolve while an ordinary Team route close owns the fence', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    const assessments = terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'single close owner',
      prompt: 'lead',
    });
    const ordinaryCloseEntered = deferred<void>();
    const releaseOrdinaryClose = deferred<void>();
    const ordinaryCloseTask = vi.fn(async () => {
      ordinaryCloseEntered.resolve();
      await releaseOrdinaryClose.promise;
    });
    const ordinaryClose = teams.withTeamRouteClosing(
      'alpha',
      ordinaryCloseTask,
    );
    await ordinaryCloseEntered.promise;

    await expect(teams.acceptDissolve({
      teamId: 'alpha',
      note: 'must not start a second close',
      requester: { kind: 'dispatcher' },
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    expect(ordinaryCloseTask).toHaveBeenCalledTimes(1);
    expect(assessments).not.toHaveBeenCalled();
    expect((await new TeamStore().get('dispatcher-a', 'alpha'))?.dissolve)
      .toBeNull();

    releaseOrdinaryClose.resolve();
    await ordinaryClose;
    await expect(teams.sendToLeader('alpha', {
      prompt: 'ordinary close released',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  });

  it('unwinds a second-preflight safety blocker and restores admission', async () => {
    const idle = deferred<void>();
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    let assessmentCount = 0;
    vi.spyOn(worktrees, 'assessCleanup').mockImplementation(async (identity) => {
      assessmentCount += 1;
      return assessmentCount === 1
        ? { status: 'eligible' as const }
        : {
            status: 'blocked' as const,
            reason: 'dirty' as const,
            worktree: {
              ...identity.worktree,
              cleanup_state: 'retained-dirty' as const,
            },
          };
    });
    const teams = makeTeams({
      runtimes,
      worktrees,
      createRuntime: () => new FakeRuntime({ waitIdle: () => idle.promise }),
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'second preflight',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'work changed after acceptance',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    idle.resolve();
    await expect(accepted.completed).rejects.toBeInstanceOf(
      TeamDissolveBlockedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'failed', last_error: 'worktree-dirty' },
    });
    await expect(teams.sendToLeader('alpha', {
      prompt: 'admission restored',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  });
});
