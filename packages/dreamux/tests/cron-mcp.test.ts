import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtocolErrorCode } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { AdminRequest } from '../src/admin/protocol.js';
import { runCronMcp } from '../src/mcp/cron-mcp.js';
import { callTool, connectMcpClient, listedTools } from './helpers/mcp-client.js';

describe('cron MCP descriptor-bound target', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  // Stand up a fake `dreamux serve` admin socket that records every forwarded
  // request and replies with an ok cron-job result, then connect an official-SDK
  // MCP client to the cron server over an in-memory transport.
  async function openCronMcp(opts: { teamId?: string }): Promise<{
    requests: AdminRequest[];
    listTools(): ReturnType<typeof listedTools>;
    call(name: string, args: Record<string, unknown>): ReturnType<typeof callTool>;
    close(): Promise<void>;
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'dreamux-cron-mcp-'));
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
          socket.write(`${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              id: 'job-1',
              dispatcher_id: 'dispatcher-a',
              cron: '* * * * *',
              tz: 'UTC',
              recurring: true,
              action: { kind: 'prompt-agent', prompt: 'remind' },
              enabled: true,
              created_at: 1,
              updated_at: 1,
              next_run_at: 2,
              last_fired_at: null,
            },
          })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    const mcp = await connectMcpClient((transport) =>
      runCronMcp({
        dispatcherId: 'dispatcher-a',
        ...(opts.teamId !== undefined ? { teamId: opts.teamId } : {}),
        adminSocketPath: socketPath,
        transport,
        log: () => {},
      }),
    );
    cleanup = async () => {
      await mcp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };
    return {
      requests,
      listTools: () => listedTools(mcp.client),
      call: (name, args) => callTool(mcp.client, name, args),
      close: async () => {
        await cleanup?.();
        cleanup = null;
      },
    };
  }

  it('applies the TeamLeader team binding after validated model input', async () => {
    const mcp = await openCronMcp({ teamId: 'alpha' });
    await expect(
      mcp.call('cron_create', { cron: '* * * * *', prompt: 'remind' }),
    ).resolves.toEqual({
      content: [],
      structuredContent: {
        id: 'job-1',
        dispatcher_id: 'dispatcher-a',
        cron: '* * * * *',
        tz: 'UTC',
        recurring: true,
        action: { kind: 'prompt-agent', prompt: 'remind' },
        enabled: true,
        created_at: 1,
        updated_at: 1,
        next_run_at: 2,
        last_fired_at: null,
      },
    });
    expect(mcp.requests).toHaveLength(1);
    expect(mcp.requests[0]?.method).toBe('scheduler.cron.create');
    expect(mcp.requests[0]?.params).toMatchObject({
      dispatcher_id: 'dispatcher-a',
      team_id: 'alpha',
      cron: '* * * * *',
      prompt: 'remind',
    });
    await mcp.close();
  });

  it('keeps dispatcher-scoped cron calls free of a team binding', async () => {
    const mcp = await openCronMcp({});
    await mcp.call('cron_create', { cron: '* * * * *', prompt: 'remind' });
    expect(mcp.requests[0]?.params).toMatchObject({ dispatcher_id: 'dispatcher-a' });
    expect(mcp.requests[0]?.params).not.toHaveProperty('team_id');
    await mcp.close();
  });

  it('rejects model-supplied dispatcher and team scope before admin dispatch', async () => {
    const mcp = await openCronMcp({ teamId: 'alpha' });
    await expect(
      mcp.call('cron_create', {
        cron: '* * * * *',
        prompt: 'remind',
        dispatcher_id: 'evil',
        team_id: 'other-team',
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(mcp.requests).toEqual([]);
    await mcp.close();
  });

  it('lists exactly the four durable cron tools without a run-now surface', async () => {
    const mcp = await openCronMcp({});
    const names = (await mcp.listTools()).map((tool) => tool.name);
    expect(names).toEqual([
      'cron_create',
      'cron_list',
      'cron_delete',
      'cron_update',
    ]);
    expect(names).not.toContain('cron_run_now');
    await mcp.close();
  });

  it('rejects cron_run_now as an unregistered tool without forwarding an admin request', async () => {
    const mcp = await openCronMcp({});
    // The run-now tool is no longer advertised, so the official protocol rejects
    // the call before any handler runs; nothing reaches the admin socket.
    await expect(
      mcp.call('cron_run_now', { id: 'job-1' }),
    ).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
    expect(mcp.requests).toEqual([]);
    await mcp.close();
  });
});
