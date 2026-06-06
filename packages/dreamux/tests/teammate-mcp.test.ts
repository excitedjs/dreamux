import { describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { runTeamMateMcp } from '../src/mcp/teammate-mcp.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-teammate-mcp-admin-'));
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

describe('teammate-mcp stdio shim', () => {
  it('announces the scheduling tool without reading dreamux config', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(await reader.next()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dreamux-teammate' },
      },
    });

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await reader.next() as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(['schedule']);

    input.end();
    await run;
  });

  it('forwards schedule tool calls to the dispatcher-scoped admin IPC method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        status: 'accepted',
        task_id: 'tmtsk_1_task',
        dispatcher_id: 'dispatcher-a',
        created_at: 1000,
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
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
          name: 'schedule',
          arguments: {
            title: 'Review issue',
            prompt: 'Read the issue and return a short summary.',
            teammate_id: 'reviewer-1',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            status: 'accepted',
            task_id: 'tmtsk_1_task',
            dispatcher_id: 'dispatcher-a',
            created_at: 1000,
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.teammate.schedule',
          params: {
            dispatcher_id: 'dispatcher-a',
            caller_kind: 'dispatcher',
            title: 'Review issue',
            prompt: 'Read the issue and return a short summary.',
            teammate_id: 'reviewer-1',
          },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('returns validation failures as MCP tool errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'schedule', arguments: { title: 'Missing prompt' } },
    });

    expect(await reader.next()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'prompt must be a non-empty string' }],
      },
    });

    input.end();
    await run;
  });

  it('returns admin nested-dispatch rejection as an MCP tool error', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: 'TEAMMATE_NESTED_DISPATCH_REJECTED',
        message: 'TeamMate tasks cannot schedule more TeamMate tasks',
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'teammate',
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
          name: 'schedule',
          arguments: {
            title: 'Nested',
            prompt: 'Nested scheduling attempt.',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                '[TEAMMATE_NESTED_DISPATCH_REJECTED] ' +
                'TeamMate tasks cannot schedule more TeamMate tasks',
            },
          ],
        },
      });
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.teammate.schedule',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'teammate',
          title: 'Nested',
          prompt: 'Nested scheduling attempt.',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('never writes non-protocol output to stdout, even on error paths', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rawLines: string[] = [];
    output.setEncoding('utf8');
    let pending = '';
    output.on('data', (chunk: string) => {
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.trim() !== '') rawLines.push(line);
      }
    });
    const logMessages: string[] = [];
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/dreamux-teammate-nonexistent.sock',
      input,
      output,
      log: (message) => logMessages.push(message),
    });

    input.write('this is not json\n');
    writeJson(input, { jsonrpc: '2.0', id: 1, method: 'no/such/method', params: {} });
    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'schedule',
        arguments: { title: 'Task', prompt: 'Prompt' },
      },
    });

    input.end();
    await run;
    await new Promise((resolve) => setImmediate(resolve));

    expect(rawLines.length).toBe(3);
    const parsed = rawLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    for (const envelope of parsed) {
      expect(envelope['jsonrpc']).toBe('2.0');
    }
    expect(parsed[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(parsed[1]).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(parsed[2]).toMatchObject({ id: 2, result: { isError: true } });

    const stdout = rawLines.join('\n');
    for (const message of logMessages) {
      expect(stdout).not.toContain(message);
    }
  });
});
