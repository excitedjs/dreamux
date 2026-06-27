import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { AdminRequest } from '../src/admin/protocol.js';
import { runCronMcp } from '../src/mcp/cron-mcp.js';

describe('cron MCP descriptor-bound target', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) await cleanup();
    cleanup = null;
  });

  // Drive the cron MCP shim with one `cron_create` tools/call and return the
  // admin request it forwarded to the (fake) serve socket.
  async function forwardCreate(
    opts: { teamId?: string },
    args: Record<string, unknown>,
  ): Promise<AdminRequest> {
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
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    cleanup = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };

    const input = new PassThrough();
    const output = new PassThrough();
    const run = runCronMcp({
      dispatcherId: 'dispatcher-a',
      ...(opts.teamId !== undefined ? { teamId: opts.teamId } : {}),
      adminSocketPath: socketPath,
      input,
      output,
      log: () => {},
    });
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'cron_create', arguments: args },
      })}\n`,
    );
    const deadline = Date.now() + 2000;
    while (requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    input.end();
    await run;
    return requests[0]!;
  }

  it('ignores a model-supplied team_id/dispatcher_id and uses the TeamLeader binding', async () => {
    const request = await forwardCreate(
      { teamId: 'alpha' },
      { cron: '* * * * *', prompt: 'remind', dispatcher_id: 'evil', team_id: 'other-team' },
    );
    expect(request.method).toBe('scheduler.cron.create');
    expect(request.params).toMatchObject({
      dispatcher_id: 'dispatcher-a',
      team_id: 'alpha',
      cron: '* * * * *',
      prompt: 'remind',
    });
  });

  it('drops a model-supplied team_id for a dispatcher-scoped cron MCP', async () => {
    const request = await forwardCreate(
      {},
      { cron: '* * * * *', prompt: 'remind', team_id: 'sneaky' },
    );
    expect(request.params).toMatchObject({ dispatcher_id: 'dispatcher-a' });
    expect(request.params).not.toHaveProperty('team_id');
  });
});
