import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
import { CollaborationRouteReconciler } from '../src/service/collaboration-space/route-reconciliation.js';
import { targetRouteKey } from '../src/service/collaboration-space/support.js';
import {
  COLLABORATION_SPACE_RECORD_VERSION,
  type ProvisionedTargetRecord,
} from '../src/service/collaboration-space/types.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import type { AcceptedTeamLogicalClose } from '../src/service/team-collection/types.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  fakeChannels,
  fakeConfig,
  fakeTeams,
  log,
  type CreatedTeam,
} from './helpers/collaboration-space.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class SecondFindUnboundStore extends CollaborationSpaceStore {
  calls = 0;
  flipAfterFirstFind = false;

  override async findSpaceByContainer(
    input: Parameters<CollaborationSpaceStore['findSpaceByContainer']>[0],
  ) {
    const space = await super.findSpaceByContainer(input);
    if (!this.flipAfterFirstFind || space === null) return space;
    this.calls += 1;
    if (this.calls === 1) return space;
    return { ...space, current_binding: null, status: 'unbound' as const };
  }
}

class FailDissolveOperationSaveStore extends CollaborationSpaceStore {
  failNextDissolveOperationSave = false;

  override async saveTarget(target: ProvisionedTargetRecord) {
    if (
      this.failNextDissolveOperationSave &&
      target.team_dissolve_operation_id !== null
    ) {
      this.failNextDissolveOperationSave = false;
      throw new Error('target operation-id write failed');
    }
    return super.saveTarget(target);
  }
}

describe('CollaborationSpaceService race regressions', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-collab-race-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('provisions with the accepted generation instead of re-reading bound state', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new SecondFindUnboundStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });

    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    store.flipAfterFirstFind = true;

    const provisioned = await service.acceptAndProvisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-claim-race',
        bindable: true,
      },
    });

    expect(store.calls).toBe(1);
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    expect(created).toHaveLength(1);
  });

  it('serializes container uniqueness across concurrent bind calls', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });

    const container = {
      container_type: 'topic_group',
      container_key: 'container-shared',
    };
    const results = await Promise.allSettled([
      service.bind({
        spaceName: 'space-a',
        container,
        leaderAgentRuntime: 'agent-a',
      }),
      service.bind({
        spaceName: 'space-b',
        container,
        leaderAgentRuntime: 'agent-a',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/already registered as collaboration space/),
      }),
    });
    await expect(service.list()).resolves.toMatchObject({
      spaces: [{ container_key: 'container-shared' }],
    });
  });

  it('commits one immutable policy for a concurrent rebind generation', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new CollaborationSpaceStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });
    const secondService = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store: new CollaborationSpaceStore(),
      log: log as never,
      isShuttingDown: () => false,
    });
    const container = {
      container_type: 'topic_group',
      container_key: 'container-rebind',
    };

    await service.bind({
      spaceName: 'space-rebind',
      container,
      leaderAgentRuntime: 'agent-a',
    });
    await service.dissolve({ spaceName: 'space-rebind', note: 'rebind race' });

    const policies = [
      {
        spaceName: 'space-rebind',
        container,
        repo: { cwd: '/repo/a' },
        leaderAgentRuntime: 'agent-a',
        identity: 'policy-a',
      },
      {
        spaceName: 'space-rebind',
        container,
        repo: { cwd: '/repo/b', baseRef: 'release' },
        leaderAgentRuntime: 'agent-b',
        identity: 'policy-b',
      },
    ] as const;
    const results = await Promise.allSettled([
      service.bind(policies[0]),
      secondService.bind(policies[1]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const stored = await store.getSpace('flow', 'space-rebind');
    expect(stored).toMatchObject({
      last_binding_generation: 2,
      current_binding: {
        generation: 2,
        repo_cwd: policies[winner]!.repo.cwd,
        leader_agent_runtime: policies[winner]!.leaderAgentRuntime,
        identity: policies[winner]!.identity,
      },
    });
  });

  it('serializes explicit route replacement with collaboration provisioning', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      target_type: 'topic',
      target_key: 'topic-route-race',
      bindable: true,
    };
    const manualOwner = {
      kind: 'team' as const,
      teamName: 'manual-team',
      leaderName: 'manual-leader',
    };
    const enteredMutation = deferred();
    const releaseMutation = deferred();
    const manualBind = service.mutateTargetRoute(
      { channelId: 'primary', target },
      async () => {
        enteredMutation.resolve();
        await releaseMutation.promise;
        return channels.service.bindResolvedTarget({
          channelId: 'primary',
          target,
          team: {
            team_name: manualOwner.teamName,
            leader_name: manualOwner.leaderName,
            leader_agent_runtime: 'agent-a',
            runtime_cwd: `/tmp/dreamux-test/${manualOwner.teamName}`,
          },
        });
      },
    );
    await enteredMutation.promise;

    const provisioning = service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    void provisioning.catch(() => {});
    await Promise.resolve();
    expect(created).toEqual([]);

    releaseMutation.resolve();
    await manualBind;
    await expect(provisioning).rejects.toThrow(/already bound to Team/);
    expect(channels.boundOwners.get(target.target_key)).toEqual(manualOwner);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'failed' }],
    });
  });

  it('keeps managed intent and claim intact when an explicit bind loses to Team close', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const teams = fakeTeams(created, dissolved);
    const withProjection = teams.withRoutableTeamProjection.bind(teams);
    let closing = false;
    teams.withRoutableTeamProjection = async (teamId, task) => {
      if (closing) throw new Error(`Team ${JSON.stringify(teamId)} is closing`);
      return withProjection(teamId, task);
    };
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams,
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      target_type: 'topic',
      target_key: 'topic-bind-close-race',
      bindable: true,
    };
    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    if (provisioned === null) throw new Error('target was not provisioned');
    const originalOwner = channels.boundOwners.get(target.target_key);
    const originalClaim = channels.claimIds.get(target.target_key);

    closing = true;
    await expect(service.bindTargetRoute({
      teamId: provisioned.team_name,
      channelId: 'primary',
      target,
    })).rejects.toThrow(/closing/);

    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'active', phase: 'bound' }],
    });
    expect(channels.boundOwners.get(target.target_key)).toEqual(originalOwner);
    expect(channels.claimIds.get(target.target_key)).toBe(originalClaim);
    expect(originalClaim).not.toBeNull();
  });

  it('rejects TeamLeader bind without detaching an active managed target', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const teams = fakeTeams(created, dissolved);
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams,
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      target_type: 'topic',
      target_key: 'topic-teamleader-managed',
      bindable: true,
    };
    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    if (provisioned === null || provisioned.leader_name === null) {
      throw new Error('target was not provisioned');
    }
    const originalOwner = channels.boundOwners.get(target.target_key);
    const originalClaim = channels.claimIds.get(target.target_key);

    await expect(service.bindLeasedTargetRoute({
      lease: {
        teamId: provisioned.team_name,
        leaderName: provisioned.leader_name,
      },
      channelId: 'primary',
      target,
    })).rejects.toThrow(/active collaboration route/);

    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'active', phase: 'bound' }],
    });
    expect(channels.boundOwners.get(target.target_key)).toEqual(originalOwner);
    expect(channels.claimIds.get(target.target_key)).toBe(originalClaim);
    expect(originalClaim).not.toBeNull();
  });

  it('starts an accepted Team dissolve when target correlation persistence fails', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new FailDissolveOperationSaveStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });
    const container = {
      container_type: 'topic_group',
      container_key: 'container-operation-save',
    };
    const target = {
      target_type: 'topic',
      target_key: 'topic-operation-save',
      bindable: true,
    };
    await service.bind({
      spaceName: 'space-operation-save',
      container,
      leaderAgentRuntime: 'agent-a',
    });
    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container,
      target,
    });
    if (provisioned === null) throw new Error('target was not provisioned');

    store.failNextDissolveOperationSave = true;
    await expect(service.closeTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container,
      target,
    })).rejects.toThrow('target operation-id write failed');

    await vi.waitFor(() => {
      expect(dissolved).toContain(provisioned.team_name);
    });
  });

  it('checks target handoffs authoritatively after lock handoff and supports concurrent target consumers', async () => {
    const channels = fakeChannels();
    const locks = new KeyedAsyncQueue();
    const operationId = 'operation-alpha';
    const acceptedHandoffs = new Set(['handoff-b']);
    const targetA = targetRecord('topic-a', 'active', null);
    const targetB = targetRecord('topic-b', 'closing', 'handoff-b');
    const targetMismatch = targetRecord(
      'topic-mismatch',
      'closing',
      'handoff-not-accepted',
    );
    const targetOrdinary = targetRecord('topic-ordinary', 'active', null);
    const targets = new Map(
      [targetA, targetB, targetMismatch, targetOrdinary]
        .map((target) => [target.target_key, target]),
    );
    const store = {
      async listTargets() {
        return [...targets.values()];
      },
      async getTarget(
        _dispatcherId: string,
        input: { targetKey: string },
      ) {
        return targets.get(input.targetKey) ?? null;
      },
      async saveTarget(target: ProvisionedTargetRecord) {
        targets.set(target.target_key, target);
        return target;
      },
    } as unknown as CollaborationSpaceStore;
    const teams = {
      async hasAcceptedTargetDissolveHandoff(input: {
        teamId: string;
        operationId: string;
        handoffId: string;
      }) {
        return input.teamId === 'alpha' &&
          input.operationId === operationId &&
          acceptedHandoffs.has(input.handoffId);
      },
      async closeAcceptedResources() {
        return {
          team: { team_name: 'alpha', status: 'closed' },
          leader: null,
          member_count: 0,
        };
      },
    } as unknown as TeamCollection;
    const reconciler = new CollaborationRouteReconciler({
      dispatcherId: 'flow',
      teams,
      channels: channels.service,
      store,
      locks,
      isShuttingDown: () => false,
    });
    const lockEntered = deferred();
    const releaseLock = deferred();
    const held = locks.run(targetRouteKey(targetA), async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;
    const input: AcceptedTeamLogicalClose = {
      operationId,
      teamId: 'alpha',
      note: 'close targets',
      owner: { kind: 'team', teamName: 'alpha', leaderName: 'tl-alpha' },
      // Deliberately stale: the exact handoff is appended while the runner is
      // blocked on the target lock and must be re-read from TeamCollection.
      dissolve: {
        operation_id: operationId,
        requester_kind: 'dispatcher',
        leader_name: null,
        target_handoff_ids: [],
        note: 'close targets',
        accepted_at: 1,
        phase: 'closing_resources',
        last_error: null,
        cleanup_attempts: 0,
        next_retry_at: null,
      },
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: '/tmp',
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
    };
    const close = (
      reconciler as unknown as {
        closeAcceptedTeam(input: AcceptedTeamLogicalClose): Promise<unknown>;
      }
    ).closeAcceptedTeam(input);
    await Promise.resolve();
    targets.set('topic-a', {
      ...targetA,
      lifecycle_status: 'closing',
      team_dissolve_handoff_id: 'handoff-a',
      team_dissolve_operation_id: operationId,
      team_dissolve_finalize: 'close',
    });
    acceptedHandoffs.add('handoff-a');
    releaseLock.resolve();
    await Promise.all([held, close]);

    expect(targets.get('topic-a')).toMatchObject({
      lifecycle_status: 'closing',
      team_dissolve_handoff_id: 'handoff-a',
    });
    expect(targets.get('topic-b')).toMatchObject({
      lifecycle_status: 'closing',
      team_dissolve_handoff_id: 'handoff-b',
    });
    expect(targets.get('topic-mismatch')).toMatchObject({
      lifecycle_status: 'detached',
    });
    expect(targets.get('topic-ordinary')).toMatchObject({
      lifecycle_status: 'detached',
    });
  });
});

function targetRecord(
  targetKey: string,
  status: ProvisionedTargetRecord['lifecycle_status'],
  handoffId: string | null,
): ProvisionedTargetRecord {
  return {
    version: COLLABORATION_SPACE_RECORD_VERSION,
    dispatcher_id: 'flow',
    space_name: 'space-alpha',
    channel_id: 'primary',
    provider: 'builtin:test',
    container_key: 'container-1',
    binding_generation: 1,
    target_key: targetKey,
    target_type: 'topic',
    target_display: targetKey,
    target_meta: {},
    team_name: 'alpha',
    leader_name: 'tl-alpha',
    worktree_slug: 'alpha',
    lifecycle_status: status,
    phase: 'bound',
    claim_event_id: null,
    close_event_id: null,
    team_dissolve_operation_id: handoffId === null ? null : 'operation-alpha',
    team_dissolve_handoff_id: handoffId,
    team_dissolve_finalize: handoffId === null ? null : 'close',
    last_error: null,
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    detached_at: null,
  };
}
