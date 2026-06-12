import { pathExists } from '../platform/fs-errors.js';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
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
  type BundledSkillName,
} from '../platform/paths.js';
import {
  dispatcherWorkspaceCodexSkillsDir,
  dispatcherWorkspaceSkillDir,
} from '../agent-runtime/builtin/codex/paths.js';

export type BundledSkillInstallStatus =
  | 'linked'
  | 'replaced'
  | 'unchanged'
  | 'skipped';

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
    // A real file or directory at the skill path is left untouched. dreamux 0.x
    // does not migrate old hand-copied skill directories (issue #98); the
    // operator removes or renames it to opt back into the bundled symlink.
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
