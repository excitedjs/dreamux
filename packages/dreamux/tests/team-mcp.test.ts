import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import { SANITIZED_TOOL_ERROR } from '../src/mcp/server.js';
import {
  runTeamMcp,
  type TeamMcpCallerKind,
} from '../src/mcp/team-mcp.js';
import {
  callTool,
  connectMcpClient,
  listedTools,
  type ConnectedMcpClient,
} from './helpers/mcp-client.js';

interface FakeAdminServer {
  socketPath: string;
  requests: AdminRequest[];
  close(): Promise<void>;
}

async function startFakeAdminServer(
  respond: (request: AdminRequest) => AdminResponse,
): Promise<FakeAdminServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-team-mcp-admin-'));
  const socketPath = join(dir, 'admin.sock');
  const requests: AdminRequest[] = [];
  const server: NetServer = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === '') continue;
        const request = JSON.parse(line) as AdminRequest;
        requests.push(request);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function openTeamMcp(
  callerKind: TeamMcpCallerKind = 'dispatcher',
  adminSocketPath = '/tmp/not-used.sock',
): Promise<ConnectedMcpClient> {
  return connectMcpClient((transport) =>
    runTeamMcp({
      dispatcherId: 'dispatcher-a',
      callerKind,
      ...(callerKind === 'team_leader'
        ? { teamId: 'alpha', leaderName: 'alpha-leader' }
        : {}),
      adminSocketPath,
      transport,
      log: () => {},
    }),
  );
}

async function toolSchemas(callerKind: TeamMcpCallerKind = 'dispatcher'): Promise<Tool[]> {
  const mcp = await openTeamMcp(callerKind);
  try {
    return await listedTools(mcp.client);
  } finally {
    await mcp.close();
  }
}

function schemaOf(tools: Tool[], name: string): {
  required: string[];
  properties: Record<string, Record<string, unknown>>;
} {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`tool '${name}' not found`);
  return tool.inputSchema as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
}

function expectCanonicalResult(
  result: CallToolResult,
  value: Record<string, unknown>,
): void {
  expect(result.structuredContent).toEqual(value);
  expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(value) });
  expect(JSON.stringify(result)).not.toMatch(/do not poll|system push|reminder/i);
}

describe('team MCP', () => {
  it('marks create.intent and dissolve.note required; create_group + create-time bind_group are gone', async () => {
    const tools = await toolSchemas();
    const create = schemaOf(tools, 'create');
    expect(create.required).toEqual([
      'name_prefix',
      'leader_agent_runtime',
      'intent',
    ]);
    expect(create.properties).toHaveProperty('identity');
    expect(create.properties).not.toHaveProperty('team_name');
    expect(create.properties).not.toHaveProperty('name');
    expect(create.properties).not.toHaveProperty('bind_group');
    expect(create.properties).not.toHaveProperty('skill_sources');
    expect(tools.map((tool) => tool.name)).not.toContain('create_group');
    expect(schemaOf(tools, 'dissolve').required).toEqual(['team_name', 'note']);
  });

  it('owns bind_channel / transfer_back with the generalized channel_id + meta model (#209)', async () => {
    const tools = await toolSchemas();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      'create',
      'send',
      'list',
      'status',
      'history',
      'dissolve',
      'bind_channel',
      'transfer_back',
    ]);
    expect(names).not.toEqual(expect.arrayContaining(['bind_group', 'transfer_channel_back']));
    expect(schemaOf(tools, 'bind_channel')).toMatchObject({
      required: ['team_name', 'meta'],
      properties: {
        channel_id: expect.any(Object),
        meta: expect.any(Object),
      },
    });
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('chat_id');
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('chat_type');
    expect(schemaOf(tools, 'send')).toMatchObject({
      required: ['team_name', 'prompt'],
      properties: {
        team_name: expect.any(Object),
        prompt: expect.any(Object),
        intent: expect.any(Object),
      },
    });
  });

  it('aligns the Team read surface with the TeamMate model and addresses by team_name (#199 Slice 1)', async () => {
    const tools = await toolSchemas();
    expect(schemaOf(tools, 'status').required).toEqual(['team_name']);
    expect(schemaOf(tools, 'status').properties).not.toHaveProperty('name');
    expect(schemaOf(tools, 'history').required).toEqual([]);
    for (const key of ['team_name', 'status', 'repo', 'grep', 'since', 'until', 'limit', 'cursor']) {
      expect(schemaOf(tools, 'history').properties).toHaveProperty(key);
    }
    for (const key of ['close_status', 'team_id', 'leader_session_id', 'bound_chat_id']) {
      expect(schemaOf(tools, 'history').properties).not.toHaveProperty(key);
    }
  });

  it('forwards create identity to admin IPC and returns a pure canonical receipt', async () => {
    const adminResult = {
      team: { team_name: 'alpha' },
      leader: { name: 'alpha-leader', status: 'running' },
      member_count: 0,
      turn: { status: 'submitted', turn_id: 'turn-1' },
      bound_target: null,
      bound_targets: [],
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: adminResult,
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      const args = {
        name_prefix: 'alpha',
        leader_agent_runtime: 'codex',
        intent: 'lead alpha',
        identity: 'architecture lead',
        prompt: 'start',
      };
      expectCanonicalResult(await callTool(mcp.client, 'create', args), adminResult);
      expect(admin.requests[0]).toMatchObject({
        method: 'team.create',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'dispatcher',
          ...args,
        },
      });
      await expect(
        callTool(mcp.client, 'create', {
          ...args,
          skill_sources: [{ path: '/skills/untrusted-leader' }],
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(admin.requests).toHaveLength(1);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('returns an idle create result with turn null and no model guidance', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        team: { team_name: 'alpha' },
        leader: { name: 'alpha-leader', status: 'running' },
        member_count: 0,
        turn: null,
      },
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      expectCanonicalResult(
        await callTool(mcp.client, 'create', {
          name_prefix: 'alpha',
          leader_agent_runtime: 'codex',
          intent: 'lead alpha',
        }),
        {
          team: { team_name: 'alpha' },
          leader: { name: 'alpha-leader', status: 'running' },
          member_count: 0,
          turn: null,
          bound_target: null,
          bound_targets: [],
        },
      );
      expect(admin.requests[0]?.params).not.toHaveProperty('prompt');
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('forwards all bound targets and preserves the compatible first target', async () => {
    const boundTargets = [
      {
        channel_id: 'flowx',
        provider: 'npm:@example/flowx-channel',
        target_type: 'task',
        target_key: 'task-alpha',
        display: 'Alpha task',
        canonical_url: null,
      },
      {
        channel_id: 'feishu',
        provider: 'builtin:test',
        target_type: 'group',
        target_key: 'target-alpha',
        display: 'Alpha group',
        canonical_url: null,
      },
    ];
    const boundTarget = boundTargets[0];
    const results: Record<string, unknown> = {
      'team.list': {
        teams: [{ team_name: 'alpha', bound_target: boundTarget, bound_targets: boundTargets }],
      },
      'team.status': {
        team: { team_name: 'alpha' },
        leader: { name: 'alpha-leader', status: 'running' },
        member_count: 2,
        bound_target: boundTarget,
        bound_targets: boundTargets,
      },
      'team.history': {
        items: [{ team_name: 'alpha', bound_target: boundTarget, bound_targets: boundTargets }],
        next_cursor: null,
      },
      'team.send': {
        team: { team_name: 'alpha' },
        leader: { name: 'alpha-leader', status: 'running' },
        turn: { status: 'submitted', turn_id: 'turn-2' },
      },
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: results[request.method] ?? {},
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      const list = await callTool(mcp.client, 'list', {});
      const status = await callTool(mcp.client, 'status', { team_name: 'alpha' });
      const history = await callTool(mcp.client, 'history', {
        grep: 'auth',
        team_name: 'alpha',
        status: 'running',
        limit: 5,
      });
      const send = await callTool(mcp.client, 'send', {
        team_name: 'alpha',
        prompt: 'follow up',
        intent: 'lead alpha follow-up',
      });
      expectCanonicalResult(list, results['team.list'] as Record<string, unknown>);
      expectCanonicalResult(status, results['team.status'] as Record<string, unknown>);
      expectCanonicalResult(history, results['team.history'] as Record<string, unknown>);
      expectCanonicalResult(send, results['team.send'] as Record<string, unknown>);
      expect(admin.requests.map((request) => request.method)).toEqual([
        'team.list',
        'team.status',
        'team.history',
        'team.send',
      ]);
      expect(admin.requests[2]?.params).toMatchObject({
        grep: 'auth',
        team_name: 'alpha',
        status: 'running',
        limit: 5,
      });
      expect(admin.requests[3]?.params).toMatchObject({
        caller_kind: 'dispatcher',
        team_name: 'alpha',
        prompt: 'follow up',
        intent: 'lead alpha follow-up',
      });
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('returns a failed Team turn without model guidance', async () => {
    const value = {
      team: { team_name: 'alpha' },
      leader: { name: 'alpha-leader', status: 'degraded' },
      turn: { status: 'failed', error: 'runtime unavailable' },
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: value,
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      expectCanonicalResult(
        await callTool(mcp.client, 'send', {
          team_name: 'alpha',
          prompt: 'Continue.',
        }),
        value,
      );
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('rejects create without intent and dissolve without note before admin IPC (#182 PR-3)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      for (const [name, args] of [
        ['create', { name_prefix: 'alpha', leader_agent_runtime: 'codex' }],
        ['dissolve', { team_name: 'alpha' }],
      ] as const) {
        const result = await callTool(mcp.client, name, args);
        expect(result).toMatchObject({ isError: true });
        expect(result).not.toHaveProperty('structuredContent');
      }
      expect(admin.requests).toEqual([]);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('allows public admin errors only for their exact method and code pair', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: 'TEAM_DISSOLVE_BLOCKED',
        message: 'finish the active handoff before dissolving',
      },
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      await expect(
        callTool(mcp.client, 'send', {
          team_name: 'alpha',
          prompt: 'Continue.',
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: SANITIZED_TOOL_ERROR }],
      });
      await expect(
        callTool(mcp.client, 'dissolve', {
          team_name: 'alpha',
          note: 'Done.',
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'finish the active handoff before dissolving',
          },
        ],
      });
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('returns the accepted dissolve receipt without a turn reminder', async () => {
    const value = {
      accepted: true,
      team_name: 'alpha',
      status: 'closing',
      bound_target: null,
      bound_targets: [],
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: value,
    }));
    const mcp = await openTeamMcp('dispatcher', admin.socketPath);
    try {
      expectCanonicalResult(
        await callTool(mcp.client, 'dissolve', {
          team_name: 'alpha',
          note: 'done',
        }),
        value,
      );
      expect(admin.requests[0]?.method).toBe('team.dissolve');
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('projects scoped dissolve, bind_channel, and transfer_back to TeamLeader', async () => {
    const tools = await toolSchemas('team_leader');
    expect(tools.map((tool) => tool.name)).toEqual([
      'dissolve',
      'bind_channel',
      'transfer_back',
    ]);
    expect(schemaOf(tools, 'dissolve')).toMatchObject({
      required: ['note'],
      properties: { note: { type: 'string', minLength: 1, pattern: '\\S' } },
    });
    expect(Object.keys(schemaOf(tools, 'dissolve').properties)).toEqual(['note']);
    expect(schemaOf(tools, 'bind_channel').required).toEqual(['meta']);
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('team_name');
    expect(schemaOf(tools, 'transfer_back').required).toEqual(['meta']);

    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'team.dissolve'
          ? {
              accepted: true,
              team_name: 'alpha',
              status: 'closing',
              bound_target: null,
              bound_targets: [],
            }
          : request.method === 'team.transfer_back'
            ? { transferred: true, binding: null, message: 'transferred' }
            : { bound: true },
    }));
    const mcp = await openTeamMcp('team_leader', admin.socketPath);
    try {
      await callTool(mcp.client, 'dissolve', { note: 'team work is complete' });
      await callTool(mcp.client, 'bind_channel', { meta: { target: 'target-demo' } });
      await callTool(mcp.client, 'transfer_back', { meta: { target: 'target-demo' } });
      expect(admin.requests.map((request) => request.method)).toEqual([
        'team.dissolve',
        'team.bind_channel',
        'team.transfer_back',
      ]);
      for (const request of admin.requests) {
        expect(request.params).toMatchObject({
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'team_leader',
          team_id: 'alpha',
          leader_name: 'alpha-leader',
        });
        expect(request.params).not.toHaveProperty('team_name');
      }
      await expect(
        callTool(mcp.client, 'bind_channel', {
          team_name: 'beta',
          meta: { target: 'target-demo' },
        }),
      ).resolves.toMatchObject({ isError: true });
      for (const name of ['create', 'send', 'list', 'status', 'history']) {
        await expect(callTool(mcp.client, name, {})).rejects.toThrow();
      }
      expect(admin.requests).toHaveLength(3);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('uses the normal 10s admin timeout for every Team tools/call path', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'team.status'
          ? { team: { team_name: 'alpha' } }
          : {
              accepted: true,
              team_name: 'alpha',
              status: 'closing',
              bound_target: null,
              bound_targets: [],
            },
    }));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      for (const input of [
        {
          callerKind: 'dispatcher' as const,
          name: 'dissolve',
          args: { team_name: 'alpha', note: 'done' },
        },
        {
          callerKind: 'team_leader' as const,
          name: 'dissolve',
          args: { note: 'done' },
        },
        {
          callerKind: 'dispatcher' as const,
          name: 'status',
          args: { team_name: 'alpha' },
        },
      ]) {
        const mcp = await openTeamMcp(input.callerKind, admin.socketPath);
        timeoutSpy.mockClear();
        await callTool(mcp.client, input.name, input.args);
        const delays = timeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays.filter((delay) => delay === 10_000)).toHaveLength(1);
        await mcp.close();
      }
      expect(admin.requests.map((request) => request.method)).toEqual([
        'team.dissolve',
        'team.dissolve',
        'team.status',
      ]);
    } finally {
      timeoutSpy.mockRestore();
      await admin.close();
    }
  });
});
