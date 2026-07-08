import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelRouteOwner, ChannelService } from '../src/service/channel-service/index.js';
import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { testDreamuxConfig } from './helpers/config.js';

const log = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

interface CreatedTeam {
  name: string;
  leaderAgentRuntime: string;
  identity?: string;
  repoCwd?: string;
  worktree?: Record<string, unknown>;
}

function fakeConfig() {
  return {
    ...testDreamuxConfig([]),
    agents: {
      'agent-a': { provider: 'test:runtime', config: {} },
      'agent-b': { provider: 'test:runtime', config: {} },
    },
  };
}

function fakeTeams(created: CreatedTeam[], dissolved: string[]) {
  const open = new Map<string, string>();
  return {
    async create(input: CreatedTeam & { name: string }) {
      created.push(input);
      open.set(input.name, `${input.name}-leader`);
      return {
        team: { team_name: input.name, leader_name: `${input.name}-leader` },
        leader: null,
        member_count: 0,
        turn: null,
      };
    },
    async isOpenTeam(name: string) {
      return open.has(name);
    },
    async requireOpenTeamRouteOwner(name: string) {
      const leader = open.get(name);
      if (leader === undefined) throw new Error(`Team ${name} is not open`);
      return { kind: 'team' as const, teamName: name, leaderName: leader };
    },
    async get(name: string) {
      return {
        async dissolve() {
          dissolved.push(name);
          open.delete(name);
          return {
            team: { team_name: name },
            leader: null,
            member_count: 0,
          };
        },
      };
    },
  } as unknown as TeamCollection;
}

function fakeChannels() {
  const boundOwners = new Map<string, ChannelRouteOwner>();
  const service = {
    resolveChannelId(requested?: string) {
      return requested ?? 'primary';
    },
    channelProviderRef(channelId: string) {
      if (channelId !== 'primary') throw new Error(`unknown channel ${channelId}`);
      return 'builtin:test';
    },
    async resolveInboundBinding(input: { target: { target_key: string } }) {
      const owner = boundOwners.get(input.target.target_key);
      return owner === undefined
        ? null
        : { binding: { active: true }, owner };
    },
    async bindResolvedTarget(input: {
      owner: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      boundOwners.set(input.target.target_key, input.owner);
      return { active: true, team_name: input.owner.teamName };
    },
    async transferResolvedTargetBack(input: {
      expectedOwner?: ChannelRouteOwner;
      target: { target_key: string };
    }) {
      const owner = boundOwners.get(input.target.target_key);
      if (owner === undefined) return null;
      if (
        input.expectedOwner !== undefined &&
        (owner.teamName !== input.expectedOwner.teamName ||
          owner.leaderName !== input.expectedOwner.leaderName)
      ) {
        throw new Error('owner mismatch');
      }
      boundOwners.delete(input.target.target_key);
      return { active: false, team_name: owner.teamName };
    },
  };
  return {
    boundOwners,
    service: service as unknown as ChannelService,
  };
}

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
});
