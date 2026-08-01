import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adminMethods } from '../src/admin/methods.js';
import { AdminError } from '../src/admin/protocol.js';
import { TeamUnavailableError } from '../src/service/team-collection/errors.js';
import type { Server } from '../src/server.js';

const stubServer = {
  repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
  getDispatcher: () => ({
    team: () => {
      throw new Error('team must not be reached on a rejected request');
    },
    teammates: {
      close: () => {
        throw new Error('close must not be reached on a rejected request');
      },
    },
    createTeam: () => {
      throw new Error('createTeam must not be reached on a rejected request');
    },
  }),
} as unknown as Server;

async function expectBadRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const handler = adminMethods[method];
  if (handler === undefined) throw new Error(`no admin method ${method}`);
  await expect(
    Promise.resolve(handler(stubServer, params)),
  ).rejects.toMatchObject({ name: 'AdminError', code: 'BAD_REQUEST' });
}

describe('admin layer enforces required non-empty intent/note (#182 PR-3)', () => {
  it('AdminError exposes a BAD_REQUEST code (sanity)', () => {
    expect(new AdminError('BAD_REQUEST', 'x').code).toBe('BAD_REQUEST');
  });

  it('rejects teammate.spawn with missing or empty intent', async () => {
    const base = { dispatcher_id: 'flow', name_prefix: 'a', prompt: 'go' };
    await expectBadRequest('teammate.spawn', base);
    await expectBadRequest('teammate.spawn', { ...base, intent: '' });
  });

  it('rejects teammate.spawn with blank identity', async () => {
    await expectBadRequest('teammate.spawn', {
      dispatcher_id: 'flow',
      name_prefix: 'a',
      prompt: 'go',
      intent: 'work',
      identity: '   ',
    });
  });

  it('strictly rejects malformed admin-only skill_sources before creation', async () => {
    const malformed: unknown[] = [
      null,
      {},
      [{}],
      [{ name: 'custom', path: '/skills/custom', source: '' }],
      [{ name: 'custom', path: 'relative/skills', source: 'admin' }],
      [{ name: 'custom', path: 42, source: 'admin' }],
      [{ name: '   ', path: '/skills/custom', source: 'admin' }],
    ];
    for (const skill_sources of malformed) {
      await expectBadRequest('teammate.spawn', {
        dispatcher_id: 'flow',
        name_prefix: 'a',
        prompt: 'go',
        intent: 'work',
        skill_sources,
      });
      await expectBadRequest('team.create', {
        dispatcher_id: 'flow',
        name_prefix: 'alpha',
        leader_agent_runtime: 'codex',
        intent: 'work',
        skill_sources,
      });
    }
  });

  it('rejects TeamLeader skill roots that shadow required bundled skills', async () => {
    for (const bundledSkill of ['team-workflow', 'workflow']) {
      const root = mkdtempSync(join(tmpdir(), 'dreamux-skill-shadow-'));
      try {
        mkdirSync(join(root, bundledSkill), { recursive: true });
        await expectBadRequest('team.create', {
          dispatcher_id: 'flow',
          name_prefix: 'alpha',
          leader_agent_runtime: 'codex',
          intent: 'work',
          skill_sources: [{
            name: 'shadow-root',
            path: root,
            source: 'admin',
          }],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects teammate.close with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', name: 'a' };
    await expectBadRequest('teammate.close', base);
    await expectBadRequest('teammate.close', { ...base, note: '' });
  });

  it('rejects team.create with missing or empty intent', async () => {
    const base = {
      dispatcher_id: 'flow',
      name_prefix: 'alpha',
      leader_agent_runtime: 'codex',
    };
    await expectBadRequest('team.create', base);
    await expectBadRequest('team.create', { ...base, intent: '' });
  });

  it('rejects team.create with blank identity', async () => {
    await expectBadRequest('team.create', {
      dispatcher_id: 'flow',
      name_prefix: 'alpha',
      leader_agent_runtime: 'codex',
      intent: 'work',
      identity: '   ',
    });
  });

  it('rejects team.dissolve with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('team.dissolve', base);
    await expectBadRequest('team.dissolve', { ...base, note: '' });
  });

  it('rejects team.send for TeamLeader callers and requires a non-empty prompt', async () => {
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('team.send', base);
    await expectBadRequest('team.send', { ...base, prompt: '' });
    await expectBadRequest('team.send', {
      ...base,
      caller_kind: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
      prompt: 'follow up',
    });
    await expect(
      adminMethods['team.send']!(stubServer, {
        ...base,
        caller_kind: 'team_leader',
        team_id: 'alpha',
        leader_name: 'alpha-leader',
        prompt: 'follow up',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'team.send is available only to dispatcher callers',
    });
  });
});

describe('Team channel admin methods replace the old binding methods (#209 slice 8)', () => {
  it('removes the old Feishu binding methods without aliases', () => {
    expect(adminMethods['team.bind_group']).toBeUndefined();
    expect(adminMethods['team.transfer_channel_back']).toBeUndefined();
  });

  it('registers the Team channel-binding methods (and no generic channel.* aliases)', () => {
    expect(typeof adminMethods['team.bind_channel']).toBe('function');
    expect(typeof adminMethods['team.transfer_back']).toBe('function');
    expect(adminMethods['mcp.channel.bind_channel']).toBeUndefined();
    expect(adminMethods['mcp.channel.transfer_back']).toBeUndefined();
  });

  it('bind_channel returns the binding and transfer_back composes a model-facing envelope', async () => {
    const binding = { provider: 'builtin:feishu', target_key: 'chat-demo' };
    const seen: Array<Record<string, unknown>> = [];
    const channelStub = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        bindTeamChannel: async (input: Record<string, unknown>) => {
          seen.push(input);
          return binding;
        },
        transferTeamChannelBack: async (input: Record<string, unknown>) => {
          seen.push(input);
          return binding;
        },
      }),
    } as unknown as Server;

    const bound = await adminMethods['team.bind_channel']!(channelStub, {
      dispatcher_id: 'flow',
      team_name: 'alpha',
      meta: { chat_id: 'chat-demo' },
    });
    const transferred = await adminMethods['team.transfer_back']!(channelStub, {
      dispatcher_id: 'flow',
      meta: { chat_id: 'chat-demo' },
    });
    expect(bound).toEqual(binding);
    expect(transferred).toEqual({
      transferred: true,
      binding,
      message: 'Channel target released from Team routing.',
    });
    expect(seen[0]).toMatchObject({ teamId: 'alpha', meta: { chat_id: 'chat-demo' } });
    expect(seen[1]).toMatchObject({ meta: { chat_id: 'chat-demo' } });
  });

  it('derives TeamLeader bind scope from the descriptor and rejects team_name', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const binding = { provider: 'provider:test', target_key: 'target-demo' };
    const channelStub = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        bindTeamLeaderChannel: async (input: Record<string, unknown>) => {
          seen.push(input);
          return binding;
        },
      }),
    } as unknown as Server;
    const scope = {
      dispatcher_id: 'flow',
      caller_kind: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
      meta: { target: 'target-demo' },
    };

    await expect(
      adminMethods['team.bind_channel']!(channelStub, scope),
    ).resolves.toEqual(binding);
    expect(seen).toEqual([{
      lease: { teamId: 'alpha', leaderName: 'alpha-leader' },
      meta: { target: 'target-demo' },
    }]);

    await expect(
      adminMethods['team.bind_channel']!(channelStub, {
        ...scope,
        team_name: 'beta',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(seen).toHaveLength(1);
  });

  it('maps unavailable TeamLeader scope and binding conflicts at the admin boundary', async () => {
    const scope = {
      dispatcher_id: 'flow',
      caller_kind: 'team_leader',
      team_id: 'alpha',
      leader_name: 'stale-leader',
      meta: { target: 'target-demo' },
    };
    const serverFor = (error: Error) => ({
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        bindTeamLeaderChannel: async () => { throw error; },
      }),
    }) as unknown as Server;

    await expect(adminMethods['team.bind_channel']!(
      serverFor(new TeamUnavailableError('stale TeamLeader generation')),
      scope,
    )).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' });
    await expect(adminMethods['team.bind_channel']!(
      serverFor(new Error('target is already bound')),
      scope,
    )).rejects.toMatchObject({ code: 'TEAM_BIND_FAILED' });
  });

  it('passes TeamLeader caller scope as an expected transfer owner', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const channelStub = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        transferTeamChannelBack: async (input: Record<string, unknown>) => {
          seen.push(input);
          return null;
        },
      }),
    } as unknown as Server;

    const transferred = await adminMethods['team.transfer_back']!(channelStub, {
      dispatcher_id: 'flow',
      caller_kind: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
      meta: { chat_id: 'chat-demo' },
    });

    expect(transferred).toMatchObject({ transferred: false, binding: null });
    expect(seen[0]).toMatchObject({
      expectedOwner: {
        kind: 'team',
        teamName: 'alpha',
        leaderName: 'alpha-leader',
      },
      meta: { chat_id: 'chat-demo' },
    });
  });

  it('rejects a bind_channel call whose meta is missing or not an object', async () => {
    const channelStub = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({ bindTeamChannel: async () => ({}) }),
    } as unknown as Server;
    await expect(
      adminMethods['team.bind_channel']!(channelStub, {
        dispatcher_id: 'flow',
        team_name: 'alpha',
      }),
    ).rejects.toThrow(/meta/);
  });
});

describe('Collaboration Space admin methods', () => {
  it('parses bind identity, container, and repo policy', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        bindCollaborationSpace: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { space: { space_name: input['spaceName'] } };
        },
      }),
    } as unknown as Server;

    await expect(
      adminMethods['collaboration_space.bind']!(server, {
        dispatcher_id: 'flow',
        channel_id: 'primary',
        space_name: 'space-alpha',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-1',
          display: 'Alpha',
        },
        repo: { cwd: '/repo/a', base_ref: 'main' },
        leader_agent_runtime: 'agent-a',
        identity: 'default identity',
      }),
    ).resolves.toMatchObject({ space: { space_name: 'space-alpha' } });
    expect(seen[0]).toMatchObject({
      channelId: 'primary',
      spaceName: 'space-alpha',
      container: {
        container_type: 'topic_group',
        container_key: 'chat-1',
        display: 'Alpha',
      },
      repo: { cwd: '/repo/a', baseRef: 'main' },
      leaderAgentRuntime: 'agent-a',
      identity: 'default identity',
    });
  });

  it('rejects collaboration_space.bind with blank identity', async () => {
    await expectBadRequest('collaboration_space.bind', {
      dispatcher_id: 'flow',
      space_name: 'space-alpha',
      leader_agent_runtime: 'agent-a',
      identity: '   ',
    });
  });

  it('allows collaboration_space.bind without repo', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        bindCollaborationSpace: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { space: { space_name: input['spaceName'] } };
        },
      }),
    } as unknown as Server;

    await expect(
      adminMethods['collaboration_space.bind']!(server, {
        dispatcher_id: 'flow',
        space_name: 'space-alpha',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-1',
        },
        leader_agent_runtime: 'agent-a',
      }),
    ).resolves.toMatchObject({ space: { space_name: 'space-alpha' } });
    expect(seen[0]).toMatchObject({
      spaceName: 'space-alpha',
      leaderAgentRuntime: 'agent-a',
    });
    expect(seen[0]).not.toHaveProperty('repo');
  });
});

describe('Team admin read methods compose channel binding summaries', () => {
  it('team.send forwards to the dispatcher and returns only team, leader, and turn', async () => {
    const sent = {
      team: {
        team_name: 'alpha',
        status: 'running',
        intent: 'lead alpha',
        source_repo: null,
        leader_name: 'alpha-leader',
        leader_agent_runtime: 'agent-a',
        created_at: 1,
        updated_at: 2,
        closed_at: null,
        close_note: null,
      },
      leader: {
        name: 'alpha-leader',
        session_id: 'thread-a',
        agent_runtime: 'agent-a',
        repo: {
          mode: 'reuse-cwd',
          path: '/redacted',
          source_repo: null,
          branch: null,
          base_ref: null,
          cleanup: 'keep',
          cleanup_state: 'not-managed',
        },
        intent: 'lead alpha follow-up',
        status: 'running',
        runtime_status: 'ready',
        last_error: null,
        closed_at: null,
        close_note: null,
      },
      turn: { status: 'submitted', turn_id: 'turn-1' },
    };
    const seen: Array<Record<string, unknown>> = [];
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        sendTeamLeader: async (input: Record<string, unknown>) => {
          seen.push(input);
          return sent;
        },
      }),
    } as unknown as Server;

    const result = await adminMethods['team.send']!(server, {
      dispatcher_id: 'flow',
      caller_kind: 'dispatcher',
      team_name: 'alpha',
      prompt: 'follow up',
      intent: 'lead alpha follow-up',
    });

    expect(seen).toEqual([
      { teamId: 'alpha', prompt: 'follow up', intent: 'lead alpha follow-up' },
    ]);
    expect(Object.keys(result as Record<string, unknown>).sort()).toEqual([
      'leader',
      'team',
      'turn',
    ]);
    expect(result).toEqual(sent);
    expect(result as Record<string, unknown>).not.toHaveProperty('binding');
  });

  it('maps unavailable team.send targets to TEAM_NOT_FOUND', async () => {
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        sendTeamLeader: async () => {
          throw new TeamUnavailableError('Team "ghost" does not exist');
        },
      }),
    } as unknown as Server;

    await expect(
      adminMethods['team.send']!(server, {
        dispatcher_id: 'flow',
        team_name: 'ghost',
        prompt: 'follow up',
      }),
    ).rejects.toMatchObject({
      name: 'AdminError',
      code: 'TEAM_NOT_FOUND',
      message: 'Team "ghost" does not exist',
    });
  });

  it('adds bound_target for Team read summaries in the admin layer', async () => {
    const binding = {
      channel_id: 'primary',
      provider: 'builtin:feishu',
      target_type: 'group',
      target_key: 'chat-alpha',
      display: 'Alpha',
      canonical_url: null,
    };
    const owners: Array<Record<string, unknown>> = [];
    const dispatcher = {
      listTeams: async () => [
        {
          team_name: 'alpha',
          status: 'running',
          intent: 'lead alpha',
          source_repo: null,
          leader_name: 'alpha-leader',
          leader_state: 'running',
          member_count: 2,
          created_at: 1,
          updated_at: 2,
          closed_at: null,
        },
      ],
      getTeamStatus: async () => ({
        team: {
          team_name: 'alpha',
          status: 'running',
          intent: 'lead alpha',
          source_repo: null,
          leader_name: 'alpha-leader',
          leader_agent_runtime: 'agent-a',
          created_at: 1,
          updated_at: 2,
          closed_at: null,
          close_note: null,
        },
        leader: null,
        member_count: 2,
      }),
      getTeamHistory: async () => ({
        items: [
          {
            team_name: 'alpha',
            status: 'running',
            intent: 'lead alpha',
            source_repo: null,
            leader_name: 'alpha-leader',
            leader_agent_runtime: 'agent-a',
            leader_state: 'running',
            member_count: 2,
            created_at: 1,
            updated_at: 2,
            closed_at: null,
            close_note: null,
            close_note_preview: null,
          },
        ],
        next_cursor: null,
      }),
      activeTeamBindingSummary: async (owner: Record<string, unknown>) => {
        owners.push(owner);
        return binding;
      },
    };
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => dispatcher,
    } as unknown as Server;

    await expect(
      adminMethods['team.list']!(server, { dispatcher_id: 'flow' }),
    ).resolves.toMatchObject({
      teams: [{ team_name: 'alpha', bound_target: binding }],
    });
    await expect(
      adminMethods['team.status']!(server, {
        dispatcher_id: 'flow',
        team_name: 'alpha',
      }),
    ).resolves.toMatchObject({
      team: { team_name: 'alpha' },
      bound_target: binding,
    });
    await expect(
      adminMethods['team.history']!(server, { dispatcher_id: 'flow' }),
    ).resolves.toMatchObject({
      items: [{ team_name: 'alpha', bound_target: binding }],
      next_cursor: null,
    });
    expect(owners).toEqual([
      { kind: 'team', teamName: 'alpha', leaderName: 'alpha-leader' },
      { kind: 'team', teamName: 'alpha', leaderName: 'alpha-leader' },
      { kind: 'team', teamName: 'alpha', leaderName: 'alpha-leader' },
    ]);
  });
});
