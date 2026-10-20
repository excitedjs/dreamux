import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentWindowsUserSid,
  isWindowsAdministrator,
  readWindowsPermissions,
  setWindowsFixturePermissions,
} from '../../../common/scripts/test-permissions.mjs';

import { createServiceHost } from '../src/daemon/host.js';
import { installUserService } from '../src/daemon/install.js';
import type { ServiceInstallAnswers } from '../src/daemon/environment.js';
import type { CommandRunner } from '../src/platform/command-runner.js';
import { TransparentFileLedger } from '../src/platform/file-ledger.js';
import { logsRoot, windowsServiceFile } from '../src/platform/paths.js';

interface LogPermissions {
  currentUser: string;
  entries: {
    path: string;
    owner: string;
    protected: boolean;
    foreign: number;
    full: number;
    sddl: string;
  }[];
}

describe.skipIf(process.platform !== 'win32')(
  'Windows service log ownership',
  () => {
    let root: string;
    let answers: ServiceInstallAnswers;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'dreamux-service-privacy-'));
      vi.stubEnv('DREAMUX_ROOT', root);
      answers = {
        providerBinChecks: [],
        dreamuxBin: join(root, 'dreamux'),
        nodeBin: process.execPath,
        startService: false,
        dryRun: false,
        homeDir: root,
        platform: 'win32',
        env: {},
        fallbackDirs: [],
      };
      const nested = join(logsRoot(), 'workflow');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'existing.log'), 'existing diagnostic\n');
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    });

    async function logPaths(): Promise<string[]> {
      return [
        logsRoot(),
        ...(await readdir(logsRoot(), { recursive: true })).map((path) =>
          join(logsRoot(), path),
        ),
      ];
    }

    async function permissions(): Promise<LogPermissions> {
      const currentUser = currentWindowsUserSid();
      const entries = (await logPaths()).map((path) => {
        const acl = readWindowsPermissions(path);
        return {
          path,
          owner: acl.owner,
          protected: acl.protected,
          sddl: acl.sddl,
          foreign: acl.rules.filter((rule) => rule.sid !== currentUser).length,
          full: acl.rules.filter(
            (rule) =>
              rule.sid === currentUser &&
              rule.type === 'Allow' &&
              (rule.mask & 0x1f01ff) === 0x1f01ff,
          ).length,
        };
      });
      return { currentUser, entries };
    }

    async function exposeExistingLogs(): Promise<boolean> {
      const elevated = isWindowsAdministrator();
      const sid = currentWindowsUserSid();
      for (const path of await logPaths()) {
        const inherit = (await stat(path)).isDirectory() ? 'OICI' : '';
        setWindowsFixturePermissions(
          path,
          `O:${elevated ? 'BA' : sid}D:P(A;${inherit};FA;;;${sid})(A;;FR;;;WD)`,
        );
      }
      return elevated;
    }

    it('prepares native ownership and privacy for every log before registering the limited task', async () => {
      const elevated = await exposeExistingLogs();
      const before = await permissions();
      expect(before.entries.every((entry) => entry.foreign > 0)).toBe(true);
      if (elevated) {
        expect(
          before.entries.every((entry) => entry.owner === 'S-1-5-32-544'),
        ).toBe(true);
      }
      let registered = false;
      const runner: CommandRunner = {
        run: async () => {
          const prepared = await permissions();
          expect(prepared.entries.map((entry) => entry.path).sort()).toEqual(
            [
              logsRoot(),
              join(logsRoot(), 'workflow'),
              join(logsRoot(), 'workflow', 'existing.log'),
              join(logsRoot(), 'daemon.stdout.log'),
              join(logsRoot(), 'daemon.stderr.log'),
            ].sort(),
          );
          for (const entry of prepared.entries) {
            expect(entry).toMatchObject({
              owner: prepared.currentUser,
              protected: true,
              foreign: 0,
              full: 1,
            });
          }
          registered = true;
        },
        capture: async () => 'null',
        check: async () => {
          throw new Error('unexpected task check');
        },
      };
      await installUserService({
        answers,
        ledger: new TransparentFileLedger(),
        host: createServiceHost({ runner, platform: 'win32' }),
      });
      expect(registered).toBe(true);
      expect(
        await readFile(join(logsRoot(), 'workflow', 'existing.log'), 'utf8'),
      ).toBe('existing diagnostic\n');
    }, 20000);

    it('leaves existing log ownership, ACLs and contents unchanged during dry run', async () => {
      await exposeExistingLogs();
      const before = await permissions();
      const runner: CommandRunner = {
        run: async (_command, _args, options) => {
          expect(options?.dryRun).toBe(true);
        },
        capture: async () => {
          throw new Error('unexpected task query');
        },
        check: async () => {
          throw new Error('unexpected task check');
        },
      };
      await installUserService({
        answers: { ...answers, dryRun: true },
        ledger: new TransparentFileLedger(),
        host: createServiceHost({ runner, platform: 'win32' }),
      });
      expect(await permissions()).toEqual(before);
      expect(await readdir(logsRoot())).toEqual(['workflow']);
      expect(
        await readFile(join(logsRoot(), 'workflow', 'existing.log'), 'utf8'),
      ).toBe('existing diagnostic\n');
      await expect(readFile(windowsServiceFile())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }, 20000);
  },
);
