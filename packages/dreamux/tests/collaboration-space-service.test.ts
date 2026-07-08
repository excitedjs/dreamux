import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  fakeChannels,
  fakeConfig,
  fakeTeams,
  log,
  type CreatedTeam,
} from './helpers/collaboration-space.js';

describe('CollaborationSpaceService', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-collab-space-'));
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

  it('binds, provisions targets, dissolves as unbind, and rebinds with a new generation', async () => {
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
    expect(dissolved).toEqual([provisioned?.team_name]);
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
      async create(input: CreatedTeam & { name: string }) {
        createCount += 1;
        if (createCount === 1) {
          throw new Error('simulated Team creation failure');
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
      async requireOpenTeamRouteOwner(name: string) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not open`);
        return { kind: 'team' as const, teamName: name, leaderName: `${name}-leader` };
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

    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config: fakeConfig(),
      teams: teamsWithFailure,
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
      { lifecycle_status: 'failed', last_error: expect.stringMatching(/simulated/) },
    ]);

    // Second attempt - succeeds (the mock fails only on first call)
    const result = await service.provisionTarget(targetInput);
    expect(result).toMatchObject({ lifecycle_status: 'active' });
    // Only one Team was created despite two attempts
    expect(created).toHaveLength(1);
    expect(createCount).toBe(2);
  });

  it('closeTarget failure leaves target in retryable closing state with error recorded', async () => {
    const created: CreatedTeam[] = [];
    const dissolved: string[] = [];
    const channels = fakeChannels();

    // Teams mock where dissolve fails
    const teamsWithBadDissolve = {
      async create(input: CreatedTeam & { name: string }) {
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
      async requireOpenTeamRouteOwner(name: string) {
        const match = created.find((t) => t.name === name);
        if (match === undefined) throw new Error(`Team ${name} is not open`);
        return { kind: 'team' as const, teamName: name, leaderName: `${name}-leader` };
      },
      async get(name: string) {
        return {
          async dissolve() {
            dissolved.push(name);
            throw new Error('simulated dissolve failure');
          },
        };
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
        last_error: expect.stringMatching(/simulated dissolve failure/),
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
});
