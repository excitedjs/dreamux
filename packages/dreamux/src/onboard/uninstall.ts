import { isNotFound, pathExists } from '../platform/fs-errors.js';
import { lstat, readlink, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';

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
  targetPath?: string;
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

interface RemovalOperation {
  removalPath: string;
  targets: RemovalTarget[];
}

interface RemovalTarget {
  path: string;
  removalPath: string;
  reason: string;
  leafSymlink?: PlannedLeafSymlink;
}

interface PlannedLeafSymlink {
  path: string;
  physicalPath: string;
  target: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
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

  const removalTargets = await planRemovalTargets([
    [homeRoot, 'dreamux home directory'],
    [configDir, 'dreamux config directory'],
  ]);

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

  for (const operation of removalTargets) {
    await removeOwnedDirectory(operation, entries, dryRun);
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
  operation: RemovalOperation,
  entries: UninstallEntry[],
  dryRun: boolean,
): Promise<void> {
  await assertSafeOwnedDirectory(
    operation.removalPath,
    operation.targets[0]?.reason ?? 'dreamux-owned directory',
  );
  await removePath(operation, entries, dryRun);
}

async function removePath(
  operation: RemovalOperation,
  entries: UninstallEntry[],
  dryRun: boolean,
): Promise<void> {
  const physicalExists = await pathExists(operation.removalPath);
  if (physicalExists && !dryRun) {
    await rm(operation.removalPath, {
      recursive: true,
      force: true,
    });
  }
  for (const target of operation.targets) {
    const leafStatus = dryRun
      ? plannedLeafStatus(target)
      : await unlinkLeafSymlinkIfUnchanged(target);
    entries.push(removalEntry(
      operation,
      target,
      targetStatus(physicalExists, leafStatus),
    ));
  }
}

function removalEntry(
  operation: RemovalOperation,
  target: RemovalTarget,
  status: UninstallStatus,
): UninstallEntry {
  return {
    path: target.path,
    ...(operation.removalPath === target.path
      ? {}
      : { targetPath: operation.removalPath }),
    status,
    reason: target.reason,
  };
}

function plannedLeafStatus(target: RemovalTarget): UninstallStatus {
  return target.leafSymlink === undefined ? 'missing' : 'removed';
}

function targetStatus(
  physicalExists: boolean,
  leafStatus: UninstallStatus,
): UninstallStatus {
  if (leafStatus === 'skipped') return 'skipped';
  if (physicalExists || leafStatus === 'removed') return 'removed';
  return 'missing';
}

async function planRemovalTargets(
  entries: Array<[path: string, reason: string]>,
): Promise<RemovalOperation[]> {
  const targets: RemovalTarget[] = [];
  for (const [path, reason] of entries) {
    const normalized = normalizePath(path);
    const leafSymlink = await planLeafSymlink(normalized, reason);
    targets.push({
      path: normalized,
      reason,
      leafSymlink,
      removalPath: await assertSafeOwnedDirectory(normalized, reason),
    });
  }
  return collapseRemovalTargets(targets);
}

async function planLeafSymlink(
  path: string,
  reason: string,
): Promise<PlannedLeafSymlink | undefined> {
  const physicalPath = await physicalLeafPath(path);
  await assertSafePhysicalLocation(physicalPath, path, reason);
  try {
    const stat = await lstat(physicalPath, { bigint: true });
    if (!stat.isSymbolicLink()) return undefined;
    return {
      path,
      physicalPath,
      target: await readlink(physicalPath),
      dev: stat.dev,
      ino: stat.ino,
      ctimeNs: stat.ctimeNs,
      mtimeNs: stat.mtimeNs,
    };
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function physicalLeafPath(path: string): Promise<string> {
  const normalized = normalizePath(path);
  return join(await canonicalPath(dirname(normalized)), basename(normalized));
}

async function unlinkLeafSymlinkIfUnchanged(
  target: RemovalTarget,
): Promise<UninstallStatus> {
  const planned = target.leafSymlink;
  if (planned === undefined) return 'missing';
  let stat;
  try {
    stat = await lstat(planned.physicalPath, { bigint: true });
  } catch (err) {
    if (isNotFound(err)) return 'missing';
    throw err;
  }
  if (!sameNode(stat, planned) || !stat.isSymbolicLink()) return 'skipped';
  const currentTarget = await readlink(planned.physicalPath);
  if (currentTarget !== planned.target) return 'skipped';
  await unlink(planned.physicalPath);
  return 'removed';
}

function sameNode(stat: BigIntStats, planned: PlannedLeafSymlink): boolean {
  return stat.dev === planned.dev &&
    stat.ino === planned.ino &&
    stat.ctimeNs === planned.ctimeNs &&
    stat.mtimeNs === planned.mtimeNs;
}

function collapseRemovalTargets(targets: RemovalTarget[]): RemovalOperation[] {
  const out: RemovalOperation[] = [];
  for (const candidate of targets) {
    let next: RemovalOperation | null = {
      removalPath: candidate.removalPath,
      targets: [candidate],
    };
    for (let i = out.length - 1; i >= 0; i--) {
      const existing = out[i]!;
      if (isSameOrInside(candidate.removalPath, existing.removalPath)) {
        addLogicalTarget(existing, candidate);
        next = null;
        break;
      }
      if (isSameOrInside(existing.removalPath, candidate.removalPath)) {
        const removed = out.splice(i, 1)[0]!;
        for (const target of removed.targets) addLogicalTarget(next, target);
      }
    }
    if (next !== null) out.push(next);
  }
  return out;
}

function addLogicalTarget(
  operation: RemovalOperation,
  target: RemovalTarget,
): void {
  if (operation.targets.some((existing) => existing.path === target.path)) return;
  operation.targets.push(target);
}

async function assertSafeOwnedDirectory(
  path: string,
  reason: string,
): Promise<string> {
  const normalized = normalizePath(path);
  const canonicalTarget = await canonicalPath(normalized);
  await assertSafePhysicalLocation(canonicalTarget, path, reason);
  return canonicalTarget;
}

async function assertSafePhysicalLocation(
  physicalPath: string,
  sourcePath: string,
  reason: string,
): Promise<void> {
  const target = resolve(physicalPath);
  const [home, cwd, operatorRoots] = await Promise.all([
    canonicalPath(homedir()),
    canonicalPath(process.cwd()),
    canonicalOperatorStateRoots(),
  ]);
  for (const protectedRoot of operatorRoots) {
    if (isSameOrInside(target, protectedRoot)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${sourcePath} overlaps operator Codex/Claude state ${protectedRoot}`,
      );
    }
  }
  if (
    target === '/' ||
    isSameOrAncestorOf(target, home) ||
    isSameOrAncestorOf(target, cwd)
  ) {
    throw new Error(`refusing to remove unsafe ${reason}: ${sourcePath}`);
  }
  for (const protectedRoot of operatorRoots) {
    if (isSameOrInside(protectedRoot, target)) {
      throw new Error(
        `refusing to remove unsafe ${reason}: ${sourcePath} overlaps operator Codex/Claude state ${protectedRoot}`,
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

function isSameOrInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
