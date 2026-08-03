import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import {
  TeamDissolveBlockedError,
  TeamDissolveFailedError,
  TeamDissolveInterruptedError,
  TeamUnavailableError,
} from '../src/service/team-collection/errors.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import {
  deferred,
  FakeInitiator,
  FakeRuntime,
  FAKE_RUNTIME_REF,
  fakeRuntimeCatalog,
  noopLog,
} from './helpers/fake-team-runtime.js';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

describe('durable Team dissolve lifecycle contract', () => {
  let root: string;
  let previousHome: string | undefined;
  let workspace: string;
  let config: ReturnType<typeof testDreamuxConfig>;
  const log = noopLog();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-team-dissolve-lifecycle-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    workspace = join(root, 'workspace');
    mkdirSync(process.env['HOME'], { recursive: true });
    mkdirSync(workspace, { recursive: true });
    config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'dispatcher-a',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    rmSync(root, { recursive: true, force: true });
  });

  function makeTeams(input: {
    runtimes: FakeRuntime[];
    worktrees: WorktreeManager;
    createRuntime?: () => FakeRuntime;
    isShuttingDown?: () => boolean;
  }): TeamCollection {
    const suffixes = ['aaaa', 'bbbb', 'cccc', 'dddd'];
    return new TeamCollection({
      dispatcherId: 'dispatcher-a',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(input.runtimes, {
        ...(input.createRuntime === undefined
          ? {}
          : { createRuntime: input.createRuntime }),
      }),
      worktrees: input.worktrees,
      identities: new AgentIdentityStore(log),
      turnsStore: new AgentTurnsStore(log),
      router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
      initiatorFor: async () => null,
      isShuttingDown: input.isShuttingDown ?? (() => false),
      adminSocketPath: '/tmp/admin.sock',
      leaderChannelDescriptors: () => [],
      log,
      agentNameSuffixGenerator: () => suffixes.shift()!,
    });
  }

  function terminalAssessments(worktrees: WorktreeManager) {
    return vi.spyOn(worktrees, 'assessCleanup').mockImplementation(
      async (identity) => ({
        status: 'terminal' as const,
        worktree: identity.worktree,
      }),
    );
  }

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
    vi.spyOn(worktrees, 'assessCleanup').mockImplementation(async (identity) => {
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

    await expect(accepted.completed).rejects.toBeInstanceOf(
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
    await expect(joined.completed).rejects.toBeInstanceOf(
      TeamDissolveInterruptedError,
    );
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
    await expect(joined.completed).resolves.toMatchObject({
      team: { status: 'closed' },
    });
    expect(close).toHaveBeenCalledTimes(1);
    await recovered.stopAll();
  });

  it('resolves logicalClosed immediately on recovered closed cleanup-pending before future retry', async () => {
    const firstRuntimes: FakeRuntime[] = [];
    const firstWorktrees = new WorktreeManager();
    terminalAssessments(firstWorktrees);
    const first = makeTeams({ runtimes: firstRuntimes, worktrees: firstWorktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'pending cleanup recovery',
      prompt: 'lead',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'cleanup later',
      requester: { kind: 'dispatcher' },
    });
    const store = new TeamStore();
    const record = (await store.get('dispatcher-a', 'alpha'))!;
    await store.update(record, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: record.dissolve!.note,
      worktree: {
        ...record.worktree,
        cleanup_state: 'cleanup-pending',
      },
      dissolve: {
        ...record.dissolve!,
        phase: 'worktree_cleanup_pending',
        next_retry_at: Date.now() + 60_000,
      },
      expectedDissolveOperationId: accepted.operationId,
    });

    const worktrees = new WorktreeManager();
    const cleanup = vi.spyOn(worktrees, 'cleanup');
    const recovered = makeTeams({ runtimes: [], worktrees });
    await recovered.recoverDissolves((input) =>
      recovered.closeAcceptedResources(input),
    );
    const joined = await recovered.acceptDissolve({
      teamId: 'alpha',
      note: 'target joins durable close',
      requester: {
        kind: 'collaboration_target',
        leaderName: record.leader_name,
        handoffId: 'handoff-target-a',
      },
    });
    await expect(joined.logicalClosed).resolves.toMatchObject({
      team: { status: 'closed' },
    });
    expect(cleanup).not.toHaveBeenCalled();
    recovered.interruptDissolvesForShutdown();
    await recovered.stopAll();
  });

  it('atomically preserves target handoffs across concurrent phase transitions', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    terminalAssessments(worktrees);
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'handoff merge',
      prompt: 'lead',
    });
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'atomic handoff',
      requester: { kind: 'dispatcher' },
    });
    const store = new TeamStore();
    const snapshot = (await store.get('dispatcher-a', 'alpha'))!;
    await Promise.all([
      store.update(snapshot, {
        appendTargetHandoffId: 'handoff-a',
        expectedDissolveOperationId: accepted.operationId,
      }),
      store.update(snapshot, {
        dissolvePatch: { phase: 'closing_resources' },
        expectedDissolveOperationId: accepted.operationId,
      }),
    ]);
    await Promise.all([
      store.update(snapshot, {
        dissolvePatch: { last_error: 'resource-close-failed' },
        expectedDissolveOperationId: accepted.operationId,
      }),
      store.update(snapshot, {
        appendTargetHandoffId: 'handoff-b',
        expectedDissolveOperationId: accepted.operationId,
      }),
    ]);
    expect((await store.get('dispatcher-a', 'alpha'))?.dissolve).toMatchObject({
      phase: 'closing_resources',
      last_error: 'resource-close-failed',
      target_handoff_ids: ['handoff-a', 'handoff-b'],
    });
    await teams.stopAll();
  });

  it('retries transient cleanup durably and resumes it after restart', async () => {
    const runtimes: FakeRuntime[] = [];
    const worktrees = new WorktreeManager();
    vi.spyOn(worktrees, 'assessCleanup').mockResolvedValue({
      status: 'eligible',
    });
    vi.spyOn(worktrees, 'cleanup').mockImplementation(async (identity) => ({
      ...identity.worktree,
      cleanup_state: 'retained-error',
      cleanup_error: 'transient remove failure',
    }));
    const first = makeTeams({ runtimes, worktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'durable cleanup retry',
      prompt: 'lead',
    });
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'cleanup with retry',
      requester: { kind: 'dispatcher' },
    });
    first.startAcceptedDissolve(accepted, (input) =>
      first.closeAcceptedResources(input),
    );
    await expect(accepted.logicalClosed).resolves.toMatchObject({
      team: { status: 'closed' },
    });
    const store = new TeamStore();
    const attemptDeadline = Date.now() + 2_000;
    while (Date.now() < attemptDeadline) {
      const current = await store.get('dispatcher-a', 'alpha');
      if (current?.dissolve?.cleanup_attempts === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = (await store.get('dispatcher-a', 'alpha'))!;
    expect(pending).toMatchObject({
      status: 'closed',
      dissolve: {
        phase: 'worktree_cleanup_pending',
        last_error: 'worktree-cleanup-failed',
        cleanup_attempts: 1,
      },
    });
    const pendingProjection = {
      dissolve_phase: 'worktree_cleanup_pending',
      dissolve_accepted_at: pending.dissolve!.accepted_at,
      worktree_cleanup: 'cleanup-pending',
      dissolve_error: 'worktree-cleanup-failed',
    };
    await expect((await first.get('alpha')).status()).resolves.toMatchObject({
      team: pendingProjection,
    });
    await expect(first.list()).resolves.toMatchObject([pendingProjection]);
    await expect(first.history({})).resolves.toMatchObject({
      items: [pendingProjection],
    });
    first.interruptDissolvesForShutdown();
    await first.stopAll();
    await store.update(pending, {
      dissolvePatch: { next_retry_at: Date.now() - 1 },
      expectedDissolveOperationId: accepted.operationId,
    });

    const recoveredWorktrees = new WorktreeManager();
    vi.spyOn(recoveredWorktrees, 'cleanup').mockImplementation(
      async (identity) => ({
        ...identity.worktree,
        cleanup_state: 'deleted',
        cleanup_error: null,
      }),
    );
    const recovered = makeTeams({ runtimes: [], worktrees: recoveredWorktrees });
    await recovered.recoverDissolves((input) =>
      recovered.closeAcceptedResources(input),
    );
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const current = await store.get('dispatcher-a', 'alpha');
      if (current?.dissolve?.phase === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await store.get('dispatcher-a', 'alpha')).toMatchObject({
      worktree: { cleanup_state: 'deleted' },
      dissolve: {
        phase: 'complete',
        last_error: null,
        cleanup_attempts: 1,
        next_retry_at: null,
      },
    });
    await recovered.stopAll();
  });

  it('never re-enters close after failed-open admission restoration retries', async () => {
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
    const teams = makeTeams({ runtimes, worktrees });
    await teams.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'restore after blocked close',
      prompt: 'lead',
    });
    const service = await teams.get('alpha');
    const reopen = vi.spyOn(service, 'startWorkflowAdmission')
      .mockRejectedValueOnce(new Error('reopen failed once'))
      .mockRejectedValueOnce(new Error('reopen failed twice'));
    const accepted = await teams.acceptDissolve({
      teamId: 'alpha',
      note: 'second assessment blocks',
      requester: { kind: 'dispatcher' },
    });
    const close = vi.fn((input) => teams.closeAcceptedResources(input));
    teams.startAcceptedDissolve(accepted, close);
    await waitFor(() => reopen.mock.calls.length >= 2);
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: {
        phase: 'failed',
        last_error: 'worktree-dirty',
        next_retry_at: null,
      },
    });
    await expect(accepted.completed).rejects.toBeInstanceOf(
      TeamDissolveFailedError,
    );
    expect(close).not.toHaveBeenCalled();
    await expect(teams.sendToLeader('alpha', {
      prompt: 'restored only after unwind',
      initiator: new FakeInitiator(),
    })).resolves.toMatchObject({ turn: { status: 'submitted' } });
    await teams.stopAll();
  }, 5_000);

  it('recovers a crash while propagating a terminal safety retention fact', async () => {
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
    const first = makeTeams({ runtimes, worktrees });
    await first.create({
      name: 'alpha',
      leaderAgentRuntime: 'agent-a',
      intent: 'recover terminal propagation',
      prompt: 'lead',
    });
    const service = await first.get('alpha');
    vi.spyOn(service, 'synchronizeWorktreeCleanup')
      .mockRejectedValueOnce(new Error('crash during borrower synchronization'));
    const accepted = await first.acceptDissolve({
      teamId: 'alpha',
      note: 'retain late dirty work',
      requester: { kind: 'dispatcher' },
    });
    const store = new TeamStore();
    const acceptedRecord = (await store.get('dispatcher-a', 'alpha'))!;
    await store.update(acceptedRecord, {
      dissolvePatch: { phase: 'closing_resources' },
      expectedDissolveOperationId: accepted.operationId,
    });
    first.startAcceptedDissolve(accepted, (input) =>
      first.closeAcceptedResources(input),
    );
    const pendingDeadline = Date.now() + 2_000;
    while (Date.now() < pendingDeadline) {
      const current = await store.get('dispatcher-a', 'alpha');
      if (
        current?.status === 'closed' &&
        current.dissolve?.phase === 'closing_resources' &&
        current.dissolve.cleanup_attempts === 1
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = (await store.get('dispatcher-a', 'alpha'))!;
    expect(pending).toMatchObject({
      status: 'closed',
      worktree: { cleanup_state: 'retained-dirty' },
      dissolve: {
        phase: 'closing_resources',
        last_error: 'worktree-dirty',
        cleanup_attempts: 1,
      },
    });
    first.interruptDissolvesForShutdown();
    await first.stopAll();
    await store.update(pending, {
      dissolvePatch: { next_retry_at: Date.now() - 1 },
      expectedDissolveOperationId: accepted.operationId,
    });

    const recovered = makeTeams({
      runtimes: [],
      worktrees: new WorktreeManager(),
    });
    await recovered.recoverDissolves((input) =>
      recovered.closeAcceptedResources(input),
    );
    const failedDeadline = Date.now() + 2_000;
    while (Date.now() < failedDeadline) {
      const current = await store.get('dispatcher-a', 'alpha');
      if (current?.dissolve?.phase === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await store.get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'closed',
      worktree: { cleanup_state: 'retained-dirty' },
      dissolve: {
        phase: 'failed',
        last_error: 'worktree-dirty',
        cleanup_attempts: 1,
        next_retry_at: null,
      },
    });
    await expect((await recovered.get('alpha')).status()).resolves.toMatchObject({
      leader: { repo: { cleanup_state: 'retained-dirty' } },
    });
    await recovered.stopAll();
  });
});
