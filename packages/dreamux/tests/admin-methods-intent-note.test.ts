import { describe, expect, it } from 'vitest';

import { adminMethods } from '../src/admin/methods.js';
import { AdminError } from '../src/admin/protocol.js';
import { TeamUnavailableError } from '../src/service/team-collection/index.js';
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
    await expectBadRequest('mcp.teammate.spawn', base);
    await expectBadRequest('mcp.teammate.spawn', { ...base, intent: '' });
  });

  it('rejects teammate.spawn with blank identity', async () => {
    await expectBadRequest('mcp.teammate.spawn', {
      dispatcher_id: 'flow',
      name_prefix: 'a',
      prompt: 'go',
      intent: 'work',
      identity: '   ',
    });
  });

  it('rejects teammate.close with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', name: 'a' };
    await expectBadRequest('mcp.teammate.close', base);
    await expectBadRequest('mcp.teammate.close', { ...base, note: '' });
  });

  it('rejects team.create with missing or empty intent', async () => {
    const base = {
      dispatcher_id: 'flow',
      team_name: 'alpha',
      leader_agent_runtime: 'codex',
    };
    await expectBadRequest('mcp.team.create', base);
    await expectBadRequest('mcp.team.create', { ...base, intent: '' });
  });

  it('rejects team.create with blank identity', async () => {
    await expectBadRequest('mcp.team.create', {
      dispatcher_id: 'flow',
      team_name: 'alpha',
      leader_agent_runtime: 'codex',
      intent: 'work',
      identity: '   ',
    });
  });

  it('rejects team.dissolve with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('mcp.team.dissolve', base);
    await expectBadRequest('mcp.team.dissolve', { ...base, note: '' });
  });

  it('rejects team.send for TeamLeader callers and requires a non-empty prompt', async () => {
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('mcp.team.send', base);
    await expectBadRequest('mcp.team.send', { ...base, prompt: '' });
    await expectBadRequest('mcp.team.send', {
      ...base,
      caller_kind: 'team_leader',
      team_id: 'alpha',
      leader_name: 'alpha-leader',
      prompt: 'follow up',
    });
  });
});

describe('Channel MCP admin methods replace the Team binding methods (#209 slice 8)', () => {
  it('removes the old Feishu binding methods without aliases', () => {
    expect(adminMethods['mcp.team.bind_group']).toBeUndefined();
    expect(adminMethods['mcp.team.transfer_channel_back']).toBeUndefined();
  });

  it('registers the Team MCP channel-binding methods (and no generic channel.* aliases)', () => {
    expect(typeof adminMethods['mcp.team.bind_channel']).toBe('function');
    expect(typeof adminMethods['mcp.team.transfer_back']).toBe('function');
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

    const bound = await adminMethods['mcp.team.bind_channel']!(channelStub, {
      dispatcher_id: 'flow',
      team_name: 'alpha',
      meta: { chat_id: 'chat-demo' },
    });
    const transferred = await adminMethods['mcp.team.transfer_back']!(channelStub, {
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

    const transferred = await adminMethods['mcp.team.transfer_back']!(channelStub, {
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
      adminMethods['mcp.team.bind_channel']!(channelStub, {
        dispatcher_id: 'flow',
        team_name: 'alpha',
      }),
    ).rejects.toThrow(/meta/);
  });
});

describe('Team MCP admin read methods compose channel binding summaries', () => {
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

    const result = await adminMethods['mcp.team.send']!(server, {
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
      adminMethods['mcp.team.send']!(server, {
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
      adminMethods['mcp.team.list']!(server, { dispatcher_id: 'flow' }),
    ).resolves.toMatchObject({
      teams: [{ team_name: 'alpha', bound_target: binding }],
    });
    await expect(
      adminMethods['mcp.team.status']!(server, {
        dispatcher_id: 'flow',
        team_name: 'alpha',
      }),
    ).resolves.toMatchObject({
      team: { team_name: 'alpha' },
      bound_target: binding,
    });
    await expect(
      adminMethods['mcp.team.history']!(server, { dispatcher_id: 'flow' }),
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
