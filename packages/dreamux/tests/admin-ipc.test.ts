import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsPowerShellEnvironment } from '@excitedjs/dreamux-utils';

import { adminJsonInvoker } from '../src/admin/client.js';
import {
  createAdminSocketServer,
  type AdminSocketServer,
} from '../src/admin/socket.js';
import { createLogger } from '../src/platform/logger.js';
import { adminSocketAddress } from '../src/platform/paths.js';
import * as windowsPipe from '../src/admin/windows-pipe.js';

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
      const pipeName = adminSocketAddress(server.socketPath).slice(
        '\\\\.\\pipe\\'.length,
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const script = `
$ErrorActionPreference = 'Stop'
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [System.IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(5000)
  $security = $pipe.GetAccessControl()
  @{ protected = $security.AreAccessRulesProtected; owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; rights = [string]$_.PipeAccessRights } }) } | ConvertTo-Json -Depth 3 -Compress
} finally { $pipe.Dispose() }
`;
        const { stdout } = await promisify(execFile)(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          { windowsHide: true, env: windowsPowerShellEnvironment() },
        );
        const acl = JSON.parse(stdout) as {
          protected: boolean;
          owner: string;
          rules: { sid: string; type: string; rights: string }[];
        };
        expect(acl.protected).toBe(true);
        expect(acl.rules).toEqual([
          { sid: acl.owner, type: 'Allow', rights: 'FullControl' },
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
