import { access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

/** Async existence probe — the fs/promises replacement for `existsSync`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

import { ExecaCommandRunner } from './commands.js';
import { removeUserService } from './service.js';
import type { CommandRunner, ServicePlatform } from './types.js';
import {
  assertNoLegacyTomlOnly,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  type DispatcherConfig,
} from '../config/config.js';
import { loadConfigWithBuiltins } from '../agent-runtime/load-config.js';
import { cacheRoot, logsRoot, runRoot, stateRoot } from '../platform/paths.js';
import { dispatcherWorkspaceSkillDirs } from '../agent-runtime/builtin/codex/paths.js';

export type UninstallStatus = 'removed' | 'missing' | 'skipped';

export interface UninstallEntry {
  path: string;
  status: UninstallStatus;
  reason: string;
}

export interface RunUninstallOptions {
  configDir?: string;
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
  await warnIfConfigIsNotReadable(configDir, warnings);
  const stateDir = normalizePath(stateRoot());
  const runDir = normalizePath(runRoot());
  const cacheDir = normalizePath(cacheRoot());
  const logDir = normalizePath(logsRoot());

  assertSafeOwnedDirectory(stateDir, 'dreamux state directory');
  assertSafeOwnedDirectory(runDir, 'dreamux run directory');
  assertSafeOwnedDirectory(cacheDir, 'dreamux cache directory');
  assertSafeOwnedDirectory(logDir, 'dreamux logs directory');
  assertSafeOwnedDirectory(configDir, 'dreamux config directory');
  const workspaceSkillPaths = await collectWorkspaceSkillPaths(configDir);

  // Service removal (unit-only) is shared with `dreamux daemon uninstall`.
  const removal = await removeUserService({
    runner,
    platform: options.platform,
    homeDir: options.homeDir ?? homedir(),
    uid: options.uid,
    dryRun,
  });
  entries.push({
    path: removal.unitPath,
    status: removal.removed ? 'removed' : 'missing',
    reason: `${removal.platform} unit`,
  });

  await reportWorkspaceSkills(workspaceSkillPaths, entries);
  await removeOwnedDirectory(stateDir, entries, 'dreamux state directory', dryRun);
  await removeOwnedDirectory(runDir, entries, 'dreamux run directory', dryRun);
  await removeOwnedDirectory(cacheDir, entries, 'dreamux cache directory', dryRun);
  await removeOwnedDirectory(logDir, entries, 'dreamux logs directory', dryRun);
  await removeOwnedDirectory(configDir, entries, 'dreamux config directory', dryRun);

  return {
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
    service: {
      platform: removal.platform,
      unitPath: removal.unitPath,
    },
  };
}

async function warnIfConfigIsNotReadable(
  configDir: string,
  warnings: string[],
): Promise<void> {
  try {
    await assertNoLegacyTomlOnly({ configDir });
    if (!(await pathExists(globalConfigFile({ configDir })))) return;
    await loadConfigWithBuiltins({ configDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `could not validate dreamux config before uninstall; continuing with fixed state/log paths: ${message}`,
    );
  }
}

async function collectWorkspaceSkillPaths(configDir: string): Promise<string[]> {
  try {
    return (await loadConfigWithBuiltins({ configDir })).config.dispatchers
      .flatMap(dispatcherWorkspaceSkillPathsFromConfig);
  } catch {
    return [];
  }
}

function dispatcherWorkspaceSkillPathsFromConfig(
  dispatcher: DispatcherConfig,
): string[] {
  if (dispatcher.cwd === null || dispatcher.cwd.trim() === '') return [];
  return dispatcherWorkspaceSkillDirs(dispatcher.cwd);
}

async function reportWorkspaceSkills(
  paths: string[],
  entries: UninstallEntry[],
): Promise<void> {
  for (const path of uniquePaths(paths)) {
    entries.push({
      path,
      status: (await pathExists(path)) ? 'skipped' : 'missing',
      reason: 'workspace-local bundled skill (not removed)',
    });
  }
}

async function removeOwnedDirectory(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
): Promise<void> {
  assertSafeOwnedDirectory(path, reason);
  await removePath(path, entries, reason, dryRun);
}

async function removePath(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
): Promise<void> {
  if (!(await pathExists(path))) {
    entries.push({ path, status: 'missing', reason });
    return;
  }
  if (!dryRun) {
    await rm(path, {
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
