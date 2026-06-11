import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
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
  it('marks create.intent and dissolve.note required; create_group is retired (#182 PR-3/PR-8)', async () => {
    const tools = await toolSchemas();
    expect(schemaOf(tools, 'create').required).toContain('intent');
    // #182 PR-8: create_group is retired from the public Team MCP surface; an
    // existing group is bound via the optional `bind_group` on `create` instead.
    expect(tools.map((t) => t['name'])).not.toContain('create_group');
    expect(schemaOf(tools, 'create').properties).toHaveProperty('bind_group');
    // #199 Slice 1: public addressing is by the concrete `team_name`.
    expect(schemaOf(tools, 'create').required).toContain('team_name');
    expect(schemaOf(tools, 'create').properties).not.toHaveProperty('name');
    expect(schemaOf(tools, 'dissolve').required).toEqual(['team_name', 'note']);
  });

  it('forwards create.bind_group to the admin create method (#182 PR-8)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true },
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
            // #199 Slice 2: the public work-dir input is the optional `repo`
            // object (replacing the old required `repo_cwd`).
            repo: { mode: 'reuse-cwd', path: '/repo' },
            leader_agent_runtime: 'codex',
            intent: 'ship it',
            bind_group: { chat_id: 'chat-1' },
          },
        },
      });
      await reader.next();
      expect(admin.requests[0]?.method).toBe('mcp.team.create');
      expect(admin.requests[0]?.params).toMatchObject({
        team_name: 'alpha',
        repo: { mode: 'reuse-cwd', path: '/repo' },
        bind_group: { chat_id: 'chat-1' },
      });
      expect(admin.requests[0]?.params).not.toHaveProperty('repo_cwd');
      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('aligns the Team read surface with the TeamMate model and addresses by team_name (#199 Slice 1)', async () => {
    const tools = await toolSchemas();
    const names = tools.map((t) => t['name']);
    // ledger verb retired in favour of a filterable history recovery surface;
    // bind_channel simplified to group-only bind_group.
    expect(names).toContain('history');
    expect(names).toContain('bind_group');
    expect(names).not.toContain('ledger');
    expect(names).not.toContain('bind_channel');
    // status / history / dissolve / bind_group address by team_name, not team_id/name.
    expect(schemaOf(tools, 'status').required).toEqual(['team_name']);
    expect(schemaOf(tools, 'bind_group').required).toEqual(['team_name', 'chat_id']);
    // history is filterable and fully optional; chat_type is gone from binding.
    expect(schemaOf(tools, 'history').required).toEqual([]);
    expect(schemaOf(tools, 'history').properties).toHaveProperty('grep');
    expect(schemaOf(tools, 'history').properties).toHaveProperty('team_name');
    // #199 Slice 1: the lifecycle `status` filter stays; the legacy
    // `close_status` filter and the legacy `name` key are removed.
    expect(schemaOf(tools, 'history').properties).toHaveProperty('status');
    expect(schemaOf(tools, 'history').properties).not.toHaveProperty('close_status');
    expect(schemaOf(tools, 'history').properties).not.toHaveProperty('name');
    expect(schemaOf(tools, 'bind_group').properties).not.toHaveProperty('chat_type');
    expect(schemaOf(tools, 'transfer_channel_back').properties).not.toHaveProperty(
      'chat_type',
    );
  });

  it('forwards the redesigned read/bind verbs to the right admin methods (#182 PR-7)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true },
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
        params: { name: 'status', arguments: { team_name: 'alpha' } },
      });
      await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'history',
          arguments: { grep: 'auth', team_name: 'alpha', status: 'running', limit: 5 },
        },
      });
      await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'bind_group', arguments: { team_name: 'alpha', chat_id: 'chat-1' } },
      });
      await reader.next();

      expect(admin.requests.map((r) => r.method)).toEqual([
        'mcp.team.status',
        'mcp.team.history',
        'mcp.team.bind_group',
      ]);
      expect(admin.requests[0]?.params).toMatchObject({ team_name: 'alpha' });
      expect(admin.requests[1]?.params).toMatchObject({
        grep: 'auth',
        team_name: 'alpha',
        status: 'running',
        limit: 5,
      });
      // #199 Slice 1: the legacy `close_status` filter is not part of the surface.
      expect(admin.requests[1]?.params).not.toHaveProperty('close_status');
      expect(admin.requests[2]?.params).toMatchObject({
        team_name: 'alpha',
        chat_id: 'chat-1',
      });
      // No chat_type leaks through the simplified binding surface.
      expect(admin.requests[2]?.params).not.toHaveProperty('chat_type');

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
});
