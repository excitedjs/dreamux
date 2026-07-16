import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import type { ChannelService } from '../src/service/channel-service/index.js';
import { TaskTargetFinalizer } from '../src/service/channel-task-host/finalizer.js';
import { canonicalTaskIdentity } from '../src/service/channel-task-host/identity.js';
import { RuntimeSubmissionIndex } from '../src/service/channel-task-host/runtime-submission-index.js';
import { TaskHostStore } from '../src/service/channel-task-host/store.js';
import type { TaskTargetClaimInput } from '../src/service/channel-task-host/types.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TaskTeamProvisionInput } from '../src/service/team-collection/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { applyTestTaskManifest, testTaskContainer } from './helpers/task-host.js';

describe('task provisioning and finalizer crash recovery', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let repo: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-task-recovery-'));
    home = join(root, 'home');
    workspace = join(root, 'dispatcher-workspace');
    repo = join(root, 'repository');
    await mkdir(home);
    await mkdir(workspace);
    previousHome = process.env['HOME'];
    process.env['HOME'] = home;
    resetRuntimeConfig();
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
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    await rm(root, { recursive: true, force: true });
  });

  it('deletes a deterministic provisional worktree when no Team row committed', async () => {
    const worktrees = new WorktreeManager();
    const input = provisioningInput(repo);
    const prepared = await worktrees.prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: `team-${input.name}`,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: input.worktree,
    });
    expect(existsSync(prepared.runtimeCwd)).toBe(true);

    const cleaned = await teamCollection(worktrees, workspace)
      .finalizeTaskProvisioning(input);
    expect(cleaned).toMatchObject({
      team_status: 'absent',
      cleanup: { cleanup_state: 'deleted' },
    });
    expect(existsSync(prepared.runtimeCwd)).toBe(false);
    await expect(teamCollection(worktrees, workspace)
      .finalizeTaskProvisioning(input)).resolves.toMatchObject({
        team_status: 'absent',
        cleanup: { cleanup_state: 'deleted' },
      });
  });

  it('closes an orphan starting Team row without materializing a TeamLeader', async () => {
    const worktrees = new WorktreeManager();
    const input = provisioningInput(repo);
    const prepared = await worktrees.prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: `team-${input.name}`,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: input.worktree,
    });
    const teams = teamCollection(worktrees, workspace);
    await new TeamStore().create({
      dispatcher_id: 'dispatcher-a',
      team_id: input.name,
      name: input.name,
      repo_cwd: prepared.sourceCwd,
      source_repo: prepared.sourceRepo,
      leader_name: 'task-leader',
      leader_agent_runtime: input.leaderAgentRuntime,
      runtime_cwd: prepared.runtimeCwd,
      worktree: prepared.worktree,
      status: 'starting',
      intent: input.intent,
      closed_at: null,
      close_note: null,
    });

    const cleaned = await teams.finalizeTaskProvisioning(input);
    expect(cleaned.cleanup.cleanup_state).toBe('deleted');
    expect(existsSync(prepared.runtimeCwd)).toBe(false);
    await expect(new TeamStore().get('dispatcher-a', input.name)).resolves
      .toMatchObject({
        status: 'closed',
        close_note: 'Task provisioning was terminal before TeamLeader creation',
        worktree: { cleanup_state: 'deleted' },
      });
    await expect(teams.finalizeTaskProvisioning(input)).resolves.toMatchObject({
      team_status: 'closed',
      cleanup: { cleanup_state: 'deleted' },
    });
  });

  it('retains a dirty provisional worktree and reports the cleanup reason', async () => {
    const worktrees = new WorktreeManager();
    const input = provisioningInput(repo);
    const prepared = await worktrees.prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: `team-${input.name}`,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: input.worktree,
    });
    await writeFile(join(prepared.runtimeCwd, 'untracked.txt'), 'local change\n');

    await expect(teamCollection(worktrees, workspace).abortProvisioning(input)).resolves
      .toMatchObject({ cleanup_state: 'retained-dirty' });
    expect(existsSync(prepared.runtimeCwd)).toBe(true);
  });

  it('treats physical absence as deleted even when the source repository vanished', async () => {
    const worktrees = new WorktreeManager();
    const input = provisioningInput(repo);
    const prepared = await worktrees.prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: `team-${input.name}`,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: input.worktree,
    });
    await rm(prepared.runtimeCwd, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });

    await expect(worktrees.cleanup({
      source_cwd: prepared.sourceCwd,
      source_repo: prepared.sourceRepo,
      worktree: prepared.worktree,
    })).resolves.toMatchObject({ cleanup_state: 'deleted', cleanup_error: null });
  });

  it('creates a managed worktree from the accepted pinned commit after HEAD moves', async () => {
    const baseCommit = (await execa('git', ['-C', repo, 'rev-parse', 'HEAD']))
      .stdout.trim();
    await writeFile(join(repo, 'SECOND.md'), 'later commit\n');
    await execa('git', ['-C', repo, 'add', 'SECOND.md']);
    await execa('git', [
      '-C', repo,
      '-c', 'user.name=Dreamux Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'later fixture',
    ]);
    const input = provisioningInput(repo);
    input.worktree!.base_ref = baseCommit;
    const prepared = await new WorktreeManager().prepare({
      dispatcherId: 'dispatcher-a',
      teammateName: `team-${input.name}`,
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: input.worktree,
    });

    const worktreeHead = (await execa('git', [
      '-C', prepared.runtimeCwd, 'rev-parse', 'HEAD',
    ])).stdout.trim();
    expect(worktreeHead).toBe(baseCommit);
  });

  it('waits for durable settlement and settlement ACK before successful cleanup', async () => {
    const store = await readyTaskStore(join(root, 'host'));
    const target = store.list()[0]!;
    const index = new RuntimeSubmissionIndex(store);
    await index.recordIntent(intent(target.target_id));
    await index.recordAccepted({
      targetId: target.target_id,
      operationId: intent(target.target_id).operationId,
      runtime: runtimeRecord(intent(target.target_id).operationId, null),
    });
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'completed', summary: 'done' },
    });
    const harness = finalizerHarness(store);

    await harness.finalizer.run(target.target_id);
    expect(store.get(target.target_id)?.phase).toBe('terminal');
    await index.recordSettlement({
      targetId: target.target_id,
      operationId: intent(target.target_id).operationId,
      settlement: { revision: 2, status: 'completed', result: 'done' },
    });
    await harness.finalizer.run(target.target_id);
    expect(store.get(target.target_id)?.phase).toBe('terminal');
    await index.recordSettlementAcknowledged({
      targetId: target.target_id,
      operationId: intent(target.target_id).operationId,
      revision: 2,
    });
    await harness.finalizer.run(target.target_id);

    expect(store.get(target.target_id)).toMatchObject({
      phase: 'finalized',
      terminal: { outcome: 'completed' },
      finalizer: { step: 'completed', cleanup_status: 'deleted' },
    });
    expect(harness.channels.releaseResolvedTargetIfClaimed).toHaveBeenCalledOnce();
    expect(harness.teams.finalizeTaskProvisioning).toHaveBeenCalledOnce();
  });

  it('persists a retryable finalizer checkpoint and resumes it deterministically', async () => {
    const store = await readyTaskStore(join(root, 'host'));
    const target = store.list()[0]!;
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    const harness = finalizerHarness(store);
    harness.channels.releaseResolvedTargetIfClaimed
      .mockRejectedValueOnce(new Error('route store unavailable'));

    await expect(harness.finalizer.run(target.target_id)).rejects.toThrow(
      /route store unavailable/,
    );
    expect(store.get(target.target_id)).toMatchObject({
      phase: 'finalizing',
      finalizer: {
        last_error_code: 'TASK_FINALIZER_RETRY_REQUIRED',
      },
    });
    expect(store.replay(0, 500).events).toContainEqual(
      expect.objectContaining({
        payload: {
          kind: 'host.lifecycle',
          status: 'degraded',
          code: 'TASK_FINALIZER_RETRY_REQUIRED',
        },
      }),
    );
    expect(store.replay(0, 500).events).toContainEqual(
      expect.objectContaining({
        target_id: target.target_id,
        payload: {
          kind: 'task.lifecycle',
          phase: 'finalizing',
          blocked_code: 'TASK_FINALIZER_RETRY_REQUIRED',
          retryable: true,
        },
      }),
    );
    expect(store.snapshot()).toMatchObject({
      status: 'page',
      page: {
        items: [{
          receipt: { target_id: target.target_id },
          phase: 'finalizing',
          blocked: {
            code: 'TASK_FINALIZER_RETRY_REQUIRED',
            retryable: true,
          },
        }],
      },
    });

    await harness.finalizer.run(target.target_id);
    expect(store.get(target.target_id)?.phase).toBe('finalized');
  });

  it('automatically retries finalization without repeating degraded telemetry', async () => {
    const store = await readyTaskStore(join(root, 'host-auto-retry'));
    const target = store.list()[0]!;
    await store.setTerminal({
      targetId: target.target_id,
      expectedRevision: null,
      terminal: { outcome: 'cancelled' },
    });
    const harness = finalizerHarness(store, () => 1);
    harness.channels.releaseResolvedTargetIfClaimed
      .mockRejectedValueOnce(new Error('temporary route failure'));

    harness.finalizer.start(target.target_id);
    await waitFor(() => store.get(target.target_id)?.phase === 'finalized');
    harness.finalizer.stop();
    await harness.finalizer.drain();

    expect(harness.channels.releaseResolvedTargetIfClaimed).toHaveBeenCalledTimes(2);
    const degraded = store.replay(0, 500).events.filter(
      (event) =>
        event.payload.kind === 'host.lifecycle' &&
        event.payload.code === 'TASK_FINALIZER_RETRY_REQUIRED',
    );
    expect(degraded).toHaveLength(1);
    expect(store.hostStatus).toBe('ready');
    expect(store.hostStatusCode).toBeNull();
  });
});

function teamCollection(
  worktrees: WorktreeManager,
  workspace: string,
): TeamCollection {
  const log = noopLog();
  const config = testDreamuxConfig([
    testDispatcherConfig({
      id: 'dispatcher-a',
      cwd: workspace,
      agentRuntime: 'leader-runtime',
      workspaceEnabled: true,
    }),
  ]);
  return new TeamCollection({
    dispatcherId: 'dispatcher-a',
    config,
    agentRuntimeProviders: {} as AgentRuntimeProviderCatalog,
    worktrees,
    identities: new AgentIdentityStore(log),
    turnsStore: new AgentTurnsStore(log),
    router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
    initiatorFor: async () => null,
    isShuttingDown: () => false,
    adminSocketPath: '/tmp/example-admin.sock',
    leaderChannelDescriptors: () => [],
    log,
  });
}

function provisioningInput(repo: string): TaskTeamProvisionInput {
  return {
    name: 'task-team-a',
    repoCwd: repo,
    leaderAgentRuntime: 'leader-runtime',
    worktree: {
      mode: 'managed',
      slug: 'task-worktree-a',
      base_ref: 'HEAD',
      cleanup: 'delete-on-close',
    },
    intent: 'Execute a remote task attempt',
  };
}

function finalizerHarness(
  store: TaskHostStore,
  retryDelayMs?: (attempt: number) => number,
) {
  const channels = {
    releaseResolvedTargetIfClaimed: vi.fn(async () => null),
  } as unknown as ChannelService & {
    releaseResolvedTargetIfClaimed: ReturnType<typeof vi.fn>;
  };
  const teams = {
    isOpenTeam: vi.fn(async () => false),
    get: vi.fn(async () => {
      throw new Error('no Team row');
    }),
    abortProvisioning: vi.fn(async () => ({
      mode: 'managed' as const,
      slug: 'task-worktree-a',
      path: '/tmp/example-worktree',
      branch: 'dreamux/task-worktree-a',
      base_ref: 'HEAD',
      cleanup: 'delete-on-close' as const,
      cleanup_state: 'deleted' as const,
      cleanup_error: null,
    })),
    finalizeTaskProvisioning: vi.fn(async () => ({
      team_status: 'absent' as const,
      cleanup: {
        mode: 'managed' as const,
        slug: 'task-worktree-a',
        path: '/tmp/example-worktree',
        branch: 'dreamux/task-worktree-a',
        base_ref: 'HEAD',
        cleanup: 'delete-on-close' as const,
        cleanup_state: 'deleted' as const,
        cleanup_error: null,
      },
    })),
  } as unknown as TeamCollection & {
    abortProvisioning: ReturnType<typeof vi.fn>;
    finalizeTaskProvisioning: ReturnType<typeof vi.fn>;
  };
  const finalizer = new TaskTargetFinalizer({
    store,
    channels,
    teams,
    log: noopLog(),
    runExclusive: async (_targetId, task) => task(),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
  });
  return { finalizer, channels, teams };
}

async function readyTaskStore(rootDir: string): Promise<TaskHostStore> {
  const store = await TaskHostStore.open({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    providerRef: 'npm:@example/dreamux-task-channel',
    rootDir,
  });
  const claim = taskClaim();
  await applyTestTaskManifest(store, [testTaskContainer('space-a')]);
  await store.claim(claim);
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'provisioning';
    },
    [{ payload: { kind: 'task.lifecycle', phase: 'provisioning' } }],
  );
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'binding_resolved';
      target.binding = {
        space_name: 'space-a',
        generation: 1,
        repository: structuredClone(target.resolved_repository!),
        leader_agent_runtime: 'leader-runtime',
        identity: null,
      };
    },
    [{ payload: { kind: 'task.lifecycle', phase: 'binding_resolved' } }],
  );
  await store.updateTarget(
    claim.targetId,
    null,
    (target) => {
      target.phase = 'ready';
      target.team.leader_name = 'task-leader';
    },
    [{
      payload: {
        kind: 'resource.lifecycle',
        resource: {
          kind: 'team',
          resource_id: 'thr_test_team',
          revision: 1,
          state: 'ready',
        },
      },
    }],
  );
  return store;
}

function taskClaim(): TaskTargetClaimInput {
  const attempt = { task_key: 'task-a', attempt_key: 'attempt-1' };
  const identity = canonicalTaskIdentity({
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    containerType: 'task-space',
    containerKey: 'space-a',
    attempt,
  });
  return {
    dispatcherId: 'dispatcher-a',
    channelId: 'remote-tasks',
    provider: 'npm:@example/dreamux-task-channel',
    targetId: identity.targetId,
    canonicalTargetKey: identity.targetKey,
    attempt,
    container: { container_type: 'task-space', container_key: 'space-a' },
    manifestRevision: 1,
    containerGeneration: 1,
    logicalRepository: { repository_key: 'repository-a' },
    resolvedRepository: {
      source: 'channel',
      logical_key: 'repository-a',
      binding_revision: 'revision-1',
      fingerprint: 'fingerprint-1',
      repo_cwd: '/tmp/example-repository',
      base_ref: null,
      base_commit: '0000000000000000000000000000000000000000',
    },
    requestFingerprint: 'request-fingerprint',
    receipt: {
      receipt_id: identity.receiptId,
      target_id: identity.targetId,
      attempt,
      revision: 1,
      accepted_at: 1,
      manifest_revision: 1,
      container_generation: 1,
    },
    title: 'Task A',
    turn: { sourceId: 'delivery-a', text: 'Execute task A' },
    teamName: identity.teamName,
    worktreeSlug: identity.worktreeSlug,
    routeClaimId: identity.routeClaimId,
  };
}

function intent(targetId: string) {
  return {
    targetId,
    kind: 'root' as const,
    operationId: `operation-${targetId}`,
    inputDigest: 'a'.repeat(64),
    parentOperationId: null,
    toolCallId: 'root',
    toolCallOrdinal: 0,
    runtimeId: 'leader-runtime',
    runtimeRole: 'leader' as const,
    durabilityNamespace: 'namespace-a',
    delivery: {
      kind: 'text' as const,
      input: { sourceId: 'root', text: 'Execute task A' },
    },
    effect: { kind: 'root' as const },
  };
}

function runtimeRecord(operationId: string, settlement: null) {
  return {
    operation_id: operationId,
    input_digest: 'a'.repeat(64),
    turn_id: 'turn-a',
    revision: 1,
    settlement,
    settlement_acknowledged_revision: 0,
  };
}

function noopLog(): DreamuxLogger {
  const sink = () => {};
  return { error: sink, warn: sink, info: sink, debug: sink, trace: sink };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for recovery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
