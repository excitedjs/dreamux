import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as windowsPipe from '@excitedjs/dreamux-utils';
import {
  currentWindowsUserSid,
  readWindowsPermissions,
} from '../../../common/scripts/test-permissions.mjs';

import { adminJsonInvoker } from '../src/admin/client.js';
import {
  createAdminSocketServer,
  type AdminSocketServer,
} from '../src/admin/socket.js';
import { createLogger } from '../src/platform/logger.js';
import { adminSocketAddress } from '../src/platform/paths.js';

vi.mock('@excitedjs/dreamux-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof windowsPipe>()),
}));

const roots: string[] = [];
const servers: AdminSocketServer[] = [];
const logger = createLogger({ destination: { write() {} } });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function start(label: string, socketPath?: string, selfPid?: number) {
  if (socketPath === undefined) {
    const root = await mkdtemp(join(tmpdir(), 'dreamux-ipc-'));
    roots.push(root);
    socketPath = join(root, 'admin.sock');
  }
  const server = createAdminSocketServer(
    {
      logger,
      commands: {
        async invoke(_context, _method, payload) {
          return { label, payload };
        },
      },
    },
    socketPath,
    selfPid === undefined ? {} : { selfPid },
  );
  servers.push(server);
  await server.start();
  return { server, client: adminJsonInvoker({ socketPath }) };
}

describe('native local admin IPC', () => {
  it.runIf(process.platform === 'win32')(
    'keeps every pipe instance owner-only after repeated client connections',
    async () => {
      const { server, client } = await start('private');
      const address = adminSocketAddress(server.socketPath);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const acl = readWindowsPermissions(address, true);
        expect(acl.protected).toBe(true);
        expect(acl.rules).toEqual([
          {
            sid: currentWindowsUserSid(),
            type: 'Allow',
            mask: 0x1f01ff,
            flags: 0,
          },
        ]);
        await expect(client.invoke('echo', {})).resolves.toMatchObject({
          label: 'private',
        });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not admit requests before permissions succeed and releases failed startup state',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dreamux-ipc-'));
      roots.push(root);
      const socketPath = join(root, 'admin.sock');
      const invoke = vi.fn(async () => ({}));
      let denyPermissions!: (reason: Error) => void;
      const permissions = vi
        .spyOn(windowsPipe, 'restrictWindowsPipe')
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              denyPermissions = reject;
            }),
        );
      const server = createAdminSocketServer(
        { logger, commands: { invoke } },
        socketPath,
      );
      servers.push(server);
      const starting = server.start();
      await vi.waitFor(() => expect(permissions).toHaveBeenCalledOnce());
      const client = createConnection(adminSocketAddress(socketPath));
      client.on('error', () => {});
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write(
        `${JSON.stringify({ id: 'before-permissions', method: 'echo' })}\n`,
      );
      denyPermissions(new Error('fixture ACL failure'));
      await expect(starting).rejects.toThrow('fixture ACL failure');
      expect(invoke).not.toHaveBeenCalled();
      client.destroy();
      await expect(start('retry', socketPath)).resolves.toBeDefined();
    },
  );

  it('delivers requests to the selected root and keeps separate roots isolated', async () => {
    const first = await start('first');
    const second = await start('second');
    await expect(
      first.client.invoke('echo', { text: 'hello' }),
    ).resolves.toEqual({
      label: 'first',
      payload: { text: 'hello' },
    });
    await expect(second.client.invoke('echo', {})).resolves.toEqual({
      label: 'second',
      payload: {},
    });
  });

  it('rejects a second server without disturbing the running endpoint', async () => {
    const first = await start('first');
    await expect(
      start('second', first.server.socketPath, process.pid + 1),
    ).rejects.toThrow(/held by another live/);
    await expect(first.client.invoke('echo', {})).resolves.toEqual({
      label: 'first',
      payload: {},
    });
  });

  it('releases its endpoint and lock so the same root can restart', async () => {
    const first = await start('first');
    await first.server.close();
    const second = await start('second', first.server.socketPath);
    await expect(second.client.invoke('echo', {})).resolves.toEqual({
      label: 'second',
      payload: {},
    });
  });

  it.runIf(process.platform === 'win32')(
    'serves a Windows root beyond the Unix socket pathname limit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dreamux-ipc-'));
      roots.push(root);
      const { client } = await start(
        'long-root',
        join(root, 'workspace '.repeat(10).trimEnd(), 'admin.sock'),
      );
      await expect(client.invoke('echo', {})).resolves.toEqual({
        label: 'long-root',
        payload: {},
      });
    },
  );
});
