import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import {
  collaborationSpaceTools,
  runCollaborationSpaceMcp,
} from '../src/mcp/collaboration-space-mcp.js';
import { callTool, connectMcpClient } from './helpers/mcp-client.js';

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

describe('collaboration-space MCP', () => {
  it('lists only bind/dissolve/status/list', () => {
    expect(collaborationSpaceTools().map((tool) => tool['name'])).toEqual([
      'bind',
      'dissolve',
      'status',
      'list',
    ]);
  });

  it('forwards every tool through the canonical admin namespace', async () => {
    const space = { space_name: 'space-alpha', status: 'bound' };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        'collaboration_space.bind': { space },
        'collaboration_space.dissolve': {
          space: { ...space, status: 'unbound' },
          detached_targets: 1,
          released_bindings: 1,
        },
        'collaboration_space.status': { space, targets: [] },
        'collaboration_space.list': { spaces: [] },
      }[request.method] ?? {},
    }));
    const mcp = await connectMcpClient((transport) =>
      runCollaborationSpaceMcp({
        dispatcherId: 'dispatcher-a',
        adminSocketPath: admin.socketPath,
        transport,
        log: () => {},
      }),
    );
    try {
      const bind = await callTool(mcp.client, 'bind', {
        space_name: 'space-alpha',
        container: {
          container_type: 'topic_group',
          container_key: 'chat-1',
          display: 'Alpha',
          meta: { opaque: true },
        },
        leader_agent_runtime: 'agent-a',
        identity: 'default leader identity',
      });
      expect(bind).toMatchObject({
        content: [{ text: JSON.stringify({ space }) }],
        structuredContent: { space },
      });
      await expect(callTool(mcp.client, 'dissolve', {
        space_name: 'space-alpha',
        note: 'switch repo',
      })).resolves.toMatchObject({
        structuredContent: {
          space: { ...space, status: 'unbound' },
          detached_targets: 1,
          released_bindings: 1,
        },
      });
      await expect(
        callTool(mcp.client, 'status', { space_name: 'space-alpha' }),
      ).resolves.toMatchObject({ structuredContent: { space, targets: [] } });
      await expect(callTool(mcp.client, 'list', {})).resolves.toMatchObject({
        structuredContent: { spaces: [] },
      });

      expect(admin.requests.map((request) => request.method)).toEqual([
        'collaboration_space.bind',
        'collaboration_space.dissolve',
        'collaboration_space.status',
        'collaboration_space.list',
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
    } finally {
      await mcp.close();
      await admin.close();
    }
  });
});
