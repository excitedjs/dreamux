import { isNotFound, pathExists } from '../platform/fs-errors.js';
import { lstat, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { ExecaCommandRunner } from './commands.js';
import { removeUserService, serviceUnitPath } from './service.js';
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
  detail?: string;
}
export interface UninstallFailure {
  path: string;
  reason: string;
  error: string;
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
  failures: UninstallFailure[];
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
  leafSymlinkPath?: string;
}
export async function runUninstall(
  options: RunUninstallOptions = {},
): Promise<UninstallRunResult> {
  const runner = options.runner ?? new ExecaCommandRunner();
  const dryRun = options.dryRun ?? false;
  const configDir = normalizePath(options.configDir ?? globalConfigDir());
  const entries: UninstallEntry[] = [];
  const failures: UninstallFailure[] = [];
  const warnings: string[] = [];
  await warnIfConfigIsNotReadable(configDir, warnings);
  const homeRoot = normalizePath(dreamuxRoot());
  const removalTargets = await planRemovalTargets([
    [homeRoot, 'dreamux home directory'],
    [configDir, 'dreamux config directory'],
  ]);
  // Service removal (unit-only) is shared with `dreamux daemon uninstall`.
  const service = await removeService({
    runner,
    platform: options.platform,
    homeDir: options.homeDir ?? homedir(),
    uid: options.uid,
    dryRun,
    entries,
    failures,
  });
  for (const operation of removalTargets) {
    await removePath(operation, entries, failures, dryRun);
  }
  return {
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    failures,
    warnings,
    service: {
      platform: service.platform,
      unitPath: service.unitPath,
    },
  };
}
async function removeService(input: {
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  homeDir: string;
  uid?: number;
  dryRun: boolean;
  entries: UninstallEntry[];
  failures: UninstallFailure[];
}): Promise<{ platform: ServicePlatform; unitPath: string }> {
  try {
    const removal = await removeUserService({
      runner: input.runner,
      platform: input.platform,
      homeDir: input.homeDir,
      uid: input.uid,
      dryRun: input.dryRun,
    });
    input.entries.push({
      path: removal.unitPath,
      status: removal.removed ? 'removed' : 'missing',
      reason: `${removal.platform} unit`,
    });
    return {
      platform: removal.platform,
      unitPath: removal.unitPath,
    };
  } catch (err) {
    const unit = serviceUnitForFailure(input.platform, input.homeDir);
    input.entries.push({
      path: unit.unitPath,
      status: 'skipped',
      reason: `${unit.platform} unit`,
      detail: errorMessage(err),
    });
    input.failures.push({
      path: unit.unitPath,
      reason: `${unit.platform} unit`,
      error: errorMessage(err),
    });
    return unit;
  }
}
function serviceUnitForFailure(
  platform: NodeJS.Platform | undefined,
  homeDir: string,
): { platform: ServicePlatform; unitPath: string } {
  const unit = serviceUnitPath(platform, homeDir);
  return { platform: unit.platform, unitPath: unit.path };
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
async function removePath(
  operation: RemovalOperation,
  entries: UninstallEntry[],
  failures: UninstallFailure[],
  dryRun: boolean,
): Promise<void> {
  const physicalProbe = await probePath(operation.removalPath);
  const physicalExists = physicalProbe.exists;
  let physicalRemoved = physicalExists || dryRun;
  let physicalError = physicalProbe.error;
  if (physicalError !== null) {
    physicalRemoved = false;
    failures.push({
      path: operation.removalPath,
      reason: operation.targets[0]?.reason ?? 'dreamux-owned directory',
      error: physicalError,
    });
  }
  if (physicalExists && !dryRun) {
    try {
      await rm(operation.removalPath, {
        recursive: true,
        force: true,
      });
    } catch (err) {
      physicalRemoved = false;
      physicalError = errorMessage(err);
      failures.push({
        path: operation.removalPath,
        reason: operation.targets[0]?.reason ?? 'dreamux-owned directory',
        error: physicalError,
      });
    }
  }
  for (const target of operation.targets) {
    const leaf = dryRun
      ? plannedLeafResult(target)
      : await unlinkLeafSymlink(target, failures);
    const status = physicalError !== null && leaf.status !== 'removed'
      ? 'skipped'
      : targetStatus(physicalRemoved, physicalExists, leaf.status);
    entries.push(removalEntry(
      operation,
      target,
      status,
      leaf.detail ?? physicalError ?? undefined,
    ));
  }
}
async function probePath(
  path: string,
): Promise<{ exists: boolean; error: string | null }> {
  try {
    await lstat(path);
    return { exists: true, error: null };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, error: null };
    return { exists: false, error: errorMessage(err) };
  }
}
function removalEntry(
  operation: RemovalOperation,
  target: RemovalTarget,
  status: UninstallStatus,
  detail?: string,
): UninstallEntry {
  return {
    path: target.path,
    ...(operation.removalPath === target.path
      ? {}
      : { targetPath: operation.removalPath }),
    status,
    reason: target.reason,
    ...(detail === undefined ? {} : { detail }),
  };
}
function plannedLeafResult(target: RemovalTarget): {
  status: UninstallStatus;
  detail?: string;
} {
  return target.leafSymlinkPath === undefined
    ? { status: 'missing' }
    : { status: 'removed' };
}
function targetStatus(
  physicalRemoved: boolean,
  physicalExisted: boolean,
  leafStatus: UninstallStatus,
): UninstallStatus {
  if (leafStatus === 'removed') return 'removed';
  if (physicalRemoved && physicalExisted) return 'removed';
  if (leafStatus === 'skipped') return 'skipped';
  return 'missing';
}
async function planRemovalTargets(
  entries: Array<[path: string, reason: string]>,
): Promise<RemovalOperation[]> {
  const targets: RemovalTarget[] = [];
  for (const [path, reason] of entries) {
    const normalized = normalizePath(path);
    const leafSymlinkPath = await planLeafSymlinkPath(normalized, reason);
    targets.push({
      path: normalized,
      reason,
      leafSymlinkPath,
      removalPath: await assertSafeOwnedDirectory(normalized, reason),
    });
  }
  return collapseRemovalTargets(targets);
}
async function planLeafSymlinkPath(
  path: string,
  reason: string,
): Promise<string | undefined> {
  const physicalPath = await physicalLeafPath(path);
  await assertSafePhysicalLocation(physicalPath, path, reason);
  try {
    const stat = await lstat(physicalPath);
    if (!stat.isSymbolicLink()) return undefined;
    return physicalPath;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}
async function physicalLeafPath(path: string): Promise<string> {
  const normalized = normalizePath(path);
  return join(await canonicalPath(dirname(normalized)), basename(normalized));
}
async function unlinkLeafSymlink(
  target: RemovalTarget,
  failures: UninstallFailure[],
): Promise<{ status: UninstallStatus; detail?: string }> {
  const planned = target.leafSymlinkPath;
  if (planned === undefined) return { status: 'missing' };
  let stat;
  try {
    stat = await lstat(planned);
  } catch (err) {
    if (isNotFound(err)) return { status: 'missing' };
    const detail = errorMessage(err);
    failures.push({
      path: planned,
      reason: `${target.reason} symlink leaf`,
      error: detail,
    });
    return { status: 'skipped', detail };
  }
  if (!stat.isSymbolicLink()) return { status: 'skipped' };
  try {
    await unlink(planned);
    return { status: 'removed' };
  } catch (err) {
    const detail = errorMessage(err);
    failures.push({
      path: planned,
      reason: `${target.reason} symlink leaf`,
      error: detail,
    });
    return { status: 'skipped', detail };
  }
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
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
