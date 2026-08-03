import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
import { PUBLIC_TARGET_LIFECYCLE_ERROR } from '../src/service/collaboration-space/view.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { TeamDissolveBlockedError } from '../src/service/team-collection/errors.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveRecord,
  TeamSummary,
} from '../src/service/team-collection/types.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  fakeChannels,
  fakeConfig,
  fakeTeams,
  log,
  type CreatedTeam,
} from './helpers/collaboration-space.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('CollaborationSpaceService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-collab-space-'));
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

  it('binds, provisions targets, dissolves as unbind, and rebinds with a new generation', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new CollaborationSpaceStore();
    const events: ChannelCoreEvent[] = [];
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      coreEvents: {
        publish(_dispatcherId, event) {
          events.push(event);
        },
      },
      log: log as never,
      isShuttingDown: () => false,
    });

    const bound = await service.bind({
      spaceName: 'space-alpha',
      container: {
        container_type: 'topic_group',
        container_key: 'container-1',
        display: 'Alpha Topics',
      },
      repo: { cwd: '/repo/a', baseRef: 'main' },
      leaderAgentRuntime: 'agent-a',
      identity: 'Default leader identity',
    });
    expect(bound.space).toMatchObject({
      space_name: 'space-alpha',
      status: 'bound',
      current_binding: {
        generation: 1,
        leader_agent_runtime: 'agent-a',
        has_identity: true,
      },
    });
    const replayed = await service.bind({
      spaceName: 'space-alpha',
      container: {
        container_type: 'topic_group',
        container_key: 'container-1',
        display: 'Renamed Alpha Topics',
        meta: { chat_id: 'container-1', refreshed: true },
      },
      repo: { cwd: '/repo/a', baseRef: 'main' },
      leaderAgentRuntime: 'agent-a',
      identity: 'Default leader identity',
    });
    expect(replayed.space.current_binding).toMatchObject({ generation: 1 });
    await expect(store.getSpace('flow', 'space-alpha')).resolves.toMatchObject({
      display: 'Renamed Alpha Topics',
      meta: { refreshed: true },
      current_binding: { generation: 1 },
    });
    expect(events.filter((event) =>
      event.kind === 'binding.collaboration_space')).toHaveLength(1);
    await expect(service.bind({
      spaceName: 'space-alpha',
      container: {
        container_type: 'topic_group',
        container_key: 'container-1',
      },
      repo: { cwd: '/repo/a', baseRef: 'main' },
      leaderAgentRuntime: 'agent-b',
      identity: 'Default leader identity',
    })).rejects.toThrow(/dissolve it before changing its binding policy/);

    const firstTarget = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-1',
        bindable: true,
        display: 'Fix Login',
      },
      eventId: 'event-1',
    };
    await expect(service.acceptTargetCreated(firstTarget)).resolves.toBe(true);
    expect(created).toHaveLength(0);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'creating', phase: 'claimed' }],
    });

    const first = await service.provisionTarget(firstTarget);
    expect(first).toMatchObject({
      lifecycle_status: 'active',
      binding_generation: 1,
      target_key: 'topic-1',
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      repoCwd: '/repo/a',
      leaderAgentRuntime: 'agent-a',
      identity: 'Default leader identity',
      worktree: {
        mode: 'managed',
        cleanup: 'delete-on-close',
        base_ref: 'main',
      },
    });
    expect(channels.boundOwners.get('topic-1')).toMatchObject({
      teamName: first?.team_name,
    });

    const dissolvedSpace = await service.dissolve({
      spaceName: 'space-alpha',
      note: 'switch repository',
    });
    expect(dissolvedSpace).toMatchObject({
      detached_targets: 1,
      released_bindings: 1,
      space: { status: 'unbound' },
    });
    expect(dissolved).toEqual([]);
    expect(channels.boundOwners.has('topic-1')).toBe(false);

    await service.bind({
      spaceName: 'space-alpha',
      repo: { cwd: '/repo/b' },
      leaderAgentRuntime: 'agent-b',
      identity: 'Second identity',
    });
    const second = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-1',
        bindable: true,
        display: 'Fix Login',
      },
    });

    expect(second).toMatchObject({
      lifecycle_status: 'active',
      binding_generation: 2,
    });
    expect(second?.team_name).not.toBe(first?.team_name);
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({
      repoCwd: '/repo/b',
      leaderAgentRuntime: 'agent-b',
      identity: 'Second identity',
    });
  });

  it('persists provider target meta from topic provisioning into the resulting binding', async () => {
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
      container: {
        container_type: 'topic_group',
        container_key: 'chat-topic',
        meta: { chat_id: 'chat-topic', chat_mode: 'topic' },
      },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'chat-topic' },
      target: {
        target_type: 'topic',
        target_key: 'topic-1',
        bindable: true,
        meta: {
          chat_id: 'chat-topic',
          chat_type: 'group',
          chat_mode: 'topic',
          thread_id: 'topic-1',
          message_id: 'msg-trigger',
        },
      },
    };

    await expect(service.acceptTargetCreated(target)).resolves.toBe(true);
    const provisioned = await service.provisionTarget({
      ...target,
      target: {
        target_type: 'topic',
        target_key: 'topic-1',
        bindable: true,
      },
    });
    expect(provisioned).toMatchObject({
      target_meta: {
        chat_id: 'chat-topic',
        thread_id: 'topic-1',
        message_id: 'msg-trigger',
      },
    });
    const stored = await new CollaborationSpaceStore().getTarget('flow', {
      channelId: 'primary',
      containerKey: 'chat-topic',
      bindingGeneration: 1,
      targetKey: 'topic-1',
    });
    expect(stored).toMatchObject({
      target_meta: { message_id: 'msg-trigger' },
    });
    expect(channels.claimedTargetMetas.get('topic-1')).toMatchObject({
      chat_id: 'chat-topic',
      chat_mode: 'topic',
      thread_id: 'topic-1',
      message_id: 'msg-trigger',
    });
  });

  it('accepts target close before dissolving the provisioned Team asynchronously', async () => {
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
      container: {
        container_type: 'topic_group',
        container_key: 'container-1',
      },
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-closed',
        bindable: true,
        display: 'Close Me',
      },
    };
    const provisioned = await service.provisionTarget(targetInput);
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    expect(channels.boundOwners.has('topic-closed')).toBe(true);
    const owner = channels.boundOwners.get('topic-closed');
    if (owner === undefined) throw new Error('provisioned route is missing');
    await channels.service.bindResolvedTarget({
      team: {
        team_name: owner.teamName,
        leader_name: owner.leaderName,
        leader_agent_runtime: 'agent-a',
        runtime_cwd: `/tmp/dreamux-test/${owner.teamName}`,
      },
      channelId: 'primary',
      target: {
        target_type: 'topic',
        target_key: 'topic-explicit-extra',
        bindable: true,
      },
    });
    expect(channels.boundOwners.has('topic-explicit-extra')).toBe(true);

    await expect(service.acceptTargetClosed(targetInput)).resolves.toBe(true);
    expect(dissolved).toEqual([]);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'closing', phase: 'bound' }],
    });

    await expect(service.closeTarget(targetInput)).resolves.toMatchObject({
      closed: true,
      target: { lifecycle_status: 'closed', phase: 'closed' },
    });
    expect(channels.boundOwners.has('topic-closed')).toBe(false);
    expect(channels.boundOwners.has('topic-explicit-extra')).toBe(false);
    expect(dissolved).toEqual([provisioned?.team_name]);
  });

  it('closes an orphan Team created before the target recorded its leader', async () => {
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
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-orphan-team',
        bindable: true,
      },
    } as const;
    await service.acceptTargetCreated(input);
    const accepted = await service.status({ spaceName: 'space-alpha' });
    const teamName = accepted.targets[0]?.team_name;
    if (teamName === undefined) throw new Error('target Team name is missing');
    await teams.create({
      name: teamName,
      leaderAgentRuntime: 'agent-a',
      intent: 'simulated post-create crash',
    });

    await service.acceptTargetClosed(input);
    await expect(service.closeTarget(input)).resolves.toMatchObject({
      closed: true,
      target: { lifecycle_status: 'closed', leader_name: null },
    });
    expect(dissolved).toEqual([teamName]);
  });

  it('binds without repo and provisions targets with the default workspace policy', async () => {
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

    const bound = await service.bind({
      spaceName: 'space-default',
      container: { container_type: 'topic_group', container_key: 'container-default' },
      leaderAgentRuntime: 'agent-a',
    });
    expect(bound.space.current_binding).toMatchObject({
      worktree: { mode: 'default' },
    });

    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-default' },
      target: {
        target_type: 'topic',
        target_key: 'topic-default',
        bindable: true,
      },
    });

    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('repoCwd');
    expect(created[0]).not.toHaveProperty('worktree');
  });

  it('concurrent accepts for different targets preserve both durable claims', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    await Promise.all([
      service.acceptTargetCreated({
        channelId: 'primary',
        provider: 'builtin:test',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: {
          target_type: 'topic',
          target_key: 'topic-a',
          bindable: true,
        },
      }),
      service.acceptTargetCreated({
        channelId: 'primary',
        provider: 'builtin:test',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: {
          target_type: 'topic',
          target_key: 'topic-b',
          bindable: true,
        },
      }),
    ]);

    const status = await service.status({ spaceName: 'space-alpha' });
    expect(status.targets.map((target) => target.target_key).sort()).toEqual([
      'topic-a',
      'topic-b',
    ]);
  });

  it('concurrent target_created provisions create exactly one Team', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-concurrent',
        bindable: true,
        display: 'Concurrent Topic',
      },
      eventId: 'event-concurrent',
    };

    // Fire two provisions concurrently
    const [result1, result2] = await Promise.all([
      service.provisionTarget(targetInput),
      service.provisionTarget(targetInput),
    ]);

    // Both should succeed and reference the same Team
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1?.team_name).toBe(result2?.team_name);
    expect(result1?.lifecycle_status).toBe('active');
    // Exactly one Team was created
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe(result1?.team_name);
  });

  it('repeated provision of an active target is idempotent', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-idempotent',
        bindable: true,
        display: 'Idempotent Topic',
      },
    };

    const first = await service.provisionTarget(targetInput);
    expect(first).toMatchObject({ lifecycle_status: 'active' });
    expect(created).toHaveLength(1);

    // Second provision of the same active target
    const second = await service.provisionTarget(targetInput);
    expect(second).toMatchObject({ lifecycle_status: 'active' });
    expect(second?.team_name).toBe(first?.team_name);
    // Still only one Team
    expect(created).toHaveLength(1);
  });

  it('reclaims a missing route for an active target with a routable Team', async () => {
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
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-reconcile',
        bindable: true,
      },
    };
    const first = await service.provisionTarget(input);
    channels.boundOwners.delete(input.target.target_key);

    const reconciled = await service.provisionTarget(input);

    expect(reconciled).toMatchObject({
      lifecycle_status: 'active',
      team_name: first?.team_name,
    });
    expect(channels.boundOwners.get(input.target.target_key)).toMatchObject({
      teamName: first?.team_name,
      leaderName: first?.leader_name,
    });
    expect(created).toHaveLength(1);
  });

  it('releases a managed route left ahead of a non-active target and resumes it', async () => {
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
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      target_type: 'topic',
      target_key: 'topic-claim-ahead',
      bindable: true,
    };
    await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    const record = (await store.listTargets('flow'))[0]!;
    await store.saveTarget({
      ...record,
      lifecycle_status: 'failed',
      last_error: 'simulated active-write crash',
      updated_at: Date.now(),
    });

    await service.reconcileInboundTargetRoute({ channelId: 'primary', target });
    expect(channels.boundOwners.has(target.target_key)).toBe(false);
    await expect(service.provisionClaimedTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      target,
    })).resolves.toMatchObject({ lifecycle_status: 'active' });
    expect(channels.boundOwners.has(target.target_key)).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('keeps explicit detach durable and releases its stale managed claim', async () => {
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
      target_key: 'topic-detach',
      bindable: true,
    };
    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    const owner = channels.boundOwners.get(target.target_key)!;

    await service.mutateTargetRoute(
      { channelId: 'primary', target, expectedOwner: owner },
      async () => undefined,
    );
    await service.resumePendingTargets();

    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{
        team_name: provisioned?.team_name,
        lifecycle_status: 'detached',
      }],
    });
    expect(channels.boundOwners.has(target.target_key)).toBe(false);
    await expect(service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    })).resolves.toMatchObject({ lifecycle_status: 'detached' });
    expect(created).toHaveLength(1);
  });

  it('preserves an explicit rebind to the former collaboration Team', async () => {
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
      target_key: 'topic-explicit-rebind',
      bindable: true,
    };
    await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    const owner = channels.boundOwners.get(target.target_key)!;

    await service.mutateTargetRoute(
      { channelId: 'primary', target, expectedOwner: owner },
      () => channels.service.transferResolvedTargetBack({
        channelId: 'primary',
        target,
        expectedOwner: owner,
      }),
    );
    await service.mutateTargetRoute(
      { channelId: 'primary', target },
      () => channels.service.bindResolvedTarget({
        channelId: 'primary',
        target,
        team: {
          team_name: owner.teamName,
          leader_name: owner.leaderName,
          leader_agent_runtime: 'agent-a',
          runtime_cwd: `/tmp/dreamux-test/${owner.teamName}`,
        },
      }),
    );
    await service.reconcileInboundTargetRoute({ channelId: 'primary', target });

    expect(channels.boundOwners.get(target.target_key)).toEqual(owner);
    expect(channels.claimIds.get(target.target_key)).toBeNull();
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'detached' }],
    });
  });

  it('a closed target cannot be reopened by provisioning', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-closed-forever',
        bindable: true,
        display: 'Closed Forever',
      },
    };

    const provisioned = await service.provisionTarget(targetInput);
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });

    // Close it
    await service.acceptTargetClosed(targetInput);
    await service.closeTarget(targetInput);
    expect(dissolved).toHaveLength(1);

    // Try to provision again - should throw
    await expect(service.provisionTarget(targetInput)).rejects.toThrow(
      /closed and cannot be reopened/,
    );
    await expect(service.acceptAndProvisionTarget(targetInput)).rejects.toThrow(
      /closed and cannot be reopened/,
    );
    // Still only one Team was ever created
    expect(created).toHaveLength(1);
  });

  it('conflicting active binding from another Team is detected and rejected', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    // Pre-bind the target to a different Team via ChannelService
    channels.boundOwners.set('topic-conflict', {
      kind: 'team',
      teamName: 'other-team',
      leaderName: 'other-leader',
    });

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-conflict',
        bindable: true,
        display: 'Conflict Topic',
      },
    };

    await expect(service.provisionTarget(targetInput)).rejects.toThrow(
      /already bound to Team/,
    );
    // No Team was created for the failed provision
    expect(created).toHaveLength(0);
  });

  it('failed provision retries without duplicating Teams', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();

    // Custom teams mock that fails on first create
    let createCount = 0;
    const teamsWithFailure = {
      async claimName(prefix: string, claimToken: string) {
        return { name: `${prefix}-0000`, token: claimToken };
      },
      async create(input: CreatedTeam & { name: string }) {
        createCount += 1;
        if (createCount === 1) {
          throw new Error(
            `simulated Team creation failure at ${join(root, 'private-repo')} ` +
              'token=do-not-publish',
          );
        }
        created.push(input);
        return {
          team: { team_name: input.name, leader_name: `${input.name}-leader` },
          leader: null,
          member_count: 0,
          turn: null,
        };
      },
      async isOpenTeam(name: string) {
        return created.some((t) => t.name === name);
      },
      async hasTeam(name: string) {
        return created.some((t) => t.name === name);
      },
      async requireOpenTeamRouteOwner(name: string) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not open`);
        return { kind: 'team' as const, teamName: name, leaderName: `${name}-leader` };
      },
      async requireRoutableTeamOwner(name: string) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not routable`);
        return { kind: 'team' as const, teamName: name, leaderName: `${name}-leader` };
      },
      async withRoutableTeamProjection<T>(name: string, task: (projection: {
        team_name: string;
        leader_name: string;
        leader_agent_runtime: string;
        runtime_cwd: string;
      }) => Promise<T>) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not routable`);
        return task({
          team_name: name,
          leader_name: `${name}-leader`,
          leader_agent_runtime: 'agent-a',
          runtime_cwd: `/tmp/dreamux-test/${name}`,
        });
      },
      async withTeamRouteClosing<T>(name: string, task: (owner: {
        kind: 'team'; teamName: string; leaderName: string;
      }) => Promise<T>) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not open`);
        return task({ kind: 'team', teamName: name, leaderName: `${name}-leader` });
      },
      async get(name: string) {
        return {
          async dissolve() {
            dissolved.push(name);
            return { team: { team_name: name }, leader: null, member_count: 0 };
          },
        };
      },
    } as unknown as TeamCollection;

    const store = new CollaborationSpaceStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: teamsWithFailure,
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

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-retry',
        bindable: true,
        display: 'Retry Topic',
      },
    };

    // First attempt - fails during Team creation
    await expect(service.provisionTarget(targetInput)).rejects.toThrow(
      /simulated Team creation failure/,
    );
    // Verify the target is in 'failed' state
    const status = await service.status({ spaceName: 'space-alpha' });
    expect(status.targets).toMatchObject([
      { lifecycle_status: 'failed', last_error: PUBLIC_TARGET_LIFECYCLE_ERROR },
    ]);
    expect(JSON.stringify(status)).not.toContain(root);
    expect(JSON.stringify(status)).not.toContain('do-not-publish');
    expect((await store.listTargets('flow'))[0]?.last_error).toContain('simulated');

    // Second attempt - succeeds (the mock fails only on first call)
    const result = await service.provisionTarget(targetInput);
    expect(result).toMatchObject({ lifecycle_status: 'active' });
    // Only one Team was created despite two attempts
    expect(created).toHaveLength(1);
    expect(createCount).toBe(2);
  });

  it('recreates a closed Team for a failed team_created checkpoint', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const teams = fakeTeams(created, dissolved);
    const store = new CollaborationSpaceStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams,
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-closed-team-checkpoint',
        bindable: true,
      },
    } as const;
    const provisioned = await service.provisionTarget(input);
    if (provisioned === null) throw new Error('target was not provisioned');
    expect(provisioned.team_name).toMatch(/^space-target-[a-z0-9]{4,8}$/);
    const accepted = await service.dissolveTeam({
      teamId: provisioned.team_name,
      note: 'simulate completed shutdown compensation',
    });
    await accepted.completed;
    await store.saveTarget({
      ...provisioned,
      lifecycle_status: 'failed',
      phase: 'team_created',
      last_error: 'simulated interrupted checkpoint reset',
      updated_at: Date.now(),
    });

    const reprovisioned = await service.provisionTarget(input);
    expect(reprovisioned).toMatchObject({
      lifecycle_status: 'active',
      phase: 'bound',
    });
    expect(reprovisioned?.team_name).not.toBe(provisioned.team_name);
    expect(created).toHaveLength(2);
    expect(created[1]?.name).not.toBe(created[0]?.name);
    expect(dissolved).toEqual([provisioned.team_name]);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(true);
  });

  it('does not mark a target active for a stale open Team without a usable leader', async () => {
    const created: CreatedTeam[] = [];
    const channels = fakeChannels();
    let staleRecordExists = false;
    const staleTeams = {
      async claimName(prefix: string, claimToken: string) {
        return { name: `${prefix}-0000`, token: claimToken };
      },
      async create(input: CreatedTeam) {
        created.push(input);
        throw new Error('stale Team must not be recreated implicitly');
      },
      async isOpenTeam() {
        return staleRecordExists;
      },
      async hasTeam() {
        return staleRecordExists;
      },
      async requireRoutableTeamOwner() {
        throw new Error('persisted TeamLeader identity is missing');
      },
      async withRoutableTeamProjection() {
        throw new Error('persisted TeamLeader identity is missing');
      },
    } as unknown as TeamCollection;
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: staleTeams,
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    await service.acceptTargetCreated({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-stale-team',
        bindable: true,
      },
    });
    staleRecordExists = true;

    await service.resumePendingTargets();

    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{
        target_key: 'topic-stale-team',
        lifecycle_status: 'failed',
        last_error: PUBLIC_TARGET_LIFECYCLE_ERROR,
      }],
    });
    expect(created).toEqual([]);
    expect(channels.boundOwners.has('topic-stale-team')).toBe(false);
  });

  it('closeTarget failure leaves target in retryable closing state with error recorded', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();

    // Team logical resource close fails after durable dissolve acceptance.
    const baseTeams = fakeTeams(created, dissolved) as unknown as Record<
      string,
      unknown
    >;
    const teamsWithBadDissolve = {
      ...baseTeams,
      async closeAcceptedResources(input: { teamId: string }) {
        dissolved.push(input.teamId);
        throw new Error('simulated dissolve failure');
      },
    } as unknown as TeamCollection;

    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: teamsWithBadDissolve,
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => false,
    });

    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });

    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-close-fail',
        bindable: true,
        display: 'Close Fail Topic',
      },
    };

    const provisioned = await service.provisionTarget(targetInput);
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });

    // Accept close (marks closing)
    await expect(service.acceptTargetClosed(targetInput)).resolves.toBe(true);
    const statusAfterAccept = await service.status({ spaceName: 'space-alpha' });
    expect(statusAfterAccept.targets).toMatchObject([
      { lifecycle_status: 'closing' },
    ]);

    // Attempt close - it will fail
    await expect(service.closeTarget(targetInput)).rejects.toThrow(
      /simulated dissolve failure/,
    );

    // Target should still be in 'closing' state (retryable), with error recorded
    const statusAfterFail = await service.status({ spaceName: 'space-alpha' });
    expect(statusAfterFail.targets).toMatchObject([
      {
        lifecycle_status: 'closing',
        last_error: PUBLIC_TARGET_LIFECYCLE_ERROR,
      },
    ]);

    // acceptTargetClosed should still return true (retryable)
    await expect(service.acceptTargetClosed(targetInput)).resolves.toBe(true);
    await expect(service.provisionTarget(targetInput)).rejects.toThrow(
      /closing and cannot be provisioned/,
    );
    await expect(service.acceptAndProvisionTarget(targetInput)).rejects.toThrow(
      /closing and cannot be provisioned/,
    );
  });

  it('records a safe error when Team dissolve is rejected before logical close', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const baseTeams = fakeTeams(created, dissolved) as unknown as Record<
      string,
      unknown
    >;
    const teams = {
      ...baseTeams,
      async acceptDissolve() {
        throw new TeamDissolveBlockedError('dirty');
      },
    } as unknown as TeamCollection;
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
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-preflight-fail',
        bindable: true,
      },
    };
    await service.provisionTarget(input);
    await expect(service.acceptTargetClosed(input)).rejects.toMatchObject({
      reason: 'dirty',
    });
    await expect(service.status({ spaceName: 'space-alpha' }))
      .resolves.toMatchObject({
        targets: [{
          lifecycle_status: 'closing',
          last_error: PUBLIC_TARGET_LIFECYCLE_ERROR,
        }],
      });
  });

  it('persists target closed at logicalClosed without waiting for completed', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const baseTeams = fakeTeams(created, dissolved) as unknown as Record<
      string,
      unknown
    >;
    const logical = deferred<TeamSummary>();
    const completed = deferred<TeamSummary>();
    let accepted = false;
    let record: TeamDissolveRecord | null = null;
    const teams = {
      ...baseTeams,
      async acceptDissolve(input: {
        teamId: string;
        note: string;
        requester: { handoffId: string };
      }): Promise<AcceptedTeamDissolve> {
        accepted = true;
        record = {
          operation_id: 'operation-target',
          requester_kind: 'collaboration_target',
          leader_name: null,
          target_handoff_ids: [input.requester.handoffId],
          note: input.note,
          accepted_at: 1,
          phase: 'worktree_cleanup_pending',
          last_error: null,
          cleanup_attempts: 0,
          next_retry_at: null,
        };
        return {
          operationId: record.operation_id,
          teamId: input.teamId,
          receipt: {
            accepted: true,
            team_name: input.teamId,
            status: 'closing',
          },
          logicalClosed: logical.promise,
          completed: completed.promise,
          dissolveSnapshot: () => record!,
        };
      },
      startAcceptedDissolve() {},
    } as unknown as TeamCollection;
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
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-logical-milestone',
        bindable: true,
      },
    };
    const provisioned = await service.provisionTarget(input);
    await service.acceptTargetClosed(input);
    let closeSettled = false;
    const close = service.closeTarget(input).finally(() => {
      closeSettled = true;
    });
    await waitFor(() => accepted);
    expect(closeSettled).toBe(false);
    let completionSettled = false;
    void completed.promise.then(() => {
      completionSettled = true;
    });
    logical.resolve({
      team: { team_name: provisioned!.team_name, status: 'closed' },
      leader: null,
      member_count: 0,
    } as TeamSummary);
    await expect(close).resolves.toMatchObject({
      closed: true,
      target: { lifecycle_status: 'closed' },
    });
    expect(completionSettled).toBe(false);
    completed.resolve({
      team: { team_name: provisioned!.team_name, status: 'closed' },
      leader: null,
      member_count: 0,
    } as TeamSummary);
  });

  it('dissolve retries when release fails before the space is marked unbound', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const releaser = channels.service as unknown as {
      releaseResolvedTargetIfClaimed(input: {
        claimId: string;
        channelId: string;
        target: { target_key: string };
      }): Promise<unknown>;
    };
    const originalRelease = releaser.releaseResolvedTargetIfClaimed.bind(releaser);
    let failRelease = true;
    releaser.releaseResolvedTargetIfClaimed = async (input) => {
      if (failRelease) throw new Error('simulated release failure');
      return originalRelease(input);
    };
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-release-retry',
        bindable: true,
      },
    });

    await expect(
      service.dissolve({ spaceName: 'space-alpha', note: 'release fails first' }),
    ).rejects.toThrow(/simulated release failure/);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      space: { status: 'bound' },
      targets: [{ target_key: 'topic-release-retry', lifecycle_status: 'detached' }],
    });
    expect(channels.boundOwners.has('topic-release-retry')).toBe(true);

    failRelease = false;
    await expect(
      service.dissolve({ spaceName: 'space-alpha', note: 'retry succeeds' }),
    ).resolves.toMatchObject({
      detached_targets: 0,
      released_bindings: 1,
      space: { status: 'unbound' },
    });
    expect(channels.boundOwners.has('topic-release-retry')).toBe(false);
  });

  it('uses the accepted target-close generation even after a later rebind', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-close-generation',
        bindable: true,
      },
    };
    const first = await service.provisionTarget(targetInput);
    const accepted = await service.acceptTargetClosedForClose(targetInput);
    if (accepted === null) throw new Error('target close was not accepted');

    channels.boundOwners.delete('topic-close-generation');
    await service.dissolve({ spaceName: 'space-alpha', note: 'switch generation' });
    await service.bind({
      spaceName: 'space-alpha',
      repo: { cwd: '/repo/b' },
      leaderAgentRuntime: 'agent-b',
    });
    const second = await service.provisionTarget(targetInput);
    expect(second?.team_name).not.toBe(first?.team_name);
    expect(channels.boundOwners.get('topic-close-generation')).toMatchObject({
      teamName: second?.team_name,
    });

    await expect(accepted.close()).resolves.toMatchObject({
      closed: true,
      target: {
        binding_generation: first?.binding_generation,
        lifecycle_status: 'closed',
      },
    });
    expect(dissolved).toEqual([first?.team_name]);
    expect(channels.boundOwners.get('topic-close-generation')).toMatchObject({
      teamName: second?.team_name,
    });
  });

  it('acceptAndProvisionTarget returns null for unbound containers', async () => {
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

    // No space bound for this container
    const result = await service.acceptAndProvisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'no-such-container' },
      target: {
        target_type: 'topic',
        target_key: 'topic-orphan',
        bindable: true,
      },
    });

    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('resumes pending creating targets after durable accept', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    await expect(
      service.acceptTargetCreated({
        channelId: 'primary',
        provider: 'builtin:test',
        container: { container_type: 'topic_group', container_key: 'container-1' },
        target: {
          target_type: 'topic',
          target_key: 'topic-resume-create',
          bindable: true,
        },
      }),
    ).resolves.toBe(true);
    expect(created).toHaveLength(0);

    await service.resumePendingTargets();

    expect(created).toHaveLength(1);
    expect(channels.boundOwners.has('topic-resume-create')).toBe(true);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ target_key: 'topic-resume-create', lifecycle_status: 'active' }],
    });
  });

  it('resumes pending closing targets after durable close accept', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    const targetInput = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-resume-close',
        bindable: true,
      },
    };
    const provisioned = await service.provisionTarget(targetInput);
    await expect(service.acceptTargetClosed(targetInput)).resolves.toBe(true);
    expect(dissolved).toEqual([]);

    await service.resumePendingTargets();

    expect(channels.boundOwners.has('topic-resume-close')).toBe(false);
    expect(dissolved).toEqual([provisioned?.team_name]);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ target_key: 'topic-resume-close', lifecycle_status: 'closed' }],
    });
  });

  it('dissolve detaches an accepted target before its deferred provision can bind', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    const accepted = await service.acceptTargetCreatedForProvision({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-dissolve-race',
        bindable: true,
      },
    });
    expect(accepted).not.toBeNull();

    await expect(
      service.dissolve({ spaceName: 'space-alpha', note: 'unbind before provision' }),
    ).resolves.toMatchObject({
      detached_targets: 1,
      released_bindings: 0,
      space: { status: 'unbound' },
    });
    await expect(accepted?.provision()).resolves.toMatchObject({
      lifecycle_status: 'detached',
    });
    await expect(
      service.provisionClaimedTarget({
        channelId: 'primary',
        provider: 'builtin:test',
        target: {
          target_type: 'topic',
          target_key: 'topic-dissolve-race',
          bindable: true,
        },
      }),
    ).resolves.toBeNull();
    expect(created).toEqual([]);
    expect(channels.boundOwners.has('topic-dissolve-race')).toBe(false);
  });

  it('provisions an existing durable claim without requiring a fresh container', async () => {
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
      repo: { cwd: '/repo/a' },
      leaderAgentRuntime: 'agent-a',
    });
    await service.acceptTargetCreated({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-claim-only',
        bindable: true,
      },
    });

    const provisioned = await service.provisionClaimedTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      target: {
        target_type: 'topic',
        target_key: 'topic-claim-only',
        bindable: true,
      },
    });

    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    expect(created).toHaveLength(1);
    expect(channels.boundOwners.has('topic-claim-only')).toBe(true);
  });

  it('drains accepted lifecycle tasks before stop completes', async () => {
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
    const pending = deferred<void>();
    let provisionFinished = false;

    service.startAcceptedTargetProvision({
      provision: async () => {
        await pending.promise;
        provisionFinished = true;
        return {} as never;
      },
    });
    let drained = false;
    const drain = service.drainLifecycleTasks().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    pending.resolve();
    await drain;

    expect(provisionFinished).toBe(true);
    expect(drained).toBe(true);
  });

  it('fences accepted provisioning side effects after shutdown begins', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    let shuttingDown = false;
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => shuttingDown,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const target = {
      target_type: 'topic',
      target_key: 'topic-shutdown-fence',
      bindable: true,
    };
    const accepted = await service.acceptTargetCreatedForProvision({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    });
    if (accepted === null) throw new Error('target was not accepted');

    shuttingDown = true;
    await expect(accepted.provision()).rejects.toThrow(/shutting down/);
    expect(created).toEqual([]);
    expect(channels.boundOwners.has(target.target_key)).toBe(false);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'creating', phase: 'claimed' }],
    });

    shuttingDown = false;
    await expect(accepted.provision()).resolves.toMatchObject({
      lifecycle_status: 'active',
    });
    expect(created).toHaveLength(1);
    expect(channels.boundOwners.has(target.target_key)).toBe(true);

    shuttingDown = true;
    await expect(service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target,
    })).rejects.toThrow(/shutting down/);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'active', phase: 'bound' }],
    });
    expect(channels.boundOwners.has(target.target_key)).toBe(true);
  });

  it('preserves an active target when shutdown begins during route reconciliation', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    let shuttingDown = false;
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => shuttingDown,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-active-mid-reconcile-stop',
        bindable: true,
      },
    } as const;
    await service.provisionTarget(input);
    const owner = channels.boundOwners.get(input.target.target_key);
    const claimId = channels.claimIds.get(input.target.target_key);
    const resolveInboundBinding = channels.service.resolveInboundBinding.bind(
      channels.service,
    );
    let stopAfterResolve = true;
    channels.service.resolveInboundBinding = async (resolveInput) => {
      const result = await resolveInboundBinding(resolveInput);
      if (stopAfterResolve) {
        stopAfterResolve = false;
        shuttingDown = true;
      }
      return result;
    };

    await expect(service.provisionTarget(input)).rejects.toThrow(/shutting down/);

    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'active', phase: 'bound' }],
    });
    expect(channels.boundOwners.get(input.target.target_key)).toEqual(owner);
    expect(channels.claimIds.get(input.target.target_key)).toBe(claimId);
    expect(claimId).not.toBeNull();
  });

  it('resets a compensated team_created target to a retryable claim', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    let shuttingDown = false;
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => shuttingDown,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-team-created-stop',
        bindable: true,
      },
    } as const;
    const resolveInboundBinding = channels.service.resolveInboundBinding.bind(
      channels.service,
    );
    let resolveCount = 0;
    channels.service.resolveInboundBinding = async (resolveInput) => {
      const result = await resolveInboundBinding(resolveInput);
      resolveCount += 1;
      if (resolveCount === 2) shuttingDown = true;
      return result;
    };

    await expect(service.provisionTarget(input)).rejects.toThrow(/shutting down/);
    expect(created).toHaveLength(1);
    await waitFor(() => dissolved.length === 1);
    expect(dissolved).toHaveLength(1);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(false);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{
        lifecycle_status: 'failed',
        phase: 'claimed',
        leader_name: null,
      }],
    });

    shuttingDown = false;
    await expect(service.provisionTarget(input)).resolves.toMatchObject({
      lifecycle_status: 'active',
    });
    expect(created).toHaveLength(2);
    expect(created[1]?.name).not.toBe(created[0]?.name);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(true);
  });

  it('resets a compensated post-active-save target to a retryable claim', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const store = new CollaborationSpaceStore();
    let shuttingDown = false;
    let stopAfterActiveSave = true;
    const saveTarget = store.saveTarget.bind(store);
    store.saveTarget = async (target) => {
      const saved = await saveTarget(target);
      if (stopAfterActiveSave && target.lifecycle_status === 'active') {
        stopAfterActiveSave = false;
        shuttingDown = true;
      }
      return saved;
    };
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: fakeTeams(created, dissolved),
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => shuttingDown,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-post-active-save-stop',
        bindable: true,
      },
    } as const;

    await expect(service.provisionTarget(input)).rejects.toThrow(/shutting down/);
    expect(created).toHaveLength(1);
    await waitFor(() => dissolved.length === 1);
    expect(dissolved).toHaveLength(1);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(false);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{
        lifecycle_status: 'failed',
        phase: 'claimed',
        leader_name: null,
      }],
    });

    shuttingDown = false;
    await expect(service.provisionTarget(input)).resolves.toMatchObject({
      lifecycle_status: 'active',
    });
    expect(created).toHaveLength(2);
    expect(created[1]?.name).not.toBe(created[0]?.name);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(true);
  });

  it('compensates a collaboration Team whose create finishes after shutdown starts', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();
    const teams = fakeTeams(created, dissolved);
    const createEntered = deferred<void>();
    const finishCreate = deferred<void>();
    const create = teams.create.bind(teams);
    teams.create = async (input) => {
      createEntered.resolve();
      await finishCreate.promise;
      return create(input);
    };
    let shuttingDown = false;
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams,
      channels: channels.service,
      log: log as never,
      isShuttingDown: () => shuttingDown,
    });
    await service.bind({
      spaceName: 'space-alpha',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      leaderAgentRuntime: 'agent-a',
    });
    const input = {
      channelId: 'primary',
      provider: 'builtin:test',
      container: { container_type: 'topic_group', container_key: 'container-1' },
      target: {
        target_type: 'topic',
        target_key: 'topic-mid-create-stop',
        bindable: true,
      },
    } as const;

    const provisioning = service.provisionTarget(input);
    await createEntered.promise;
    shuttingDown = true;
    finishCreate.resolve();

    await expect(provisioning).rejects.toThrow(/shutting down/);
    expect(created).toHaveLength(1);
    await waitFor(() => dissolved.length === 1);
    expect(dissolved).toHaveLength(1);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(false);
    await expect(service.status({ spaceName: 'space-alpha' })).resolves.toMatchObject({
      targets: [{ lifecycle_status: 'failed', phase: 'claimed' }],
    });

    shuttingDown = false;
    await expect(service.provisionTarget(input)).resolves.toMatchObject({
      lifecycle_status: 'active',
    });
    expect(created).toHaveLength(2);
    expect(created[1]?.name).not.toBe(created[0]?.name);
    expect(channels.boundOwners.has(input.target.target_key)).toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}
