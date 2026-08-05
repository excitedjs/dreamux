import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamStore } from '../src/service/team-collection/store.js';
import {
  TeamDissolveInterruptedError,
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

describe('Team dissolve quiescence and shutdown', () => {
  it('interrupts an idle wait as recoverable shutdown suspension', async () => {
    const idle = deferred<void>();
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      createRuntime: () => new FakeRuntime({ waitIdle: () => idle.promise }),
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'shutdown-safe close',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'resume after restart',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await waitFor(() => runtimes.length === 1);
    teams.interruptDissolvesForShutdown();
    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'waiting_for_team_idle', last_error: null },
    });
    await teams.stopAll();
  });

  it('keeps the gate and durable phase when shutdown interrupts revalidation', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    const assessmentEntered = deferred<void>();
    const finishAssessment = deferred<{
      status: 'blocked';
      reason: 'dirty';
      worktree: Awaited<ReturnType<WorktreeManager['cleanup']>>;
    }>();
    let assessmentCount = 0;
    vi.spyOn(worktrees, 'assessCleanup').mockImplementation(async () => {
      assessmentCount += 1;
      if (assessmentCount === 1) return { status: 'eligible' };
      assessmentEntered.resolve();
      return finishAssessment.promise;
    });
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'suspend during worktree revalidation',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'resume revalidation after restart',
      requester: { kind: 'dispatcher' },
    });
    const record = (await new TeamStore().get('dispatcher-a', 'alpha'))!;
    teams.startAcceptedDissolve(accepted, (input) =>
      teams.closeAcceptedResources(input),
    );
    await assessmentEntered.promise;
    teams.interruptDissolvesForShutdown();
    finishAssessment.resolve({
      status: 'blocked',
      reason: 'dirty',
      worktree: {
        ...record.worktree,
        cleanup_state: 'retained-dirty',
        cleanup_error: null,
      },
    });

    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'waiting_for_team_idle', last_error: null },
    });
    await expect(teams.sendToLeader('alpha', {
      prompt: 'must remain fenced during shutdown',
      initiator: new FakeInitiator(),
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    await teams.stopAll();
  });

  it('interrupts an accepted operation across the accept-to-start shutdown race', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    let shuttingDown = false;
    const teams = makeTeams({
      runtimes,
      worktrees,
      isShuttingDown: () => shuttingDown,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'shutdown between accept and start',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'resume accepted close after restart',
      requester: { kind: 'dispatcher' },
    });

    shuttingDown = true;
    teams.interruptDissolvesForShutdown();
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    expect(() => teams.startAcceptedDissolve(accepted, close)).not.toThrow();
    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'waiting_for_team_idle', last_error: null },
    });
    await teams.stopAll();
  });

  it('treats a joined start after runner suspension as idempotent', async () => {
    const idle = deferred<void>();
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      createRuntime: () => new FakeRuntime({ waitIdle: () => idle.promise }),
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'join shutdown suspension',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'suspend one joined operation',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    const joined = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'first note still wins',
      requester: { kind: 'dispatcher' },
    });
    expect(joined).toBe(accepted);

    teams.interruptDissolvesForShutdown();
    await expect(joined.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: {
        operation_id: accepted.operationId,
        phase: 'waiting_for_team_idle',
        note: 'suspend one joined operation',
      },
    });
    expect(() => teams.startAcceptedDissolve(joined, close)).not.toThrow();
    expect(close).not.toHaveBeenCalled();
    await teams.stopAll();
  });

  it('re-quiesces recovered live writers before resuming closing_resources', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover resource close',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'crash after close began',
      requester: { kind: 'dispatcher' },
    });
    const store = new TeamStore();
    const record = (await store.get('dispatcher-a', 'alpha'))!;
    await store.update(record, {
      dissolve: {
        ...record.dissolve!,
        phase: 'closing_resources',
      },
      expectedDissolveOperationId: accepted.operationId,
    });
    await first.stopAll();

    const leaderIdle = deferred<void>();
    const memberIdle = deferred<void>();
    let runtimeIndex = 0;
    let waitCount = 0;
    const recoveredRuntimes: FakeRuntime[] = [];
    const recoveredWorktrees = new WorktreeManager();
    terminalAssessments(recoveredWorktrees);
    const recovered = makeTeams({
      runtimes: recoveredRuntimes,
      worktrees: recoveredWorktrees,
      createRuntime: () => {
        const idle = runtimeIndex++ === 0 ? leaderIdle : memberIdle;
        return new FakeRuntime({
          waitIdle: () => {
            waitCount += 1;
            return idle.promise;
          },
        });
      },
    });
    const close = vi.fn((input) => recovered.closeAcceptedResources(input));
    await recovered.recoverDissolves(close);
    const joined = await recovered.acceptDissolve({
      teamId: 'alpha',
      note: 'join recovered close',
      requester: { kind: 'dispatcher' },
    });
    await waitFor(() => waitCount === 2);
    expect(close).not.toHaveBeenCalled();
    leaderIdle.resolve();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    memberIdle.resolve();
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: {
          operation_id: joined.operationId,
          phase: 'complete',
        },
      });
    });
    await expect((await recovered.get('alpha')).status()).resolves
      .toMatchObject({ team: { status: 'closed' } });
    expect(close).toHaveBeenCalledTimes(1);
    await recovered.stopAll();
  });
});
