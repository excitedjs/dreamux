import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

import { ExecaCommandRunner } from './commands.js';
import {
  LAUNCHD_LABEL,
  serviceUnitPath,
  SYSTEMD_UNIT,
} from './service.js';
import type { CommandRunner, ServicePlatform } from './types.js';
import {
  BUILT_IN_DEFAULTS,
  expandHome,
  globalConfigDir,
  loadConfig,
} from '../runtime/config.js';

export type UninstallStatus = 'removed' | 'missing' | 'skipped';

export interface UninstallEntry {
  path: string;
  status: UninstallStatus;
  reason: string;
}

export interface RunUninstallOptions {
  configDir?: string;
  runtimeDir?: string;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dryRun?: boolean;
}

export interface UninstallRunResult {
  entries: UninstallEntry[];
  service: {
    platform: ServicePlatform;
    unitPath: string;
  };
}

export async function runUninstall(
  options: RunUninstallOptions = {},
): Promise<UninstallRunResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const dryRun = options.dryRun ?? false;
  const configDir = normalizePath(options.configDir ?? globalConfigDir());
  const runtimeDir = normalizePath(resolveRuntimeDir(configDir, options.runtimeDir));
  const entries: UninstallEntry[] = [];
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());

  await unregisterService({
    unitPath: unit.path,
    platform: unit.platform,
    runner,
    dryRun,
    uid: options.uid,
  });
  removePath(unit.path, entries, `${unit.platform} unit`, dryRun);

  if (unit.platform === 'systemd') {
    await runBestEffort(runner, 'systemctl', ['--user', 'daemon-reload'], dryRun);
  }

  removeOwnedDirectory(runtimeDir, entries, 'dreamux runtime directory', dryRun);
  removeOwnedDirectory(configDir, entries, 'dreamux config directory', dryRun);

  return {
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    service: {
      platform: unit.platform,
      unitPath: unit.path,
    },
  };
}

function resolveRuntimeDir(configDir: string, explicit: string | undefined): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  try {
    return loadConfig({ configDir }).config.runtime_dir;
  } catch {
    return BUILT_IN_DEFAULTS.runtime_dir;
  }
}

async function unregisterService(options: {
  unitPath: string;
  platform: ServicePlatform;
  runner: CommandRunner;
  dryRun: boolean;
  uid?: number;
}): Promise<void> {
  if (options.platform === 'launchd') {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) {
      throw new Error('launchd user service uninstall requires a numeric uid');
    }
    const serviceTarget = `gui/${uid}/${LAUNCHD_LABEL}`;
    const loaded = await options.runner.check(
      'launchctl',
      ['print', serviceTarget],
      { dryRun: options.dryRun },
    );
    if (loaded) {
      await runBestEffort(
        options.runner,
        'launchctl',
        ['bootout', serviceTarget],
        options.dryRun,
      );
    }
    return;
  }

  await runBestEffort(
    options.runner,
    'systemctl',
    ['--user', 'disable', '--now', SYSTEMD_UNIT],
    options.dryRun,
  );
}

async function runBestEffort(
  runner: CommandRunner,
  command: string,
  args: string[],
  dryRun: boolean,
): Promise<void> {
  try {
    await runner.run(command, args, { dryRun });
  } catch {
    /* The unit may already be absent or stopped; file deletion below is authoritative. */
  }
}

function removeOwnedDirectory(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
): void {
  assertSafeOwnedDirectory(path, reason);
  removePath(path, entries, reason, dryRun);
}

function removePath(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
): void {
  if (!existsSync(path)) {
    entries.push({ path, status: 'missing', reason });
    return;
  }
  if (!dryRun) {
    rmSync(path, {
      recursive: true,
      force: true,
    });
  }
  entries.push({ path, status: 'removed', reason });
}

function assertSafeOwnedDirectory(path: string, reason: string): void {
  const normalized = normalizePath(path);
  const home = normalizePath(homedir());
  if (
    normalized === '/' ||
    normalized === home ||
    basename(normalized) === '' ||
    normalized === normalizePath(process.cwd())
  ) {
    throw new Error(`refusing to remove unsafe ${reason}: ${path}`);
  }
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}
