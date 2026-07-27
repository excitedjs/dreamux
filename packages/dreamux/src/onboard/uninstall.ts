import { pathExists } from '../platform/fs-errors.js';
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { ExecaCommandRunner } from './commands.js';
import { removeUserService } from './service.js';
import type { CommandRunner, ServicePlatform } from '../onboard/types.js';
import {
  assertNoLegacyTomlOnly,
  expandHome,
  globalConfigDir,
  globalConfigFile,
} from '../config/config.js';
import { cacheRoot, logsRoot, pluginRoot, runRoot, stateRoot } from '../platform/paths.js';

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
  const pluginDir = normalizePath(pluginRoot());

  assertSafeOwnedDirectory(stateDir, 'dreamux state directory');
  assertSafeOwnedDirectory(runDir, 'dreamux run directory');
  assertSafeOwnedDirectory(cacheDir, 'dreamux cache directory');
  assertSafeOwnedDirectory(logDir, 'dreamux logs directory');
  assertSafeOwnedDirectory(pluginDir, 'dreamux plugin directory');
  assertSafeOwnedDirectory(configDir, 'dreamux config directory');

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

  for (const entry of uniqueRemovalTargets([
    [stateDir, 'dreamux state directory'],
    [runDir, 'dreamux run directory'],
    [cacheDir, 'dreamux cache directory'],
    [logDir, 'dreamux logs directory'],
    [pluginDir, 'dreamux plugin directory'],
    [configDir, 'dreamux config directory'],
  ])) {
    await removeOwnedDirectory(entry.path, entries, entry.reason, dryRun);
  }

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
    const file = globalConfigFile({ configDir });
    if (!(await pathExists(file))) return;
    await assertOwnerOnlyFile(file);
    try {
      assertRawConfigShape(JSON.parse(await readFile(file, 'utf8')) as unknown, file);
    } catch (err) {
      throw new Error(
        `dreamux config parse error in ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `could not validate dreamux config before uninstall; continuing with fixed state/log paths: ${message}`,
    );
  }
}

async function assertOwnerOnlyFile(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  const mode = (await stat(file)).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`dreamux config file must be mode 0600: ${file} has mode 0${mode.toString(8)}`);
  }
}

function assertRawConfigShape(value: unknown, file: string): void {
  if (!isRecord(value)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  const agents = value['agents'];
  const dispatchers = value['dispatchers'];
  if (agents !== undefined && !Array.isArray(agents)) {
    throw new Error(`dreamux config error in ${file}: agents must be an array`);
  }
  if (dispatchers !== undefined && !Array.isArray(dispatchers)) {
    throw new Error(`dreamux config error in ${file}: dispatchers must be an array`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function uniqueRemovalTargets(
  entries: Array<[path: string, reason: string]>,
): Array<{ path: string; reason: string }> {
  const out = new Map<string, string>();
  for (const [path, reason] of entries) {
    if (!out.has(path)) out.set(path, reason);
  }
  return [...out].map(([path, reason]) => ({ path, reason }));
}

function isSameOrInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
