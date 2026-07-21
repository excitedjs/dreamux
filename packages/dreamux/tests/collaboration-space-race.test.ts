import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
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

describe('CollaborationSpaceService race regressions', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-collab-race-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
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
          owner: manualOwner,
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
    const withOwner = teams.withRoutableTeamOwner.bind(teams);
    let closing = false;
    teams.withRoutableTeamOwner = async (teamId, task) => {
      if (closing) throw new Error(`Team ${JSON.stringify(teamId)} is closing`);
      return withOwner(teamId, task);
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
});
