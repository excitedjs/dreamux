import { describe, expect, it } from 'vitest';

import { adminMethods } from '../src/admin/methods.js';
import { AdminError } from '../src/admin/protocol.js';
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

  it('rejects team.dissolve with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('mcp.team.dissolve', base);
    await expectBadRequest('mcp.team.dissolve', { ...base, note: '' });
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

  it('bind_channel and transfer_back share one return envelope (the binding, not wrapped) and pass meta through', async () => {
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
    expect(transferred).toEqual(binding);
    expect(transferred).not.toHaveProperty('binding');
    expect(seen[0]).toMatchObject({ teamId: 'alpha', meta: { chat_id: 'chat-demo' } });
    expect(seen[1]).toMatchObject({ meta: { chat_id: 'chat-demo' } });
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
