import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sendOneAdminRequest } from '../src/admin/client.js';
import { adminMethods } from '../src/admin/methods.js';
import {
  createAdminSocketServer,
  type AdminSocketServer,
} from '../src/admin/socket.js';
import type { Server } from '../src/server.js';

const PRODUCT_METHODS = [
  'teammate.spawn',
  'teammate.send',
  'teammate.close',
  'teammate.history',
  'teammate.list',
  'teammate.status',
  'teammate.last',
  'teammate.capabilities',
  'workflow.run',
  'workflow.status',
  'workflow.stop',
  'workflow.list',
  'team.create',
  'team.send',
  'team.list',
  'team.status',
  'team.history',
  'team.bind_channel',
  'team.transfer_back',
  'team.dissolve',
  'collaboration_space.bind',
  'collaboration_space.dissolve',
  'collaboration_space.status',
  'collaboration_space.list',
] as const;

const RETIRED_METHODS = [
  ...PRODUCT_METHODS.map((method) => `mcp.${method}`),
  'dispatcher.add',
  'dispatcher.remove',
  'scheduler.cron.run_now',
] as const;

describe('admin control-plane method namespace', () => {
  let root: string;
  let socketPath: string;
  let socketServer: AdminSocketServer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-admin-namespace-'));
    socketPath = join(root, 'admin.sock');
    socketServer = createAdminSocketServer({} as Server, socketPath);
    await socketServer.start();
  });

  afterAll(async () => {
    await socketServer.close();
    await rm(root, { recursive: true, force: true });
  });

  it('registers canonical product names without mcp.* or dispatcher mutation entries', () => {
    for (const method of PRODUCT_METHODS) {
      expect(typeof adminMethods[method], method).toBe('function');
    }
    expect(Object.keys(adminMethods).filter((method) => method.startsWith('mcp.')))
      .toEqual([]);
    expect(adminMethods['dispatcher.add']).toBeUndefined();
    expect(adminMethods['dispatcher.remove']).toBeUndefined();
    expect(typeof adminMethods['scheduler.cron.list']).toBe('function');
    expect(adminMethods['scheduler.cron.run_now']).toBeUndefined();
    expect(typeof adminMethods['channel.invoke_tool']).toBe('function');
  });

  it('returns UNKNOWN_METHOD for every retired method through socket dispatch', async () => {
    for (const [index, method] of RETIRED_METHODS.entries()) {
      await expect(
        sendOneAdminRequest(
          socketPath,
          { id: `retired-${index}`, method, params: {} },
        ),
        method,
      ).rejects.toMatchObject({
        name: 'AdminClientError',
        code: 'UNKNOWN_METHOD',
        message: `unknown method '${method}'`,
      });
    }
  });

  it('does not retain dispatcher add/remove in either CLI dispatch layer', async () => {
    const [commandSource, ctlSource] = await Promise.all([
      readFile(new URL('../src/cli/commands/dispatcher.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/cli/server-ctl.ts', import.meta.url), 'utf8'),
    ]);
    expect(commandSource).not.toMatch(/command:\s*['"](?:add|remove)['"]/);
    expect(ctlSource).not.toMatch(/case\s+['"](?:add|remove)['"]/);
  });
});
