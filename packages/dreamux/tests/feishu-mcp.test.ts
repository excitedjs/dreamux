import { describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { runFeishuMcp } from '../src/mcp/feishu-mcp.js';
import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-mcp-admin-'));
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

describe('feishu-mcp stdio shim', () => {
  it('announces reply/react tools without reading dreamux config', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runFeishuMcp({
      dispatcherId: 'dispatcher-a',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const init = await reader.next();
    expect(init).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dreamux-feishu' },
      },
    });

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await reader.next() as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual([
      'reply',
      'react',
      'list_chat_bots',
    ]);

    input.end();
    await run;
  });

  it('negotiates supported MCP protocol versions and falls back safely', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runFeishuMcp({
      dispatcherId: 'dispatcher-a',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(await reader.next()).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18' },
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    });
    expect(await reader.next()).toMatchObject({
      id: 2,
      result: { protocolVersion: '2024-11-05' },
    });

    input.end();
    await run;
  });

  it('forwards reply tool calls to the dispatcher-scoped admin IPC method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { message_ids: ['message-out'] },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runFeishuMcp({
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
          name: 'reply',
          arguments: {
            chat_id: 'chat-a',
            message_id: 'message-in',
            text: 'hello',
            mention_user_ids: ['sender-a'],
          },
        },
      });
      const response = await reader.next();
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: { message_ids: ['message-out'] },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.reply',
          params: {
            dispatcher_id: 'dispatcher-a',
            chat_id: 'chat-a',
            message_id: 'message-in',
            text: 'hello',
            mention_user_ids: ['sender-a'],
          },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards list_chat_bots tool calls to the dispatcher-scoped admin method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        chat_id: 'chat-a',
        known: [{ open_id: 'ou-known' }],
        trusted: [{ open_id: 'ou-peer', name: 'Peer' }],
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runFeishuMcp({
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
        params: { name: 'list_chat_bots', arguments: { chat_id: 'chat-a' } },
      });
      const response = await reader.next();
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            chat_id: 'chat-a',
            known: [{ open_id: 'ou-known' }],
            trusted: [{ open_id: 'ou-peer', name: 'Peer' }],
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.list_chat_bots',
          params: { dispatcher_id: 'dispatcher-a', chat_id: 'chat-a' },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('returns tool argument validation failures as MCP tool errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runFeishuMcp({
      dispatcherId: 'dispatcher-a',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'reply',
        arguments: { chat_id: 'chat-a' },
      },
    });
    const response = await reader.next() as Record<string, unknown>;
    expect(response).not.toHaveProperty('error');
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'text must be a non-empty string' }],
      },
    });

    input.end();
    await run;
  });

  it('forwards react tool calls and returns admin errors as MCP tool errors', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'serve handler pending' },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runFeishuMcp({
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
          name: 'react',
          arguments: { message_id: 'message-in', emoji: 'THUMBSUP' },
        },
      });
      const response = await reader.next();
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: '[NOT_IMPLEMENTED] serve handler pending',
            },
          ],
        },
      });
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.react',
        params: {
          dispatcher_id: 'dispatcher-a',
          message_id: 'message-in',
          emoji: 'THUMBSUP',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
