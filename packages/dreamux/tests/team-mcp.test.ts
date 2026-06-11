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
  it('marks create.intent, create_group.intent, and dissolve.note required (#182 PR-3)', async () => {
    const tools = await toolSchemas();
    expect(schemaOf(tools, 'create').required).toContain('intent');
    expect(schemaOf(tools, 'create_group').required).toContain('intent');
    expect(schemaOf(tools, 'dissolve').required).toEqual(['team_id', 'note']);
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
          arguments: { name: 'alpha', repo_cwd: '/repo', leader_agent_runtime: 'codex' },
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
        params: { name: 'dissolve', arguments: { team_id: 'alpha' } },
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
