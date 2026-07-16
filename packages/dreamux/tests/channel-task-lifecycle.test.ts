import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  AgentRuntime,
  AgentRuntimeDurableSubmissionInput,
  AgentRuntimeDurableSubmissionRecord,
  ChannelTaskCancelInput,
  ChannelTaskHost,
  ChannelTaskSubmitInput,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import { TaskChannelHostService } from '../src/service/channel-task-host/service.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import type { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

describe('strict task attempt lifecycle', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-lifecycle-'));
    repo = join(root, 'repository');
    await execa('git', ['init', repo]);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    await execa('git', ['-C', repo, 'add', 'README.md']);
    await execa('git', [
      '-C', repo,
      '-c', 'user.name=Dreamux Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'fixture',
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('durably acknowledges before provisioning and retries a blocked target in place', async () => {
    const harness = await lifecycleHarness(root, repo);
    harness.collaborationSpaces.ensureTaskBinding
      .mockRejectedValueOnce(new Error('binding store unavailable'));
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const submission = taskSubmission();

    const first = await host.submit(submission);
    expect(first.status).toBe('accepted');
    await harness.service.drain();
    expect(snapshotItem(harness.store)).toMatchObject({
      phase: 'blocked',
      blocked: { code: 'TASK_PROVISIONING_FAILED', retryable: true },
    });
    expect(snapshotItem(harness.store)?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'team', state: 'provisioning' }),
      expect.objectContaining({ kind: 'leader', state: 'provisioning' }),
      expect.objectContaining({ kind: 'worktree', state: 'provisional' }),
    ]));
    expect(harness.teams.ensureProvisioned).not.toHaveBeenCalled();

    const duplicate = await host.submit(structuredClone(submission));
    expect(duplicate).toEqual(first);
    await harness.service.drain();
    expect(harness.collaborationSpaces.ensureTaskBinding).toHaveBeenCalledTimes(2);
    expect(harness.teams.ensureProvisioned).toHaveBeenCalledOnce();
    expect(harness.runtime.submitCount).toBe(1);
    expect(snapshotItem(harness.store)).toMatchObject({
      phase: 'running',
      blocked: null,
    });
    expect(snapshotItem(harness.store)?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'team', state: 'ready' }),
      expect.objectContaining({ kind: 'leader', state: 'running' }),
      expect.objectContaining({ kind: 'worktree', state: 'ready' }),
      expect.objectContaining({ kind: 'turn', state: 'running' }),
    ]));
  });

  it('returns the original receipt for duplicate delivery and rejects conflicts', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const submission = taskSubmission();
    const first = await host.submit(submission);
    await harness.service.drain();

    await expect(host.submit(structuredClone(submission))).resolves.toEqual(first);
    await expect(host.submit({
      ...structuredClone(submission),
      turn: { ...submission.turn, text: 'Different task body' },
    })).resolves.toMatchObject({
      status: 'rejected',
      code: 'TASK_ATTEMPT_CONFLICT',
      retryable: false,
    });
    expect(harness.runtime.submitCount).toBe(1);
  });

  it('revalidates the binding leader runtime after the durable receipt', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    harness.collaborationSpaces.ensureTaskBinding.mockResolvedValueOnce({
      space_name: 'space-a',
      generation: 1,
      repository: {
        source: 'static',
        logical_key: '@static',
        binding_revision: 'static-v1',
        fingerprint: 'repository-fingerprint',
        repo_cwd: repo,
        base_ref: null,
        base_commit: '0'.repeat(40),
      },
      leader_agent_runtime: 'non-durable-runtime',
      identity: null,
    });

    await expect(host.submit(taskSubmission())).resolves.toMatchObject({
      status: 'accepted',
    });
    await harness.service.drain();

    expect(harness.store.list()[0]).toMatchObject({
      phase: 'blocked',
      binding: null,
      blocked: { code: 'TASK_PROVISIONING_FAILED', retryable: true },
    });
    expect(harness.teams.ensureProvisioned).not.toHaveBeenCalled();
    expect(harness.runtime.submitCount).toBe(0);
  });

  it('restores degraded host status only after every retryable target recovers', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const first = taskSubmission();
    harness.collaborationSpaces.ensureTaskBinding
      .mockRejectedValueOnce(new Error('first provisioning failure'));
    await host.submit(first);
    await harness.service.drain();

    harness.collaborationSpaces.ensureTaskBinding
      .mockRejectedValueOnce(new Error('recovery still unavailable'));
    await harness.service.recover();
    expect(harness.store.hostStatus).toBe('degraded');

    const second = taskSubmission('task-b', 'attempt-1', 'delivery-b');
    await host.submit(second);
    await harness.service.drain();
    expect(harness.store.hostStatus).toBe('degraded');

    await host.submit(structuredClone(first));
    await harness.service.drain();
    expect(harness.store.hostStatus).toBe('ready');
  });

  it('commits business terminal once and waits for the invoking turn settlement', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const accepted = await host.submit(taskSubmission());
    if (accepted.status !== 'accepted') throw new Error('task was not accepted');
    await harness.service.drain();
    const target = harness.store.get(accepted.receipt.target_id)!;

    const firstFinish = await harness.service.finishForTeam({
      teamId: target.team.team_name,
      leaderName: target.team.leader_name!,
      result: { outcome: 'completed', summary: 'task result' },
    });
    const duplicateFinish = await harness.service.finishForTeam({
      teamId: target.team.team_name,
      leaderName: target.team.leader_name!,
      result: { outcome: 'failed', summary: 'must not replace terminal' },
    });
    expect(duplicateFinish).toEqual(firstFinish);
    await harness.service.drain();
    expect(harness.store.get(target.target_id)).toMatchObject({
      phase: 'terminal',
      terminal: { outcome: 'completed', summary: 'task result' },
      terminal_revision: 1,
    });
    expect(harness.teamService.dissolve).not.toHaveBeenCalled();

    const turn = harness.runtime.settleFirst('completed', 'runtime result');
    await harness.service.notifySettlement({
      teamId: target.team.team_name,
      runtimeId: 'leader-runtime',
      durabilityNamespace: 'namespace-a',
      turnId: turn,
    });
    await harness.service.drain();
    expect(harness.store.get(target.target_id)).toMatchObject({
      phase: 'finalized',
      terminal: { outcome: 'completed', summary: 'task result' },
      finalizer: { cleanup_status: 'deleted' },
    });
    expect(harness.teamService.dissolve).toHaveBeenCalledOnce();
  });

  it('restores host health after terminal reconciliation later succeeds', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const accepted = await host.submit(taskSubmission());
    if (accepted.status !== 'accepted') throw new Error('task was not accepted');
    await harness.service.drain();
    const target = harness.store.get(accepted.receipt.target_id)!;
    await harness.service.finishForTeam({
      teamId: target.team.team_name,
      leaderName: target.team.leader_name!,
      result: { outcome: 'completed', summary: 'business result' },
    });
    vi.spyOn(harness.runtime.durableTaskSubmissions, 'lookupSubmission')
      .mockRejectedValueOnce(new Error('runtime ledger temporarily unavailable'));

    await harness.service.recover();
    expect(harness.store.hostStatus).toBe('degraded');

    const turnId = harness.runtime.settleFirst('completed', 'runtime result');
    await harness.service.notifySettlement({
      teamId: target.team.team_name,
      runtimeId: 'leader-runtime',
      durabilityNamespace: 'namespace-a',
      turnId,
    });
    await harness.service.drain();
    expect(harness.store.get(target.target_id)?.phase).toBe('finalized');
    expect(harness.store.hostStatus).toBe('ready');
    expect(harness.store.hostStatusCode).toBeNull();
  });

  it('uses one cancel CAS and force-cleans an active durable turn', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const submission = taskSubmission();
    await host.submit(submission);
    await harness.service.drain();

    const first = await host.cancel(cancelInput(submission, 'remote cancellation'));
    expect(first.status).toBe('accepted');
    await harness.service.drain();
    const second = await host.cancel(cancelInput(submission, 'duplicate cancellation'));
    expect(second).toMatchObject({
      status: 'already_terminal',
      terminal: { outcome: 'cancelled', summary: 'remote cancellation' },
    });
    expect(harness.store.list()[0]).toMatchObject({
      phase: 'finalized',
      terminal_revision: 1,
      terminal: { outcome: 'cancelled' },
    });
    expect(harness.teamService.dissolve).toHaveBeenCalledOnce();
  });

  it('converges pre-binding cancellation in both events and snapshot state', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const submission = taskSubmission();
    harness.collaborationSpaces.ensureTaskBinding
      .mockRejectedValueOnce(new Error('binding unavailable'));
    await host.submit(submission);
    await harness.service.drain();

    await host.cancel(cancelInput(submission, 'cancel before binding'));
    await harness.service.drain();
    const snapshot = await host.snapshot();
    expect(snapshot).toMatchObject({
      status: 'page',
      page: {
        complete: true,
        items: [{
          phase: 'finalized',
          resources: expect.arrayContaining([
            expect.objectContaining({ kind: 'worktree', state: 'deleted' }),
          ]),
        }],
      },
    });
    const replay = await host.replay({
      host_stream_id: host.scope.host_stream_id,
      stream_generation: host.scope.stream_generation,
      after_sequence: 0,
      limit: 500,
    });
    if (replay.status !== 'events') throw new Error('event replay unavailable');
    const worktree = replay.batch.events.flatMap((event) =>
      event.payload.kind === 'resource.lifecycle' &&
        event.payload.resource.kind === 'worktree'
        ? [event.payload.resource.state]
        : [],
    );
    expect(worktree).toEqual(['provisional', 'cleaning', 'deleted']);
    expect(harness.teams.ensureProvisioned).not.toHaveBeenCalled();
  });

  it('reconciles a stop-time settlement without re-entering the finalizer fence', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const submission = taskSubmission();
    const accepted = await host.submit(submission);
    if (accepted.status !== 'accepted') throw new Error('task was not accepted');
    await harness.service.drain();
    const target = harness.store.get(accepted.receipt.target_id)!;
    const turnId = harness.runtime.settleFirst('stopped', 'runtime stopped');
    harness.teamService.dissolve.mockImplementationOnce(async () => {
      await harness.service.notifySettlement({
        teamId: target.team.team_name,
        runtimeId: 'leader-runtime',
        durabilityNamespace: 'namespace-a',
        turnId,
      });
      return {};
    });

    await host.cancel(cancelInput(submission, 'cancel during active turn'));
    await withTimeout(harness.service.drain(), 1_000);

    expect(harness.store.get(target.target_id)).toMatchObject({
      phase: 'finalized',
      submissions: [{
        state: 'settled',
        settlement: { status: 'stopped' },
        settlement_acknowledged_revision: 2,
      }],
    });
    expect(harness.runtime.acknowledgeCount).toBe(1);
  });

  it('durably cancels while an accepted runtime effect is still pending', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const entered = deferred();
    const release = deferred();
    const submitOnce = harness.runtime.durableTaskSubmissions.submitOnce.bind(
      harness.runtime.durableTaskSubmissions,
    );
    vi.spyOn(harness.runtime.durableTaskSubmissions, 'submitOnce')
      .mockImplementation(async (input) => {
        entered.resolve();
        await release.promise;
        return submitOnce(input);
      });
    const submission = taskSubmission();
    await expect(host.submit(submission)).resolves.toMatchObject({
      status: 'accepted',
    });
    await entered.promise;

    await expect(withTimeout(
      host.cancel(cancelInput(submission, 'cancel without waiting for the runtime')),
      250,
    )).resolves.toMatchObject({ status: 'accepted' });
    expect(harness.store.list()[0]).toMatchObject({
      phase: 'terminal',
      terminal: { outcome: 'cancelled' },
    });

    release.resolve();
    await harness.service.drain();
    const turnStatuses = harness.store.replay(0, 500).events.flatMap((event) =>
      event.payload.kind === 'resource.lifecycle' &&
        event.payload.resource.kind === 'turn'
        ? [event.payload.resource.state]
        : [],
    );
    const firstStopped = turnStatuses.indexOf('stopped');
    expect(firstStopped).toBeGreaterThanOrEqual(0);
    expect(turnStatuses.slice(firstStopped)).not.toContain('running');
    expect(turnStatuses.slice(firstStopped)).not.toContain('submitted');
    expect(harness.store.list()[0]?.phase).toBe('finalized');
  });

  it('bounds TeamLeader terminal summaries by UTF-8 bytes', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    const accepted = await host.submit(taskSubmission());
    if (accepted.status !== 'accepted') throw new Error('task was not accepted');
    await harness.service.drain();
    const target = harness.store.get(accepted.receipt.target_id)!;

    await harness.service.finishForTeam({
      teamId: target.team.team_name,
      leaderName: target.team.leader_name!,
      result: { outcome: 'completed', summary: '🙂'.repeat(20_000) },
    });

    const summary = harness.store.get(target.target_id)?.terminal?.summary;
    expect(summary).toBe('🙂'.repeat(16_384));
    expect(Buffer.byteLength(summary!, 'utf8')).toBe(64 * 1024);
  });

  it('never emits repository paths or task bodies in provider telemetry', async () => {
    const harness = await lifecycleHarness(root, repo);
    await harness.service.recover();
    const host = await negotiatedHost(harness.service);
    await host.submit(taskSubmission());
    await harness.service.drain();
    const target = harness.store.list()[0]!;
    const turnId = harness.runtime.settleFirst(
      'completed',
      'runtime-private-settlement-result',
    );
    await harness.service.notifySettlement({
      teamId: target.team.team_name,
      runtimeId: 'leader-runtime',
      durabilityNamespace: 'namespace-a',
      turnId,
    });

    const publicState = JSON.stringify({
      snapshot: await host.snapshot(),
      replay: await host.replay({
        host_stream_id: host.scope.host_stream_id,
        stream_generation: host.scope.stream_generation,
        after_sequence: 0,
        limit: 500,
      }),
    });
    expect(publicState).not.toContain(repo);
    expect(publicState).not.toContain('Execute task A with private input');
    expect(publicState).not.toContain('runtime-private-settlement-result');
  });
});

async function lifecycleHarness(root: string, repo: string) {
  const runtime = new DurableRuntime();
  let teamClosed = false;
  const teamService = {
    durableTaskRuntime: vi.fn(async () => ({
      runtime: runtime as AgentRuntime,
      runtimeId: 'leader-runtime',
      role: 'leader' as const,
    })),
    ensureTaskSubmissionRuntime: vi.fn(async () => ({
      runtime: runtime as AgentRuntime,
      runtimeId: 'leader-runtime',
      role: 'leader' as const,
    })),
    dissolve: vi.fn(async () => {
      teamClosed = true;
      return {};
    }),
    view: vi.fn(() => ({ status: teamClosed ? 'closed' : 'running' })),
    taskCleanupOutcome: vi.fn(() => ({ status: 'deleted' as const })),
  };
  const teams = {
    ensureProvisioned: vi.fn(async (input) => ({
      team: {
        team_name: input.name,
        status: 'running',
        leader_name: 'task-leader',
      },
      leader: {},
      member_count: 0,
      turn: null,
    })),
    withRoutableTeamOwner: vi.fn(async (teamId, task) => task({
      kind: 'team',
      teamName: teamId,
      leaderName: 'task-leader',
    })),
    get: vi.fn(async () => teamService),
    isOpenTeam: vi.fn(async () => !teamClosed),
    withTeamRouteClosing: vi.fn(async (_teamId, task) => task()),
    abortProvisioning: vi.fn(async () => ({
      mode: 'managed',
      cleanup_state: 'deleted',
    })),
    finalizeTaskProvisioning: vi.fn(async () => {
      await teamService.dissolve();
      return {
        team_status: 'closed' as const,
        cleanup: {
          mode: 'managed' as const,
          slug: 'task-worktree-a',
          path: '/tmp/example-worktree',
          branch: 'dreamux/task-worktree-a',
          base_ref: '0'.repeat(40),
          cleanup: 'delete-on-close' as const,
          cleanup_state: 'deleted' as const,
          cleanup_error: null,
        },
      };
    }),
  } as unknown as TeamCollection & {
    ensureProvisioned: ReturnType<typeof vi.fn>;
  };
  const repository = {
    source: 'static' as const,
    logical_key: '@static',
    binding_revision: 'static-v1',
    fingerprint: 'repository-fingerprint',
    repo_cwd: repo,
    base_ref: null,
    base_commit: '0'.repeat(40),
  };
  const collaborationSpaces = {
    inspectTaskBinding: vi.fn(async () => null),
    ensureTaskBinding: vi.fn(async () => ({
      space_name: 'space-a',
      generation: 1,
      repository,
      leader_agent_runtime: 'leader-runtime',
      identity: null,
    })),
  } as unknown as CollaborationSpaceService & {
    ensureTaskBinding: ReturnType<typeof vi.fn>;
  };
  const channels = {
    collaborationSpaceConfig: () => ({
      defaultBinding: {
        enabled: true,
        repositorySource: 'static' as const,
        repo: { cwd: repo, baseRef: null },
        identity: null,
      },
    }),
    claimResolvedTarget: vi.fn(async () => null),
    releaseResolvedTargetIfClaimed: vi.fn(async () => null),
  } as unknown as ChannelService;
  const dispatcher = testDispatcherConfig({
    id: 'dispatcher-a',
    agentRuntime: 'leader-runtime',
    runtimeProvider: 'npm:@example/durable-runtime',
    channels: [{
      id: 'remote-tasks',
      provider: 'npm:@example/dreamux-task-channel',
      collaborationSpace: {
        defaultBinding: {
          enabled: true,
          repositorySource: 'static',
          repo: { cwd: repo, baseRef: null },
          identity: null,
        },
      },
      config: {},
      identity: 'remote-task-platform',
    }],
  });
  const store = await TaskHostStore.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    providerRef: 'npm:@example/dreamux-task-channel',
    rootDir: join(root, 'host'),
  });
  const service = await TaskChannelHostService.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: 'npm:@example/dreamux-task-channel',
    config: testDreamuxConfig([dispatcher]),
    channels,
    collaborationSpaces,
    teams,
    agentRuntimeProviders: {
      resolve: () => ({
        getCapabilities: () => ({
          resume: { supported: false },
          durableTaskSubmission: {
            supported: true,
            protocol: 'durable_task_submission_v1',
          },
          durableTaskToolInvocation: {
            supported: true,
            protocol: 'durable_task_mcp_invocation_v1',
          },
        }),
      }),
    } as unknown as AgentRuntimeProviderCatalog,
    log: noopLog(),
    isShuttingDown: () => false,
    store,
  });
  return {
    service,
    store,
    runtime,
    teamService,
    teams,
    collaborationSpaces,
  };
}

class DurableRuntime implements AgentRuntime {
  readonly providerRef = 'npm:@example/durable-runtime';
  readonly records = new Map<string, AgentRuntimeDurableSubmissionRecord>();
  submitCount = 0;
  acknowledgeCount = 0;
  readonly durableTaskSubmissions = {
    namespace: 'namespace-a',
    lookupSubmission: async (operationId: string) => {
      const record = this.records.get(operationId);
      return record === undefined
        ? { status: 'absent' as const }
        : { status: 'found' as const, submission: structuredClone(record) };
    },
    submitOnce: async (input: AgentRuntimeDurableSubmissionInput) => {
      const existing = this.records.get(input.operation_id);
      if (existing !== undefined) {
        return { status: 'accepted' as const, submission: structuredClone(existing) };
      }
      this.submitCount += 1;
      const record: AgentRuntimeDurableSubmissionRecord = {
        operation_id: input.operation_id,
        input_digest: input.input_digest,
        turn_id: `turn-${this.submitCount}`,
        revision: 1,
        settlement: null,
        settlement_acknowledged_revision: 0,
      };
      this.records.set(input.operation_id, record);
      return { status: 'accepted' as const, submission: structuredClone(record) };
    },
    acknowledgeSettlement: async (input: {
      operation_id: string;
      settlement_revision: number;
    }) => {
      this.acknowledgeCount += 1;
      const record = this.records.get(input.operation_id)!;
      record.settlement_acknowledged_revision = input.settlement_revision;
      return { acknowledged_revision: input.settlement_revision };
    },
  };

  settleFirst(status: 'completed' | 'failed' | 'stopped', result: string): string {
    const record = this.records.values().next().value;
    if (record === undefined) throw new Error('no durable turn');
    record.revision = 2;
    record.settlement = { revision: 2, status, result };
    return record.turn_id;
  }

  async start() {}
  async resume() {}
  async stop() {}
  async channelInput() { return { status: 'submitted' as const, turnId: 'legacy' }; }
  async completionInput() { return { status: 'submitted' as const, turnId: 'legacy' }; }
  getStatus() { return 'ready' as const; }
  getCheckpoint() { return null; }
  wasCheckpointResumed() { return false; }
  async getLast() { return null; }
  async getContext() { return null; }
  getCapabilities() {
    return {
      resume: { supported: false },
      durableTaskSubmission: {
        supported: true as const,
        protocol: 'durable_task_submission_v1' as const,
      },
      durableTaskToolInvocation: {
        supported: true as const,
        protocol: 'durable_task_mcp_invocation_v1' as const,
      },
    };
  }
}

async function negotiatedHost(service: TaskChannelHostService): Promise<ChannelTaskHost> {
  const host = service.beginSession();
  await host.negotiate({
    supported_schema_versions: [1],
    supported_capabilities: host.scope.required_capabilities,
  });
  const applied = await host.applyContainerManifest({
    manifest: {
      revision: 1,
      entries: [{
        container: { container_type: 'task-space', container_key: 'space-a' },
        generation: 1,
        state: 'active',
        repository: { repository_key: 'repository-a' },
      }],
    },
  });
  if (applied.status === 'rejected') throw new Error(applied.message);
  return host;
}

function taskSubmission(
  taskKey = 'task-a',
  attemptKey = 'attempt-1',
  sourceId = 'delivery-a',
): ChannelTaskSubmitInput {
  return {
    attempt: { task_key: taskKey, attempt_key: attemptKey },
    container: { container_type: 'task-space', container_key: 'space-a' },
    manifest_revision: 1,
    container_generation: 1,
    repository: { repository_key: 'repository-a' },
    turn: {
      sourceId,
      text: 'Execute task A with private input',
    },
    title: 'Task A',
  };
}

function cancelInput(
  submission: ChannelTaskSubmitInput,
  reason: string,
): ChannelTaskCancelInput {
  return {
    attempt: submission.attempt,
    container: submission.container,
    manifest_revision: submission.manifest_revision,
    container_generation: submission.container_generation,
    reason,
  };
}

function snapshotItem(store: TaskHostStore) {
  const result = store.snapshot();
  if (result.status !== 'page') throw new Error(`snapshot failed: ${result.reason}`);
  return result.page.items[0];
}

function noopLog(): DreamuxLogger {
  const sink = () => {};
  return { error: sink, warn: sink, info: sink, debug: sink, trace: sink };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('operation timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
