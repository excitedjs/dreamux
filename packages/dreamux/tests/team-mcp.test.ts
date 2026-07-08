import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import { TASK_DISPATCH_SUCCESS_REMINDER } from '../src/mcp/task-dispatch-reminder.js';
import { runTeamMcp } from '../src/mcp/team-mcp.js';

class JsonLineReader {
  private buffer = '';
  private waiters: Array<(value: unknown) => void> = [];

  constructor(stream: PassThrough) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  next(): Promise<unknown> {
    const line = this.shiftLine();
    if (line !== null) return Promise.resolve(JSON.parse(line));
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const line = this.shiftLine();
      if (line === null) return;
      this.waiters.shift()!(JSON.parse(line));
    }
  }

  private shiftLine(): string | null {
    const idx = this.buffer.indexOf('\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    return line;
  }
}

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

function writeJson(input: PassThrough, value: unknown): void {
  input.write(`${JSON.stringify(value)}\n`);
}

async function toolSchemas(): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    adminSocketPath: '/tmp/not-used.sock',
    input,
    output,
    log: () => {},
  });
  writeJson(input, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

async function teamLeaderToolSchemas(): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    callerKind: 'team_leader',
    teamId: 'alpha',
    leaderName: 'alpha-leader',
    adminSocketPath: '/tmp/not-used.sock',
    input,
    output,
    log: () => {},
  });
  writeJson(input, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

function schemaOf(
  tools: Array<Record<string, unknown>>,
  name: string,
): { required: string[]; properties: Record<string, unknown> } {
  const entry = tools.find((t) => t['name'] === name) as {
    inputSchema: { required: string[]; properties: Record<string, unknown> };
  };
  return entry.inputSchema;
}

describe('team-mcp stdio shim', () => {
  it('marks create.intent and dissolve.note required; create_group + create-time bind_group are gone', async () => {
    const tools = await toolSchemas();
    expect(schemaOf(tools, 'create').required).toContain('intent');
    expect(schemaOf(tools, 'create').properties).toHaveProperty('identity');
    expect(schemaOf(tools, 'create').required).not.toContain('identity');
    // #182 PR-8: create_group is retired from the public Team MCP surface.
    expect(tools.map((t) => t['name'])).not.toContain('create_group');
    // The create-time `bind_group` convenience is removed; bind a channel after
    // create with the dedicated Team `bind_channel` tool.
    expect(schemaOf(tools, 'create').properties).not.toHaveProperty('bind_group');
    // #199 Slice 1: public addressing is by the concrete `team_name`.
    expect(schemaOf(tools, 'create').required).toContain('team_name');
    expect(schemaOf(tools, 'create').properties).not.toHaveProperty('name');
    expect(schemaOf(tools, 'dissolve').required).toEqual(['team_name', 'note']);
  });

  it('owns channel bind_channel / transfer_back with the generalized channel_id + meta model (#209)', async () => {
    const tools = await toolSchemas();
    const names = tools.map((t) => t['name']);
    // Binding a channel to a Team/TeamLeader is a core-owned Team capability, so
    // the binding verbs live on Team MCP — not a separate generic channel MCP.
    // The retired Feishu-shaped aliases stay gone.
    expect(names).not.toContain('bind_group');
    expect(names).not.toContain('transfer_channel_back');
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
    // bind_channel: team_name + provider selector `meta` required; channel_id
    // optional; no chat_id/chat_type on the core surface.
    expect(schemaOf(tools, 'bind_channel').required).toEqual(['team_name', 'meta']);
    expect(schemaOf(tools, 'bind_channel').properties).toHaveProperty('channel_id');
    expect(schemaOf(tools, 'bind_channel').properties).toHaveProperty('meta');
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('chat_id');
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('chat_type');
    // send: dispatcher-only TeamLeader turn submission; no channel selectors.
    expect(schemaOf(tools, 'send').required).toEqual(['team_name', 'prompt']);
    expect(schemaOf(tools, 'send').properties).toHaveProperty('team_name');
    expect(schemaOf(tools, 'send').properties).toHaveProperty('prompt');
    expect(schemaOf(tools, 'send').properties).toHaveProperty('intent');
    expect(schemaOf(tools, 'send').properties).not.toHaveProperty('channel_id');
    expect(schemaOf(tools, 'send').properties).not.toHaveProperty('meta');
    // transfer_back: meta required; channel_id optional.
    expect(schemaOf(tools, 'transfer_back').required).toEqual(['meta']);
    expect(schemaOf(tools, 'transfer_back').properties).toHaveProperty('channel_id');
    expect(schemaOf(tools, 'transfer_back').properties).not.toHaveProperty('chat_id');
  });

  it('aligns the Team read surface with the TeamMate model and addresses by team_name (#199 Slice 1)', async () => {
    const tools = await toolSchemas();
    const names = tools.map((t) => t['name']);
    // ledger verb retired in favour of a filterable history recovery surface.
    expect(names).toContain('history');
    expect(names).not.toContain('ledger');
    // status / history / dissolve address by team_name, not team_id/name.
    expect(schemaOf(tools, 'status').required).toEqual(['team_name']);
    // history is filterable and fully optional.
    expect(schemaOf(tools, 'history').required).toEqual([]);
    expect(schemaOf(tools, 'history').properties).toHaveProperty('grep');
    expect(schemaOf(tools, 'history').properties).toHaveProperty('team_name');
    // #199 Slice 1: the lifecycle `status` filter stays; the legacy
    // `close_status` filter and the legacy `name` key are removed.
    expect(schemaOf(tools, 'history').properties).toHaveProperty('status');
    expect(schemaOf(tools, 'history').properties).not.toHaveProperty('close_status');
    expect(schemaOf(tools, 'history').properties).not.toHaveProperty('name');
  });

  it('forwards create identity to admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        team: { team_name: 'alpha' },
        leader: null,
        member_count: 0,
        turn: { status: 'submitted', turn_id: 'turn-1' },
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create',
          arguments: {
            team_name: 'alpha',
            leader_agent_runtime: 'codex',
            intent: 'lead alpha',
            identity: 'architecture lead',
            prompt: 'start',
          },
        },
      });

      const response = await reader.next();
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{
            text: expect.stringContaining(TASK_DISPATCH_SUCCESS_REMINDER) as string,
          }],
          structuredContent: {
            team: { team_name: 'alpha' },
          },
        },
      });
      expect(admin.requests).toHaveLength(1);
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.team.create',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'dispatcher',
          team_name: 'alpha',
          leader_agent_runtime: 'codex',
          intent: 'lead alpha',
          identity: 'architecture lead',
          prompt: 'start',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards redesigned read verbs and preserves bound_target results (#182 PR-7)', async () => {
    const boundTarget = {
      channel_id: 'primary',
      provider: 'builtin:test',
      target_type: 'group',
      target_key: 'target-alpha',
      display: 'Alpha',
      canonical_url: null,
    };
    const admin = await startFakeAdminServer((request) => {
      const results: Record<string, unknown> = {
        'mcp.team.list': {
          teams: [{ team_name: 'alpha', bound_target: boundTarget }],
        },
        'mcp.team.status': {
          team: { team_name: 'alpha' },
          bound_target: boundTarget,
        },
        'mcp.team.history': {
          items: [{ team_name: 'alpha', bound_target: boundTarget }],
          next_cursor: null,
        },
        'mcp.team.send': {
          team: { team_name: 'alpha' },
          leader: { name: 'alpha-leader', status: 'running' },
          turn: { status: 'submitted', turn_id: 'turn-2' },
        },
      };
      return {
        id: request.id,
        ok: true,
        result: results[request.method] ?? { ok: true },
      };
    });
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list', arguments: {} },
      });
      const listResponse = await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'status', arguments: { team_name: 'alpha' } },
      });
      const statusResponse = await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'history',
          arguments: { grep: 'auth', team_name: 'alpha', status: 'running', limit: 5 },
        },
      });
      const historyResponse = await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'send',
          arguments: {
            team_name: 'alpha',
            prompt: 'follow up',
            intent: 'lead alpha follow-up',
          },
        },
      });
      const sendResponse = await reader.next();

      expect(admin.requests.map((r) => r.method)).toEqual([
        'mcp.team.list',
        'mcp.team.status',
        'mcp.team.history',
        'mcp.team.send',
      ]);
      expect(listResponse).toMatchObject({
        result: {
          structuredContent: {
            teams: [{ team_name: 'alpha', bound_target: boundTarget }],
          },
        },
      });
      expect(statusResponse).toMatchObject({
        result: {
          structuredContent: {
            team: { team_name: 'alpha' },
            bound_target: boundTarget,
          },
        },
      });
      expect(historyResponse).toMatchObject({
        result: {
          structuredContent: {
            items: [{ team_name: 'alpha', bound_target: boundTarget }],
            next_cursor: null,
          },
        },
      });
      expect(sendResponse).toMatchObject({
        result: {
          content: [{
            text: expect.stringContaining(TASK_DISPATCH_SUCCESS_REMINDER) as string,
          }],
        },
      });
      expect(admin.requests[1]?.params).toMatchObject({ team_name: 'alpha' });
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
      // #199 Slice 1: the legacy `close_status` filter is not part of the surface.
      expect(admin.requests[1]?.params).not.toHaveProperty('close_status');

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('omits the reminder when a Team prompt turn is not submitted', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        team: { team_name: 'alpha' },
        leader: { name: 'alpha-leader', status: 'degraded' },
        turn: { status: 'failed', error: 'runtime unavailable' },
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send',
          arguments: { team_name: 'alpha', prompt: 'Continue.' },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ text: 'send forwarded to dreamux serve' }],
          structuredContent: {
            turn: { status: 'failed', error: 'runtime unavailable' },
          },
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects create without intent and dissolve without note before admin IPC (#182 PR-3)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      // create without intent → rejected before admin IPC.
      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create',
          arguments: { team_name: 'alpha', repo_cwd: '/repo', leader_agent_runtime: 'codex' },
        },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ text: 'intent must be a non-empty string' }],
        },
      });

      // dissolve without note → rejected before admin IPC.
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'dissolve', arguments: { team_name: 'alpha' } },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          isError: true,
          content: [{ text: 'note must be a non-empty string' }],
        },
      });

      expect(admin.requests).toEqual([]);
      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('projects Team MCP to TeamLeader transfer_back only and forwards caller scope', async () => {
    const tools = await teamLeaderToolSchemas();
    expect(tools.map((tool) => tool['name'])).toEqual(['transfer_back']);
    expect(schemaOf(tools, 'transfer_back').required).toEqual(['meta']);

    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { transferred: true },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'team_leader',
        teamId: 'alpha',
        leaderName: 'alpha-leader',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'transfer_back',
          arguments: { meta: { chat_id: 'chat-demo' } },
        },
      });
      await reader.next();

      expect(admin.requests[0]?.method).toBe('mcp.team.transfer_back');
      expect(admin.requests[0]?.params).toMatchObject({
        caller_kind: 'team_leader',
        team_id: 'alpha',
        leader_name: 'alpha-leader',
        meta: { chat_id: 'chat-demo' },
      });

      const hiddenTools = [
        'create',
        'send',
        'list',
        'status',
        'history',
        'dissolve',
        'bind_channel',
      ];
      for (const [idx, name] of hiddenTools.entries()) {
        writeJson(input, {
          jsonrpc: '2.0',
          id: idx + 2,
          method: 'tools/call',
          params: { name, arguments: {} },
        });
        expect(await reader.next()).toMatchObject({
          result: { isError: true },
        });
      }
      expect(admin.requests.map((request) => request.method)).toEqual([
        'mcp.team.transfer_back',
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
