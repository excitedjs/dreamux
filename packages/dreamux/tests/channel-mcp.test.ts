import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import { runChannelMcp } from '../src/mcp/channel-mcp.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-channel-mcp-admin-'));
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
  const run = runChannelMcp({
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

describe('channel-mcp stdio shim (issue #209 slice 8)', () => {
  it('exposes exactly the core channel-binding tools', async () => {
    const tools = await toolSchemas();
    expect(tools.map((t) => t['name'])).toEqual(['bind_channel', 'transfer_back']);
    // chat_id terminology; group-only, so no chat_type on the surface.
    expect(schemaOf(tools, 'bind_channel').required).toEqual(['team_name', 'chat_id']);
    expect(schemaOf(tools, 'bind_channel').properties).not.toHaveProperty('chat_type');
    expect(schemaOf(tools, 'transfer_back').required).toEqual(['chat_id']);
    expect(schemaOf(tools, 'transfer_back').properties).not.toHaveProperty('chat_type');
  });

  it('forwards bind_channel / transfer_back to the mcp.channel.* admin methods', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runChannelMcp({
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
        params: { name: 'bind_channel', arguments: { team_name: 'alpha', chat_id: 'chat-1' } },
      });
      await reader.next();
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'transfer_back', arguments: { chat_id: 'chat-1' } },
      });
      await reader.next();

      expect(admin.requests.map((r) => r.method)).toEqual([
        'mcp.channel.bind_channel',
        'mcp.channel.transfer_back',
      ]);
      expect(admin.requests[0]?.params).toMatchObject({
        dispatcher_id: 'dispatcher-a',
        team_name: 'alpha',
        chat_id: 'chat-1',
      });
      // No chat_type leaks through the group-only binding surface.
      expect(admin.requests[0]?.params).not.toHaveProperty('chat_type');
      expect(admin.requests[1]?.params).toMatchObject({
        dispatcher_id: 'dispatcher-a',
        chat_id: 'chat-1',
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects bind_channel without required params before admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runChannelMcp({
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
        params: { name: 'bind_channel', arguments: { team_name: 'alpha' } },
      });
      const response = (await reader.next()) as { result: { isError?: boolean } };
      expect(response.result.isError).toBe(true);
      expect(admin.requests).toHaveLength(0);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
