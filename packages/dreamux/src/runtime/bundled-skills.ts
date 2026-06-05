import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
  dispatcherWorkspaceCodexSkillsDir,
  dispatcherWorkspaceSkillDir,
  type BundledSkillName,
} from './paths.js';

/** Async existence probe - the fs/promises replacement for existsSync. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export type BundledSkillInstallStatus =
  | 'linked'
  | 'replaced'
  | 'unchanged'
  | 'skipped';

const LEGACY_COPIED_DISPATCHER_SKILL_SHA256 = new Set([
  // Pre-symlink Dreamux wrote exactly this dispatcher SKILL.md copy.
  // Only exact unmodified copies are migrated automatically.
  '4dca0986d2e7ecde171ac3436718eaa1fefe599dacfdc2d20c90d2cf1d443be1',
]);

export interface BundledSkillInstallResult {
  skillName: BundledSkillName;
  sourcePath: string;
  targetPath: string;
  status: BundledSkillInstallStatus;
  reason: string;
}

export interface InstallBundledSkillsOptions {
  dispatcherCwd: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
}

export async function installBundledWorkspaceSkills(
  options: InstallBundledSkillsOptions,
): Promise<BundledSkillInstallResult[]> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error(
      'workspace-local bundled skills require directory symlinks; Windows is not supported by this installer',
    );
  }

  await assertDispatcherCwd(options.dispatcherCwd, options.dryRun ?? false);
  const skillsDir = dispatcherWorkspaceCodexSkillsDir(options.dispatcherCwd);
  if (!options.dryRun) {
    await mkdir(skillsDir, { recursive: true });
  }

  const results: BundledSkillInstallResult[] = [];
  for (const skillName of BUNDLED_SKILL_NAMES) {
    results.push(
      await installOneSkill({
        dispatcherCwd: options.dispatcherCwd,
        skillName,
        dryRun: options.dryRun ?? false,
      }),
    );
  }
  return results;
}

async function assertDispatcherCwd(
  dispatcherCwd: string,
  allowMissing: boolean,
): Promise<void> {
  let info;
  try {
    info = await stat(dispatcherCwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (allowMissing) return;
      throw new Error(`dispatcher cwd does not exist: ${dispatcherCwd}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`dispatcher cwd is not a directory: ${dispatcherCwd}`);
  }
}

async function installOneSkill(options: {
  dispatcherCwd: string;
  skillName: BundledSkillName;
  dryRun: boolean;
}): Promise<BundledSkillInstallResult> {
  const sourcePath = bundledSkillDir(options.skillName);
  const targetPath = dispatcherWorkspaceSkillDir(
    options.dispatcherCwd,
    options.skillName,
  );
  await assertBundledSkillSource(options.skillName, sourcePath);

  let targetInfo;
  try {
    targetInfo = await lstat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (targetInfo === undefined) {
    if (!options.dryRun) {
      await createSkillSymlink(sourcePath, targetPath, options.skillName);
    }
    return {
      skillName: options.skillName,
      sourcePath,
      targetPath,
      status: 'linked',
      reason: 'created workspace-local bundled skill symlink',
    };
  }

  if (!targetInfo.isSymbolicLink()) {
    const legacyCopiedSkill = await isLegacyCopiedDispatcherSkill({
      skillName: options.skillName,
      targetPath,
      targetInfo,
    });
    if (legacyCopiedSkill) {
      if (!options.dryRun) {
        await replaceLegacyCopiedDirectoryWithSymlink(
          sourcePath,
          targetPath,
          options.skillName,
        );
      }
      return {
        skillName: options.skillName,
        sourcePath,
        targetPath,
        status: 'replaced',
        reason:
          'migrated a legacy Dreamux-copied dispatcher skill directory to the bundled symlink',
      };
    }
    return {
      skillName: options.skillName,
      sourcePath,
      targetPath,
      status: 'skipped',
      reason:
        'existing non-symlink skill path was left untouched; remove or rename it to use the bundled skill',
    };
  }

  const currentTarget = await resolvedSymlinkTarget(targetPath);
  const sourceRealPath = await realpath(sourcePath);
  if (currentTarget === sourceRealPath) {
    return {
      skillName: options.skillName,
      sourcePath,
      targetPath,
      status: 'unchanged',
      reason: 'workspace-local bundled skill symlink already points to this package',
    };
  }

  if (!options.dryRun) {
    await replaceSkillSymlink(sourcePath, targetPath, options.skillName);
  }
  return {
    skillName: options.skillName,
    sourcePath,
    targetPath,
    status: 'replaced',
    reason: 'replaced stale or broken workspace-local bundled skill symlink',
  };
}

async function assertBundledSkillSource(
  skillName: BundledSkillName,
  sourcePath: string,
): Promise<void> {
  let info;
  try {
    info = await stat(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`missing bundled skill '${skillName}': ${sourcePath}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`bundled skill '${skillName}' is not a directory: ${sourcePath}`);
  }
  const skillFile = resolve(sourcePath, 'SKILL.md');
  if (!(await pathExists(skillFile))) {
    throw new Error(`bundled skill '${skillName}' is missing SKILL.md: ${skillFile}`);
  }
}

async function isLegacyCopiedDispatcherSkill(options: {
  skillName: BundledSkillName;
  targetPath: string;
  targetInfo: Awaited<ReturnType<typeof lstat>>;
}): Promise<boolean> {
  if (options.skillName !== 'dispatcher' || !options.targetInfo.isDirectory()) {
    return false;
  }
  try {
    const entries = await readdir(options.targetPath);
    if (entries.length !== 1 || entries[0] !== 'SKILL.md') return false;
    const skillFile = resolve(options.targetPath, 'SKILL.md');
    const skillInfo = await stat(skillFile);
    if (!skillInfo.isFile()) return false;
    const content = await readFile(skillFile);
    const hash = createHash('sha256').update(content).digest('hex');
    return LEGACY_COPIED_DISPATCHER_SKILL_SHA256.has(hash);
  } catch {
    return false;
  }
}

async function resolvedSymlinkTarget(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
}

async function createSkillSymlink(
  sourcePath: string,
  targetPath: string,
  skillName: BundledSkillName,
): Promise<void> {
  try {
    await symlink(sourcePath, targetPath, 'dir');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException).code;
    const hint =
      code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EINVAL'
        ? ' Check filesystem permissions and symlink support; dreamux does not copy bundled skills as a fallback.'
        : '';
    throw new Error(
      `failed to install bundled skill '${skillName}' as a symlink at ${targetPath}: ${detail}.${hint}`,
    );
  }
}

async function replaceSkillSymlink(
  sourcePath: string,
  targetPath: string,
  skillName: BundledSkillName,
): Promise<void> {
  const temporaryTarget = resolve(
    dirname(targetPath),
    `.${skillName}.dreamux-next-${randomUUID()}`,
  );
  try {
    await createSkillSymlink(sourcePath, temporaryTarget, skillName);
    await rename(temporaryTarget, targetPath);
  } catch (err) {
    await rm(temporaryTarget, { force: true, recursive: false }).catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to replace bundled skill '${skillName}' symlink at ${targetPath}: ${detail}`,
    );
  }
}

async function replaceLegacyCopiedDirectoryWithSymlink(
  sourcePath: string,
  targetPath: string,
  skillName: BundledSkillName,
): Promise<void> {
  const parent = dirname(targetPath);
  const suffix = randomUUID();
  const temporaryLink = resolve(parent, `.${skillName}.dreamux-next-${suffix}`);
  const backupPath = resolve(parent, `.${skillName}.dreamux-legacy-${suffix}`);
  let backupCreated = false;
  try {
    await createSkillSymlink(sourcePath, temporaryLink, skillName);
    await rename(targetPath, backupPath);
    backupCreated = true;
    await rename(temporaryLink, targetPath);
    await rm(backupPath, { recursive: true });
  } catch (err) {
    await rm(temporaryLink, { force: true, recursive: false }).catch(() => {});
    if (backupCreated && !(await pathExists(targetPath))) {
      await rename(backupPath, targetPath).catch(() => {});
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to migrate legacy copied bundled skill '${skillName}' at ${targetPath}: ${detail}`,
    );
  }
}
