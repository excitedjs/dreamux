import { pathExists } from '../platform/fs-errors.js';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { ExecaCommandRunner } from './commands.js';
import { removeUserService } from './service.js';
import type { CommandRunner, ServicePlatform } from '../onboard/types.js';
import {
  assertNoLegacyTomlOnly,
  expandHome,
  globalConfigDir,
  globalConfigFile,
} from '../config/config.js';
import { inspectRawConfig } from '../config/raw-inspection.js';
import { canonicalPath, dreamuxRoot } from '../platform/paths.js';

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
  const homeRoot = normalizePath(dreamuxRoot());

  const removalTargets = uniqueRemovalTargets([
    [homeRoot, 'dreamux home directory'],
    ...(isSameOrInside(configDir, homeRoot)
      ? []
      : ([[configDir, 'dreamux config directory']] as Array<[string, string]>)),
  ]);
  for (const entry of removalTargets) {
    await assertSafeOwnedDirectory(entry.path, entry.reason);
  }

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

  for (const entry of removalTargets) {
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
    await inspectRawConfig({ configDir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `could not validate dreamux config before uninstall; continuing with fixed Dreamux-owned removal targets: ${message}`,
    );
  }
}

async function removeOwnedDirectory(
  path: string,
  entries: UninstallEntry[],
  reason: string,
  dryRun: boolean,
): Promise<void> {
  await assertSafeOwnedDirectory(path, reason);
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

async function assertSafeOwnedDirectory(path: string, reason: string): Promise<void> {
  const normalized = normalizePath(path);
  const [canonicalTarget, home, cwd, operatorRoots] = await Promise.all([
    canonicalPath(normalized),
    canonicalPath(homedir()),
    canonicalPath(process.cwd()),
    canonicalOperatorStateRoots(),
  ]);
  for (const protectedRoot of operatorRoots) {
    if (isSameOrInside(canonicalTarget, protectedRoot)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${path} overlaps operator Codex/Claude state ${protectedRoot}`,
      );
    }
  }
  if (
    canonicalTarget === '/' ||
    isSameOrAncestorOf(canonicalTarget, home) ||
    isSameOrAncestorOf(canonicalTarget, cwd)
  ) {
    throw new Error(`refusing to remove unsafe ${reason}: ${path}`);
  }
  for (const protectedRoot of operatorRoots) {
    if (isSameOrInside(protectedRoot, canonicalTarget)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${path} overlaps operator Codex/Claude state ${protectedRoot}`,
      );
    }
  }
}

function isSameOrAncestorOf(path: string, protectedPath: string): boolean {
  return isSameOrInside(protectedPath, path);
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

async function canonicalOperatorStateRoots(): Promise<string[]> {
  return uniqueCanonicalPaths([
    await canonicalPath(joinHome('.codex')),
    await canonicalPath(joinHome('.claude')),
  ]);
}

function joinHome(child: string): string {
  return normalizePath(join(homedir(), child));
}

function uniqueCanonicalPaths(paths: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (path === undefined || path.trim() === '') continue;
    out.add(resolve(path));
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
