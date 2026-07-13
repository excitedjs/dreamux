import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import {
  collaborationSpaceTools,
  runCollaborationSpaceMcp,
} from '../src/mcp/collaboration-space-mcp.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-collab-space-mcp-'));
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

describe('collaboration-space-mcp stdio shim', () => {
  it('lists only bind/dissolve/status/list', () => {
    expect(collaborationSpaceTools().map((tool) => tool['name'])).toEqual([
      'bind',
      'dissolve',
      'status',
      'list',
    ]);
  });

  it('forwards bind and dissolve to admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true, method: request.method },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runCollaborationSpaceMcp({
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
          name: 'bind',
          arguments: {
            space_name: 'space-alpha',
            container: {
              container_type: 'topic_group',
              container_key: 'chat-1',
              display: 'Alpha',
              meta: { opaque: true },
            },
            leader_agent_runtime: 'agent-a',
            identity: 'default leader identity',
          },
        },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ text: 'bind forwarded to dreamux serve' }],
          structuredContent: {
            ok: true,
            method: 'mcp.collaboration_space.bind',
          },
        },
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'dissolve',
          arguments: { space_name: 'space-alpha', note: 'switch repo' },
        },
      });
      expect(await reader.next()).toMatchObject({
        result: {
          structuredContent: {
            method: 'mcp.collaboration_space.dissolve',
          },
        },
      });

      expect(admin.requests.map((request) => request.method)).toEqual([
        'mcp.collaboration_space.bind',
        'mcp.collaboration_space.dissolve',
      ]);
      expect(admin.requests[0]?.params).toMatchObject({
        dispatcher_id: 'dispatcher-a',
        space_name: 'space-alpha',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-1',
          meta: { opaque: true },
        },
        leader_agent_runtime: 'agent-a',
        identity: 'default leader identity',
      });
      expect(admin.requests[0]?.params).not.toHaveProperty('repo');

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
