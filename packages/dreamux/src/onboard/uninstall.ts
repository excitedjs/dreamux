import { pathExists } from '../platform/fs-errors.js';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';

import { removeUserService } from '../daemon/install.js';
import { createServiceHost } from '../daemon/host.js';
import type { ServicePlatform } from '../daemon/unit.js';
import type { CommandRunner } from '../platform/command-runner.js';
import {
  expandHome,
  globalConfigDir,
  globalConfigFile,
} from '../config/config.js';
import { assertNoLegacyTomlOnly, loadConfig } from '../config/load.js';
import { cacheRoot, logsRoot, runRoot, stateRoot } from '../platform/paths.js';
import { createBuiltinProviderRegistry } from '../registry/index.js';
import { loadPlugins } from '../plugin/loader.js';
import { createLogger } from '../platform/logger.js';
import { asAgentRuntimeProvider } from '../agent-runtime/catalog.js';

export type UninstallStatus = 'removed' | 'missing' | 'skipped';

export interface UninstallEntry {
  path: string;
  status: UninstallStatus;
  reason: string;
}

export interface RunUninstallOptions {
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  dryRun?: boolean | undefined;
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
  const host = createServiceHost(options);
  const dryRun = options.dryRun ?? false;
  const configDir = normalizePath(globalConfigDir());
  const entries: UninstallEntry[] = [];
  const warnings: string[] = [];
  await warnIfConfigIsNotReadable(warnings);
  const stateDir = normalizePath(stateRoot());
  const runDir = normalizePath(runRoot());
  const cacheDir = normalizePath(cacheRoot());
  const logDir = normalizePath(logsRoot());
  const protectedRoots = await resolveOperatorStateRoots();

  assertSafeOwnedDirectory(
    stateDir,
    'dreamux state directory',
    protectedRoots,
  );
  assertSafeOwnedDirectory(runDir, 'dreamux run directory', protectedRoots);
  assertSafeOwnedDirectory(
    cacheDir,
    'dreamux cache directory',
    protectedRoots,
  );
  assertSafeOwnedDirectory(logDir, 'dreamux logs directory', protectedRoots);
  assertSafeOwnedDirectory(
    configDir,
    'dreamux config directory',
    protectedRoots,
  );

  // Service removal (unit-only) is shared with `dreamux daemon uninstall`.
  const removal = await removeUserService({ host, dryRun });
  entries.push({
    path: removal.unitPath,
    status: removal.removed ? 'removed' : 'missing',
    reason: `${removal.platform} unit`,
  });

  await removeOwnedDirectory(
    stateDir,
    entries,
    'dreamux state directory',
    dryRun,
    protectedRoots,
  );
  await removeOwnedDirectory(
    runDir,
    entries,
    'dreamux run directory',
    dryRun,
    protectedRoots,
  );
  await removeOwnedDirectory(
    cacheDir,
    entries,
    'dreamux cache directory',
    dryRun,
    protectedRoots,
  );
  await removeOwnedDirectory(
    logDir,
    entries,
    'dreamux logs directory',
    dryRun,
    protectedRoots,
  );
  await removeOwnedDirectory(
    configDir,
    entries,
    'dreamux config directory',
    dryRun,
    protectedRoots,
  );

  return {
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
    service: {
      platform: removal.platform,
      unitPath: removal.unitPath,
    },
  };
}

async function warnIfConfigIsNotReadable(warnings: string[]): Promise<void> {
  try {
    await assertNoLegacyTomlOnly();
    if (!(await pathExists(globalConfigFile()))) return;
    await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `could not validate dreamux config before uninstall; continuing with fixed state/log paths: ${message}`,
    );
  }
}

async function removeOwnedDirectory(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
  protectedRoots: readonly string[],
): Promise<void> {
  assertSafeOwnedDirectory(path, reason, protectedRoots);
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

function assertSafeOwnedDirectory(
  path: string,
  reason: string,
  protectedRoots: readonly string[],
): void {
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
  for (const protectedRoot of protectedRoots) {
    if (isSameOrInside(normalized, protectedRoot)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${path} is inside operator agent runtime state ${protectedRoot}`,
      );
    }
  }
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

/**
 * Directories uninstall must never remove, sourced from every always-loaded
 * Agent Runtime provider's own `operatorStateRoot` (e.g. Codex's `~/.codex`,
 * Claude Code's `~/.claude`) instead of a host-side hard-coded list — a
 * provider added or removed from the always-loaded set stays correctly
 * protected without an uninstall-side edit. Building the registry this way
 * (empty `entries`, same as `onboard/wizard.ts`'s `onboardProviderRegistry`)
 * needs no config file: only the always-loaded plugins register.
 */
async function resolveOperatorStateRoots(): Promise<string[]> {
  const registry = createBuiltinProviderRegistry();
  await loadPlugins({
    registry,
    entries: [],
    logger: createLogger({ name: 'uninstall' }),
  });
  const roots: Array<string | undefined> = registry
    .listByKind('agentRuntime')
    .map((descriptor) => {
      const implementation = asAgentRuntimeProvider(
        registry.getImplementation(descriptor.id),
      );
      return implementation?.operatorStateRoot?.(process.env);
    });
  return uniquePaths(roots);
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
