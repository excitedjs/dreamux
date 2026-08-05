import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamStore } from '../src/service/team-collection/store.js';
import { TeamDissolveFailedError } from '../src/service/team-collection/errors.js';
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

const execFileAsync = promisify(execFile);
const recoveryRoots: string[] = [];
let fixture: ReturnType<typeof createTeamDissolveFixture>;

beforeEach(() => {
  fixture = createTeamDissolveFixture();
});

afterEach(() => {
  fixture.cleanup();
  for (const root of recoveryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTeams(
  input: Parameters<ReturnType<typeof createTeamDissolveFixture>['makeTeams']>[0],
) {
  return fixture.makeTeams(input);
}

function terminalAssessments(worktrees: WorktreeManager) {
  return fixture.terminalAssessments(worktrees);
}

describe('Team dissolve recovery and cleanup', () => {
  it('reopens only the exact legacy unique-cleanup failure and resumes normal cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dreamux-legacy-team-cleanup-'));
    recoveryRoots.push(root);
    const repo = join(root, 'source');
    mkdirSync(repo, { recursive: true });
    const git = async (cwd: string, args: string[]) =>
      (await execFileAsync('git', args, { cwd })).stdout.trim();
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    await git(repo, ['add', 'tracked.txt']);
    await git(repo, ['commit', '-qm', 'base']);

    const first = makeTeams({ runtimes: [], worktrees: new WorktreeManager() });
    await first.create({
      name: 'legacy-unique',
      leaderAgentRuntime: 'agent-a',
      intent: 'resume the exact obsolete cleanup failure',
      repoCwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'legacy-unique',
        branch: 'dreamux/legacy-unique',
        cleanup: 'delete-on-close',
      },
    });
    await first.create({
      name: 'unrelated-failure',
      leaderAgentRuntime: 'agent-a',
      intent: 'remain terminal during recovery',
      repoCwd: repo,
      worktree: {
        mode: 'managed',
        slug: 'unrelated-failure',
        branch: 'dreamux/unrelated-failure',
        cleanup: 'delete-on-close',
      },
    });
    await first.stopAll();

    const store = new TeamStore();
    const legacy = (await store.get('dispatcher-a', 'legacy-unique'))!;
    const legacyDissolve = {
      operation_id: 'legacy-unique-operation',
      requester_kind: 'collaboration_target' as const,
      leader_name: null,
      target_handoff_ids: ['handoff-a', 'handoff-b'],
      note: 'resume only physical cleanup',
      accepted_at: 1_700_000_000_000,
      phase: 'failed' as const,
      last_error: 'worktree-unique-commits' as const,
      cleanup_attempts: 7,
      next_retry_at: null,
    };
    await store.update(legacy, {
      status: 'closed',
      closedAt: 1_700_000_000_100,
      closeNote: legacyDissolve.note,
      worktree: {
        ...legacy.worktree,
        cleanup_state: 'retained-unique-commits',
        cleanup_error: 'obsolete reachability decision',
      },
      dissolve: legacyDissolve,
      expectedDissolveOperationId: null,
    });

    const unrelated = (await store.get('dispatcher-a', 'unrelated-failure'))!;
    await store.update(unrelated, {
      status: 'closed',
      closedAt: 1_700_000_000_200,
      closeNote: 'keep this failed record terminal',
      worktree: {
        ...unrelated.worktree,
        cleanup_state: 'retained-unique-commits',
        cleanup_error: 'unrelated failure detail',
      },
      dissolve: {
        operation_id: 'unrelated-failed-operation',
        requester_kind: 'team_leader',
        leader_name: unrelated.leader_name,
        target_handoff_ids: [],
        note: 'keep this failed record terminal',
        accepted_at: 1_700_000_000_050,
        phase: 'failed',
        last_error: 'worktree-cleanup-failed',
        cleanup_attempts: 3,
        next_retry_at: null,
      },
      expectedDissolveOperationId: null,
    });
    const unrelatedBefore = await store.get(
      'dispatcher-a',
      'unrelated-failure',
    );

    const cleanupGate = deferred<void>();
    const recoveredWorktrees = new WorktreeManager();
    const assess = vi.spyOn(recoveredWorktrees, 'assessCleanup');
    const removeWorktree = recoveredWorktrees.cleanup.bind(recoveredWorktrees);
    const cleanup = vi.spyOn(recoveredWorktrees, 'cleanup')
      .mockImplementation(async (identity) => {
        await cleanupGate.promise;
        return removeWorktree(identity);
      });
    const recovered = makeTeams({ runtimes: [], worktrees: recoveredWorktrees });
    await recovered.recoverDissolves((input) =>
      recovered.closeAcceptedResources(input),
    );
    await waitFor(() => cleanup.mock.calls.length === 1);

    const migrated = (await store.get('dispatcher-a', 'legacy-unique'))!;
    expect(migrated).toMatchObject({
      status: 'closed',
      closed_at: 1_700_000_000_100,
      close_note: legacyDissolve.note,
      worktree: {
        cleanup_state: 'cleanup-pending',
        cleanup_error: null,
      },
      dissolve: {
        ...legacyDissolve,
        phase: 'worktree_cleanup_pending',
        last_error: null,
        next_retry_at: null,
      },
    });
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({
      worktree: expect.objectContaining({
        path: legacy.worktree.path,
        cleanup_state: 'cleanup-pending',
      }),
    }));
    expect(await store.get('dispatcher-a', 'unrelated-failure'))
      .toEqual(unrelatedBefore);
    expect(existsSync(unrelated.worktree.path)).toBe(true);
    await expect(recovered.sendToLeader('legacy-unique', {
      prompt: 'must remain gated while cleanup resumes',
      initiator: new FakeInitiator(),
    })).rejects.toThrow(/closed|closing/);

    cleanupGate.resolve();
    await cleanup.mock.results[0]!.value;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const current = await store.get('dispatcher-a', 'legacy-unique');
      if (current?.dissolve?.phase === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await store.get('dispatcher-a', 'legacy-unique')).toMatchObject({
      status: 'closed',
      worktree: { cleanup_state: 'deleted', cleanup_error: null },
      dissolve: {
        operation_id: legacyDissolve.operation_id,
        requester_kind: legacyDissolve.requester_kind,
        target_handoff_ids: legacyDissolve.target_handoff_ids,
        note: legacyDissolve.note,
        accepted_at: legacyDissolve.accepted_at,
        phase: 'complete',
        last_error: null,
        cleanup_attempts: legacyDissolve.cleanup_attempts,
        next_retry_at: null,
      },
    });
    expect(assess).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(legacy.worktree.path)).toBe(false);
    expect(await git(repo, [
      'rev-parse',
      '--verify',
      `refs/heads/${legacy.worktree.branch!}`,
    ])).not.toBe('');
    expect(await store.get('dispatcher-a', 'unrelated-failure'))
      .toEqual(unrelatedBefore);
    await recovered.stopAll();
  }, 10_000);

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
