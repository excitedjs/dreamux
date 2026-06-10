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
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
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

async function listToolSchemas(): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    adminSocketPath: 'unused-admin.sock',
    input,
    output,
    log: () => {},
  });
  writeJson(input, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

async function callTool(
  admin: FakeAdminServer,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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
    params: { name, arguments: args },
  });
  const response = await reader.next();
  input.end();
  await run;
  return response;
}

function schemaProperties(tool: Record<string, unknown>): Record<string, unknown> {
  const schema = tool['inputSchema'] as Record<string, unknown>;
  return schema['properties'] as Record<string, unknown>;
}

describe('team-mcp stdio shim', () => {
  it('exposes the worktree parameter on create and create_group schemas', async () => {
    const tools = await listToolSchemas();
    const byName = new Map(tools.map((tool) => [tool['name'] as string, tool]));
    for (const name of ['create', 'create_group']) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      const worktree = schemaProperties(tool!)['worktree'] as Record<string, unknown>;
      expect(worktree).toMatchObject({ type: 'object', required: ['mode'] });
      const properties = worktree['properties'] as Record<string, unknown>;
      expect(properties['mode']).toMatchObject({ enum: ['reuse-cwd', 'managed'] });
      expect(Object.keys(properties).sort()).toEqual([
        'base_ref',
        'branch',
        'cleanup',
        'mode',
        'slug',
      ]);
    }
  });

  it('forwards worktree from create to mcp.team.create', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { team: { team_id: 'alpha' } },
    }));
    try {
      const response = await callTool(admin, 'create', {
        name: 'alpha',
        repo_cwd: '/workspace/repo',
        leader_agent_runtime: 'flow',
        worktree: { mode: 'reuse-cwd' },
      });
      expect(response).toMatchObject({ id: 1, result: {} });
      expect(admin.requests).toHaveLength(1);
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.team.create',
        params: {
          dispatcher_id: 'dispatcher-a',
          name: 'alpha',
          repo_cwd: '/workspace/repo',
          leader_agent_runtime: 'flow',
          worktree: { mode: 'reuse-cwd' },
        },
      });
    } finally {
      await admin.close();
    }
  });

  it('forwards worktree from create_group to mcp.team.create_group', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { team: { team_id: 'gamma' } },
    }));
    try {
      await callTool(admin, 'create_group', {
        name: 'gamma',
        repo_cwd: '/workspace/repo',
        leader_agent_runtime: 'flow',
        worktree: { mode: 'managed', slug: 'gamma', cleanup: 'delete-on-close' },
        source_chat_id: 'p2p_control',
        source_chat_type: 'p2p',
        requester_open_id: 'requester-open-id',
      });
      expect(admin.requests).toHaveLength(1);
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.team.create_group',
        params: {
          dispatcher_id: 'dispatcher-a',
          name: 'gamma',
          worktree: { mode: 'managed', slug: 'gamma', cleanup: 'delete-on-close' },
          source_chat_id: 'p2p_control',
          source_chat_type: 'p2p',
          requester_open_id: 'requester-open-id',
        },
      });
    } finally {
      await admin.close();
    }
  });

  it('rejects an invalid worktree mode before forwarding', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
    }));
    try {
      const response = (await callTool(admin, 'create', {
        name: 'alpha',
        repo_cwd: '/workspace/repo',
        leader_agent_runtime: 'flow',
        worktree: { mode: 'detached' },
      })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]?.text).toMatch(/worktree\.mode/);
      expect(admin.requests).toHaveLength(0);
    } finally {
      await admin.close();
    }
  });
});
