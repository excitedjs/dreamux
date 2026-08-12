import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamStore } from '../src/service/team-collection/store.js';
import {
  TeamDissolveFailedError,
  TeamDissolveInterruptedError,
  TeamUnavailableError,
} from '../src/service/team-collection/errors.js';
import { TeamService } from '../src/service/team-service/index.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { WorkflowStopInterruptedError } from '../src/service/workflow-service/run-terminal.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { childAgentRuntimeId } from '../src/service/agent-entity/runtime-profile.js';
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
  vi.restoreAllMocks();
});

function makeTeams(
  input: Parameters<ReturnType<typeof createTeamDissolveFixture>['makeTeams']>[0],
) {
  return fixture.makeTeams(input);
}

function terminalAssessments(worktrees: WorktreeManager) {
  return fixture.terminalAssessments(worktrees);
}

function memberRuntimeId(name: string): string {
  return childAgentRuntimeId({
    dispatcher_id: 'dispatcher-a',
    team_id: 'alpha',
    name,
  } as AgentEntityIdentity);
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

describe('Team dissolve owned-workflow stop', () => {
  it('stops Team-owned workflows before the captured-writer idle barrier', async () => {
    const runtimes: FakeRuntime[] = [];
    let idleWaits = 0;
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      createRuntime: () => new FakeRuntime({
        waitIdle: () => {
          idleWaits += 1;
          return Promise.resolve();
        },
      }),
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'workflow stop ordering',
      prompt: 'lead',
    });
    const stopGate = deferred<void>();
    let stopCalled = 0;
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing')
      .mockImplementation(async () => {
        stopCalled += 1;
        await stopGate.promise;
      });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'stop before idle',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await waitFor(() => stopCalled === 1);
    // The workflow stop runs first; the captured writers are not awaited
    // until it completes.
    expect(idleWaits).toBe(0);

    stopGate.resolve();
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: { phase: 'complete' },
      });
    });
    expect(idleWaits).toBeGreaterThan(0);
    expect(close).toHaveBeenCalledTimes(1);
    await teams.stopAll();
  });

  it('progresses past waiting_for_team_idle when a Workflow-owned TeamMate never settles', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      workflowStopGraceMs: 200,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'bounded workflow cancellation',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    await expect(service.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    })).resolves.toEqual({ run_id: expect.any(String) });
    await waitFor(() => runtimes.length === 2);

    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'close with a stuck workflow turn',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: { phase: 'complete' },
      });
    }, { timeout: 15_000 });
    expect(close).toHaveBeenCalledTimes(1);
    await teams.stopAll();
  }, 20_000);

  it('suspends the operation when shutdown interrupts the workflow stop', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'interrupt workflow stop',
      prompt: 'lead',
    });
    const stopGate = deferred<void>();
    let stopCalled = 0;
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing')
      .mockImplementation(async () => {
        stopCalled += 1;
        await stopGate.promise;
      });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'suspend during workflow stop',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await waitFor(() => stopCalled === 1);
    teams.interruptDissolvesForShutdown();
    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    stopGate.resolve();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'waiting_for_team_idle', last_error: null },
    });
    await teams.stopAll();
  });

  it('fails open in the initial phase when the Team-owned workflow stop fails', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'workflow stop fail-open',
      prompt: 'lead',
    });
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing')
      .mockRejectedValue(new Error('workflow stop failed'));
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'workflow stop fails before idle',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveFailedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'failed', last_error: 'resource-close-failed' },
    });
    // Fail-open restores Team admission for ordinary work.
    await expect(teams.sendToLeader('alpha', {
      prompt: 'admission restored',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  });

  it('defers a recovered close whose workflow stop fails before the idle barrier', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover workflow stop failure',
      prompt: 'lead',
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

    const recoveredRuntimes: FakeRuntime[] = [];
    const recoveredWorktrees = new WorktreeManager();
    terminalAssessments(recoveredWorktrees);
    const recovered = makeTeams({
      runtimes: recoveredRuntimes,
      worktrees: recoveredWorktrees,
    });
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing')
      .mockRejectedValue(new Error('workflow stop failed'));
    const close = vi.fn((input) => recovered.closeAcceptedResources(input));
    await recovered.recoverDissolves(close);
    // An already-closing operation routes the stop failure through the
    // existing deferred-retry phase contract instead of failing open.
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          phase: 'closing_resources',
          last_error: 'resource-close-failed',
          cleanup_attempts: 1,
          next_retry_at: expect.any(Number),
        },
      });
    });
    expect(close).not.toHaveBeenCalled();
    recovered.interruptDissolvesForShutdown();
    await recovered.stopAll();
  });

  it('defers a recovered waiting_for_team_idle operation whose workflow stop fails', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover accepted idle wait',
      prompt: 'lead',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'crash while waiting for team idle',
      requester: { kind: 'dispatcher' },
    });
    // Durable phase stays waiting_for_team_idle: the operation was accepted
    // before the crash, so restart recovery must defer retry, not fail open.
    await first.stopAll();

    const recoveredRuntimes: FakeRuntime[] = [];
    const recoveredWorktrees = new WorktreeManager();
    terminalAssessments(recoveredWorktrees);
    const recovered = makeTeams({
      runtimes: recoveredRuntimes,
      worktrees: recoveredWorktrees,
    });
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing')
      .mockRejectedValue(new Error('workflow stop failed'));
    const close = vi.fn((input) => recovered.closeAcceptedResources(input));
    await recovered.recoverDissolves(close);
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: accepted.operationId,
          phase: 'waiting_for_team_idle',
          last_error: 'resource-close-failed',
          cleanup_attempts: 1,
          next_retry_at: expect.any(Number),
        },
      });
    });
    expect(close).not.toHaveBeenCalled();
    recovered.interruptDissolvesForShutdown();
    await recovered.stopAll();
  });

  it('keeps a recovered accepted close fenced when the first deferred-retry marker persist fails', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover accepted idle wait marker failure',
      prompt: 'lead',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'crash while waiting for team idle',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    const recoveredRuntimes: FakeRuntime[] = [];
    const recoveredWorktrees = new WorktreeManager();
    vi.spyOn(recoveredWorktrees, 'assessCleanup').mockImplementation(
      async () => {
        throw new Error('worktree assessment failed');
      },
    );
    const recovered = makeTeams({
      runtimes: recoveredRuntimes,
      worktrees: recoveredWorktrees,
    });
    // Fail the first deferred-retry persist (the cleanup-attempt marker write)
    // exactly once, so the in-memory retry re-reads durable attempts=0.
    const originalUpdate = TeamStore.prototype.update;
    let failFirstAttemptPersist = true;
    vi.spyOn(TeamStore.prototype, 'update').mockImplementation(
      async function (this: TeamStore, team, input) {
        if (
          failFirstAttemptPersist &&
          input.dissolvePatch?.cleanup_attempts === 1
        ) {
          failFirstAttemptPersist = false;
          throw new Error('team store update failed');
        }
        return originalUpdate.call(this, team, input);
      },
    );
    const close = vi.fn((input) => recovered.closeAcceptedResources(input));
    await recovered.recoverDissolves(close);
    // The immutable recovered flag must keep the close deferred across the
    // marker persist failure — never fail-open a durably accepted Team.
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: accepted.operationId,
          phase: 'waiting_for_team_idle',
          last_error: 'worktree-assessment-failed',
          cleanup_attempts: 1,
          next_retry_at: expect.any(Number),
        },
      });
    }, { timeout: 5_000 });
    expect(close).not.toHaveBeenCalled();
    await expect(recovered.sendToLeader('alpha', {
      prompt: 'still fenced',
      initiator: new FakeInitiator(),
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    recovered.interruptDissolvesForShutdown();
    await recovered.stopAll();
  });

  it('does not relabel a same-process fresh accepted dissolve as recovered when startup recovery joins it', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'concurrent accept and recover',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'fresh accept before recovery joins',
      requester: { kind: 'dispatcher' },
    });
    // Startup recovery lands after the fresh accept and joins the same
    // operation object; it must not relabel it as recovered.
    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing').mockRejectedValue(
      new Error('workflow stop failed'),
    );
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    await teams.recoverDissolves(close);
    // The initial failure keeps fresh-dissolve semantics: fail open and
    // restore admission.
    await expect(accepted.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveFailedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: { phase: 'failed', last_error: 'resource-close-failed' },
    });
    await expect(teams.sendToLeader('alpha', {
      prompt: 'admission restored',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  });

  it('treats a preexisting durable dissolve materialized by an early same-instance join as recovery identity', async () => {
    // Prior process: a durably accepted dissolve survives the crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: an early team.dissolve active-join materializes the
    // preexisting durable record before startup recovery runs.
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
    });
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);

    vi.spyOn(TeamService.prototype, 'stopWorkflowsForClosing').mockRejectedValue(
      new Error('workflow stop failed'),
    );
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    await joined.recoverDissolves(close);
    // The joined operation carries recovery/resume identity: the stop failure
    // defers and keeps the accepted fence up, never fail-open.
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: durableAccepted.operationId,
          phase: 'waiting_for_team_idle',
          last_error: 'resource-close-failed',
          cleanup_attempts: 1,
          next_retry_at: expect.any(Number),
        },
      });
    });
    expect(close).not.toHaveBeenCalled();
    await expect(joined.sendToLeader('alpha', {
      prompt: 'still fenced',
      initiator: new FakeInitiator(),
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    joined.interruptDissolvesForShutdown();
    await joined.stopAll();
  });

  it('reattaches durable writers when an early same-instance join resumes a preexisting dissolve', async () => {
    // Prior process: team with a durable member; the dissolve was accepted
    // before the crash and survives durably.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: the early active-join resumes the preexisting dissolve
    // and must reattach the durable member runtime before cleanup waits on it.
    const memberIdle = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    let runtimeIndex = 0;
    let memberIdleWaits = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: () => {
        const isMember = runtimeIndex++ > 0;
        return new FakeRuntime({
          waitIdle: () => {
            if (!isMember) return Promise.resolve();
            memberIdleWaits += 1;
            return memberIdle.promise;
          },
        });
      },
    });
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    await joined.recoverDissolves(close);
    // The recovered idle barrier includes the reattached member: cleanup must
    // not start while its writer is still busy.
    await waitFor(() => memberIdleWaits >= 1);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: {
        operation_id: durableAccepted.operationId,
        phase: 'waiting_for_team_idle',
      },
    });
    memberIdle.resolve();
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: {
          operation_id: durableAccepted.operationId,
          phase: 'complete',
        },
      });
    });
    expect(close).toHaveBeenCalledTimes(1);
    await joined.stopAll();
  });

  it('never blocks the admin join on an uninterruptible recovered runtime start', async () => {
    // Prior process: durable member + accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: the recovered member's runtime start never settles. The
    // join must return promptly; the runner's recovery stage must race the
    // start against the operation interrupt.
    const neverStart = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    let runtimeIndex = 0;
    let memberStartAttempts = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: () => {
        const isMember = runtimeIndex++ > 0;
        return new FakeRuntime({
          ...(isMember
            ? {
                startGate: () => {
                  memberStartAttempts += 1;
                  return neverStart.promise;
                },
              }
            : {}),
        });
      },
    });
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    joined.startAcceptedDissolve(joinedAccept, close);
    await waitFor(() => memberStartAttempts >= 1);
    joined.interruptDissolvesForShutdown();
    await expect(joinedAccept.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    expect(close).not.toHaveBeenCalled();
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: {
        operation_id: durableAccepted.operationId,
        phase: 'waiting_for_team_idle',
      },
    });
    // The never-settling runtime start stays contained: it owns neither the
    // admin path (the join returned) nor the shared worktree (the operation
    // is suspended, not cleaning up).
  });

  it('never materializes dormant durable members when formal recovery joins a fresh operation', async () => {
    // Prior process: a durable member with NO accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'dormant member',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    await first.stopAll();

    // Same instance: a fresh accept captures only the live leader; formal
    // recovery joins it and must not start the dormant durable member. The
    // original captured-writer barrier remains authoritative.
    const leaderIdle = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    let runtimeIndex = 0;
    let memberCreated = 0;
    let leaderIdleWaits = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: () => {
        const isLeader = runtimeIndex++ === 0;
        if (!isLeader) memberCreated += 1;
        return new FakeRuntime({
          waitIdle: isLeader
            ? () => {
                leaderIdleWaits += 1;
                return leaderIdle.promise;
              }
            : undefined,
        });
      },
    });
    // Start the leader so the fresh accept's captured writer barrier is the
    // live [leader]; the dormant member must stay dormant.
    await (await joined.get('alpha')).leader.ensureStarted();
    const accepted = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'fresh accept in this process',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    await joined.recoverDissolves(close);
    await waitFor(() => leaderIdleWaits >= 1);
    // The join must not materialize the dormant member; only the captured
    // leader writer participates in the barrier.
    expect(memberCreated).toBe(0);
    leaderIdle.resolve();
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: {
          operation_id: accepted.operationId,
          phase: 'complete',
        },
      });
    });
    expect(close).toHaveBeenCalledTimes(1);
    await joined.stopAll();
  });

  it('latches a lease acquired during an active sweep as permanently invalid', async () => {
    // Prior process: durable member + accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const memberName = (await (await first.get('alpha')).teammates.list())[0]
      ?.name;
    const memberId = memberRuntimeId(memberName!);
    await first.stopAll();

    // Same instance: materialize the member with a gated start so a sweep
    // that stops it stays active while the start is pending.
    const allowStart = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    let startAttempts = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: (context) => {
        if (context.identity.runtime_id === memberId) {
          return new FakeRuntime({
            startGate: () => {
              startAttempts += 1;
              return allowStart.promise;
            },
          });
        }
        return new FakeRuntime();
      },
    });
    const collection = (await joined.get('alpha'))
      .teammates as unknown as TeammateCollection;
    const firstLease = collection.acquireOwnerCloseRecoveryLease();
    const recovery = collection.recoverLiveRuntimesForOwnerClose(firstLease);
    await waitFor(() => startAttempts >= 1);
    // Two overlapping sweeps both stop the member and stay active on its
    // pending start.
    const sweepOne = collection.stopAll();
    const sweepTwo = collection.stopAll();
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    const midSweepLease = collection.acquireOwnerCloseRecoveryLease();
    expect(midSweepLease.valid()).toBe(false);
    allowStart.resolve();
    await Promise.all([recovery, sweepOne, sweepTwo]);
    // The mid-sweep lease must remain invalid after the sweeps settle.
    expect(midSweepLease.valid()).toBe(false);
    // A fresh lease after settlement is eligible.
    const freshLease = collection.acquireOwnerCloseRecoveryLease();
    expect(freshLease.valid()).toBe(true);
    await joined.stopAll();
  });

  it('keeps a leader-blocked recovery from materializing members after the member sweep', async () => {
    // Prior process: two durable members + accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    const firstService = await first.get('alpha');
    await firstService.spawnTeamMate({
      name: 'worker-1',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    await firstService.spawnTeamMate({
      name: 'worker-2',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const memberNames = (await firstService.teammates.list())
      .map((member) => member.name)
      .sort();
    const leaderId = memberRuntimeId(firstService.leader.current().name);
    const aRuntimeId = memberRuntimeId(memberNames[0]!);
    const bRuntimeId = memberRuntimeId(memberNames[1]!);
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: the recovery lease is captured before the leader start.
    // The leader start blocks; the member sweep advances the generation while
    // stopLeader awaits the leader start. Releasing the leader must not let
    // the old continuation materialize any member.
    const allowLeaderStart = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    let leaderStartAttempts = 0;
    let aMaterialized = 0;
    let bMaterialized = 0;
    const originalMemberRecovery =
      TeammateCollection.prototype.recoverLiveRuntimesForOwnerClose;
    const memberRecoveryDone = deferred<void>();
    vi.spyOn(TeammateCollection.prototype, 'recoverLiveRuntimesForOwnerClose')
      .mockImplementation(async function (
        this: TeammateCollection,
        ...args: unknown[]
      ) {
        await (originalMemberRecovery as unknown as (
          ...args: unknown[]
        ) => Promise<void>).apply(this, args);
        memberRecoveryDone.resolve();
      });
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: (context) => {
        const id = context.identity.runtime_id;
        if (id === leaderId) {
          return new FakeRuntime({
            startGate: () => {
              leaderStartAttempts += 1;
              return allowLeaderStart.promise;
            },
          });
        }
        if (id === aRuntimeId) aMaterialized += 1;
        if (id === bRuntimeId) bMaterialized += 1;
        return new FakeRuntime();
      },
    });
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    joined.startAcceptedDissolve(joinedAccept, close);
    await waitFor(() => leaderStartAttempts >= 1);
    // The member sweep advances the generation while stopLeader awaits the
    // gated leader start.
    const sweep = joined.stopAll();
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    joined.interruptDissolvesForShutdown();
    await expect(joinedAccept.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    allowLeaderStart.resolve();
    await sweep;
    // Synchronize with the old continuation's member-loop pass before
    // asserting, so its materializations cannot slip past the check.
    await memberRecoveryDone.promise;
    // The old continuation's lease predates the sweep: no member can be
    // materialized by it after the proven barrier.
    expect(aMaterialized).toBe(0);
    expect(bMaterialized).toBe(0);
    // A fresh recovery acquires a new valid lease and materializes both
    // dormant members.
    await (await joined.get('alpha')).recoverLiveWritersForDissolve();
    expect(aMaterialized).toBe(1);
    expect(bMaterialized).toBe(1);
    await joined.stopAll();
  });

  it('invalidates pre-sweep recovery materialization at the sweep and permits a new recovery after it', async () => {
    // Prior process: team with TWO durable members + accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    const firstService = await first.get('alpha');
    await firstService.spawnTeamMate({
      name: 'worker-1',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    await firstService.spawnTeamMate({
      name: 'worker-2',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: recovery materializes member A and blocks in its start;
    // the sweep runs while the recovery still awaits A. The sweep advances
    // the generation before snapshotting, so when A's start later completes
    // the recovery loop cannot materialize B after the barrier.
    const allowAStart = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    const memberNames = (await (await first.get('alpha')).teammates.list())
      .map((member) => member.name)
      .sort();
    const aRuntimeId = memberRuntimeId(memberNames[0]!);
    const bRuntimeId = memberRuntimeId(memberNames[1]!);
    let aStartAttempts = 0;
    let bCreated = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: (context) => {
        const id = context.identity.runtime_id;
        if (id === aRuntimeId) {
          return new FakeRuntime({
            startGate: () => {
              aStartAttempts += 1;
              return allowAStart.promise;
            },
          });
        }
        if (id === bRuntimeId) bCreated += 1;
        return new FakeRuntime();
      },
    });
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    joined.startAcceptedDissolve(joinedAccept, close);
    await waitFor(() => aStartAttempts >= 1);
    // The sweep runs while the recovery is still awaiting A's start. It
    // advances the generation and marks itself active before snapshotting.
    const sweep = joined.stopAll();
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
    joined.interruptDissolvesForShutdown();
    await expect(joinedAccept.logicalClosed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
    allowAStart.resolve();
    await sweep;
    // The pre-sweep continuation must never materialize B.
    expect(bCreated).toBe(0);
    expect(close).not.toHaveBeenCalled();
    // A NEW recovery after the completed sweep captures the current
    // generation and legitimately materializes the dormant members.
    await (await joined.get('alpha')).recoverLiveWritersForDissolve();
    expect(bCreated).toBe(1);
  });

  it('keeps later owner-close recovery enabled after an owner-specific release', async () => {
    // Prior process: member + accepted dissolve; crash.
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'preexisting accepted dissolve',
      prompt: 'lead',
    });
    await (await first.get('alpha')).spawnTeamMate({
      name: 'worker',
      prompt: 'work',
      intent: 'member',
      agentRuntime: 'agent-a',
    });
    const durableAccepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'accepted before the restart',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    // Same instance: an ordinary Workflow finalization performs an
    // owner-specific release; it must not disable later recovery.
    const memberIdle = deferred<void>();
    const joinedRuntimes: FakeRuntime[] = [];
    const joinedWorktrees = new WorktreeManager();
    terminalAssessments(joinedWorktrees);
    const memberName = (await (await first.get('alpha')).teammates.list())[0]
      ?.name;
    const memberId = memberRuntimeId(memberName!);
    let memberCreated = 0;
    const joined = makeTeams({
      runtimes: joinedRuntimes,
      worktrees: joinedWorktrees,
      createRuntime: (context) => {
        if (context.identity.runtime_id === memberId) {
          memberCreated += 1;
          return new FakeRuntime({ waitIdle: () => memberIdle.promise });
        }
        return new FakeRuntime();
      },
    });
    const service = await joined.get('alpha');
    await service.startWorkflowAdmission();
    const workflowAccepted = await service.workflows.run({
      script: `
        export const meta = { name: 'completes', description: 'x' };
        return { done: true };
      `,
    });
    await vi.waitFor(async () => {
      expect(await service.workflows.status({ run_id: workflowAccepted.run_id }))
        .toMatchObject({ status: 'completed' });
    });
    // The early join and its recovery must still reattach the member and
    // honor its idle barrier.
    const joinedAccept = await joined.acceptDissolve({
      teamId: 'alpha',
      note: 'early join before recovery',
      requester: { kind: 'dispatcher' },
    });
    expect(joinedAccept.operationId).toBe(durableAccepted.operationId);
    const close = vi.fn((input) => joined.closeAcceptedResources(input));
    joined.startAcceptedDissolve(joinedAccept, close);
    await waitFor(() => memberCreated >= 1);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    memberIdle.resolve();
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        dissolve: {
          operation_id: durableAccepted.operationId,
          phase: 'complete',
        },
      });
    });
    expect(close).toHaveBeenCalledTimes(1);
    await joined.stopAll();
  });

  it('preserves recovery identity across deferred retries while waiting_for_team_idle', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover accepted idle wait retries',
      prompt: 'lead',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'crash while waiting for team idle',
      requester: { kind: 'dispatcher' },
    });
    await first.stopAll();

    const recoveredRuntimes: FakeRuntime[] = [];
    const recoveredWorktrees = new WorktreeManager();
    vi.spyOn(recoveredWorktrees, 'assessCleanup').mockImplementation(
      async () => {
        throw new Error('worktree assessment failed');
      },
    );
    const recovered = makeTeams({
      runtimes: recoveredRuntimes,
      worktrees: recoveredWorktrees,
    });
    const close = vi.fn((input) => recovered.closeAcceptedResources(input));
    await recovered.recoverDissolves(close);
    // First pass: workflow stop + captured-writer idle succeed, then the
    // revalidation assessment defers the recovered operation.
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: accepted.operationId,
          phase: 'waiting_for_team_idle',
          last_error: 'worktree-assessment-failed',
          cleanup_attempts: 1,
          next_retry_at: expect.any(Number),
        },
      });
    });
    // The scheduled retry hits the same assessment failure. The durable
    // cleanup-attempt counter keeps this a deferred retry: no fail-open, no
    // endClosing, and the accepted dissolve fence never reopens admission.
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: accepted.operationId,
          phase: 'waiting_for_team_idle',
          last_error: 'worktree-assessment-failed',
          cleanup_attempts: 2,
          next_retry_at: expect.any(Number),
        },
      });
    }, { timeout: 5_000 });
    expect(close).not.toHaveBeenCalled();
    await expect(recovered.sendToLeader('alpha', {
      prompt: 'still fenced',
      initiator: new FakeInitiator(),
    })).rejects.toBeInstanceOf(TeamUnavailableError);
    recovered.interruptDissolvesForShutdown();
    await recovered.stopAll();
  });
});

describe('Team-scope Workflow shutdown broadcast', () => {
  it('interrupts a real Team-scope public stop in its grace window', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      workflowStopGraceMs: 5_000,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'broadcast interrupts Team stop',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    const accepted = await service.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    });
    await waitFor(() => runtimes.length === 2);

    const stopTask = service.workflows.stop({ run_id: accepted.run_id });
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    teams.interruptWorkflowsForShutdown();
    await expect(stopTask).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // Shutdown froze the run and left the not-yet-started release to the
    // collection-wide sweep.
    expect(runtimes[1]?.stopAttempts).toBe(0);
    expect(await service.workflows.status({ run_id: accepted.run_id }))
      .toMatchObject({ status: 'stopped', agents: [{ status: 'stopped' }] });
    await teams.stopAll();
  });

  it('returns the real terminal status for a Team-scope run completed before the broadcast', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'terminal before broadcast',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    const accepted = await service.workflows.run({
      script: `
        export const meta = { name: 'completes', description: 'x' };
        return { done: true };
      `,
    });
    // Natural completion: the terminal delivery reached the leader before
    // the broadcast, so the run was truthfully evicted.
    await vi.waitFor(() =>
      expect(runtimes[0]?.textSubmitted.length).toBeGreaterThan(0),
    );
    await vi.waitFor(async () =>
      expect(await service.workflows.status({ run_id: accepted.run_id }))
        .toMatchObject({ status: 'completed', result: { done: true } }),
    );
    for (let step = 0; step < 4; step += 1) await Promise.resolve();

    teams.interruptWorkflowsForShutdown();
    await expect(service.workflows.stop({ run_id: accepted.run_id }))
      .resolves.toEqual({ run_id: accepted.run_id, status: 'completed' });
    await teams.stopAll();
  });

  it('resolves Team-scope takeover records after the Team sweep succeeds', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      workflowStopGraceMs: 5_000,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'team sweep resolves takeover',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    const accepted = await service.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    });
    await waitFor(() => runtimes.length === 2);

    await teams.stopAll();
    // The Team collection sweep proved every owned TeamMate released, so the
    // idempotent stop returns the durable terminal status again.
    await expect(service.workflows.stop({ run_id: accepted.run_id }))
      .resolves.toEqual({ run_id: accepted.run_id, status: 'stopped' });
  });

  it('keeps rejecting after the Team sweep when terminal routing was detached mid-settle', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'routing detach keeps rejecting',
      prompt: 'lead',
    });
    const deliveryEntered = deferred<void>();
    const allowDelivery = deferred<void>();
    runtimes[0].completionGate = {
      entered: () => deliveryEntered.resolve(),
      release: allowDelivery.promise,
    };
    const service = await teams.get('alpha');
    const accepted = await service.workflows.run({
      script: `
        export const meta = { name: 'completes', description: 'x' };
        return { done: true };
      `,
    });
    // Terminal routing started: the leader delivery is in flight.
    await deliveryEntered.promise;
    // The pre-drain broadcast detaches the in-flight routing settle; while
    // the settle's outcome is unproven the delayed stop keeps rejecting.
    teams.interruptWorkflowsForShutdown();
    await expect(service.workflows.stop({ run_id: accepted.run_id }))
      .rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // Once the detached settle reaches the router's guaranteed terminal
    // outcome, the routing barrier is proven: the sweep runs and the
    // idempotent stop returns the durable terminal status.
    allowDelivery.resolve();
    await teams.stopAll();
    await vi.waitFor(async () => {
      await expect(service.workflows.stop({ run_id: accepted.run_id }))
        .resolves.toEqual({ run_id: accepted.run_id, status: 'completed' });
    });
  });

  it('rejects a delayed Team-scope public stop after the pre-drain broadcast', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({
      runtimes,
      worktrees,
      workflowStopGraceMs: 5_000,
    });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'delayed stop after takeover',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    const accepted = await service.workflows.run({
      script: `
        export const meta = { name: 'never-settles', description: 'x' };
        await agent('never settles', { label: 'worker' });
        return null;
      `,
    });
    await waitFor(() => runtimes.length === 2);

    const first = service.workflows.stop({ run_id: accepted.run_id });
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    teams.interruptWorkflowsForShutdown();
    await expect(first).rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    // The delayed stop can only read the frozen durable record; it cannot
    // prove the release barrier before the collection-wide sweep runs.
    await expect(service.workflows.stop({ run_id: accepted.run_id }))
      .rejects.toBeInstanceOf(WorkflowStopInterruptedError);
    await teams.stopAll();
  });
});
