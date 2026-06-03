import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { DispatcherRepo } from '../db/repository.js';
import { openDatabase } from '../db/schema.js';
import type { DispatcherRow } from '../db/types.js';
import { ExecaCommandRunner } from './commands.js';
import {
  LAUNCHD_LABEL,
  serviceUnitPath,
  SYSTEMD_UNIT,
} from './service.js';
import type { CommandRunner, ServicePlatform } from './types.js';
import {
  assertNoLegacyTomlOnly,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
} from '../runtime/config.js';
import {
  databasePath,
  dispatcherWorkspaceSkillPath,
  logsRoot,
  stateRoot,
} from '../runtime/paths.js';

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
  warnings: string[];
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
  const entries: UninstallEntry[] = [];
  const warnings: string[] = [];
  const unit = serviceUnitPath(options.platform, options.homeDir ?? homedir());
  warnIfConfigIsNotReadable(configDir, warnings);
  const stateDir = normalizePath(stateRoot());
  const logDir = normalizePath(logsRoot());

  assertSafeOwnedDirectory(stateDir, 'dreamux state directory');
  assertSafeOwnedDirectory(logDir, 'dreamux logs directory');
  assertSafeOwnedDirectory(configDir, 'dreamux config directory');
  const workspaceSkillPaths = collectWorkspaceSkillPaths();

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

  reportWorkspaceSkills(workspaceSkillPaths, entries);
  removeOwnedDirectory(stateDir, entries, 'dreamux state directory', dryRun);
  removeOwnedDirectory(logDir, entries, 'dreamux logs directory', dryRun);
  removeOwnedDirectory(configDir, entries, 'dreamux config directory', dryRun);

  return {
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
    service: {
      platform: unit.platform,
      unitPath: unit.path,
    },
  };
}

function warnIfConfigIsNotReadable(configDir: string, warnings: string[]): void {
  try {
    assertNoLegacyTomlOnly({ configDir });
    if (!existsSync(globalConfigFile({ configDir }))) return;
    loadConfig({ configDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `could not validate dreamux config before uninstall; continuing with fixed state/log paths: ${message}`,
    );
  }
}

function collectWorkspaceSkillPaths(): string[] {
  const dbPath = databasePath();
  if (!existsSync(dbPath)) return [];
  const db = openDatabase({ path: dbPath });
  try {
    return new DispatcherRepo(db)
      .list()
      .map(dispatcherWorkspaceSkillPathFromRow)
      .filter((path): path is string => path !== null);
  } finally {
    db.close();
  }
}

function dispatcherWorkspaceSkillPathFromRow(row: DispatcherRow): string | null {
  if (row.codex_cwd === null || row.codex_cwd.trim() === '') return null;
  return dispatcherWorkspaceSkillPath(row.codex_cwd);
}

function reportWorkspaceSkills(
  paths: string[],
  entries: UninstallEntry[],
): void {
  for (const path of uniquePaths(paths)) {
    entries.push({
      path,
      status: existsSync(path) ? 'skipped' : 'missing',
      reason: 'workspace-local dispatcher skill (not removed)',
    });
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
  for (const protectedRoot of operatorStateRoots()) {
    if (isSameOrInside(normalized, protectedRoot)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${path} is inside operator Codex/Claude state ${protectedRoot}`,
      );
    }
  }
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

function operatorStateRoots(): string[] {
  return uniquePaths([
    joinHome('.codex'),
    joinHome('.claude'),
  ]);
}

function joinHome(child: string): string {
  return normalizePath(join(homedir(), child));
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (path === undefined || path.trim() === '') continue;
    out.add(normalizePath(path));
  }
  return Array.from(out);
}

function isSameOrInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
