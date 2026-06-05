import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  installBundledWorkspaceSkills,
} from '../src/runtime/bundled-skills.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
  dispatcherWorkspaceSkillDir,
} from '../src/runtime/paths.js';

describe('bundled workspace skill installer', () => {
  let root: string;
  let dispatcherCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-bundled-skills-'));
    dispatcherCwd = join(root, 'dispatcher');
    mkdirSync(dispatcherCwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs every bundled skill as a workspace-local symlink', async () => {
    const results = await installBundledWorkspaceSkills({ dispatcherCwd });

    expect(results.map((result) => [result.skillName, result.status])).toEqual(
      BUNDLED_SKILL_NAMES.map((skillName) => [skillName, 'linked']),
    );
    for (const skillName of BUNDLED_SKILL_NAMES) {
      const target = dispatcherWorkspaceSkillDir(dispatcherCwd, skillName);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(realpathSync(target)).toBe(realpathSync(bundledSkillDir(skillName)));
      expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    }
  });

  it('leaves correct symlinks unchanged on repeated installs', async () => {
    await installBundledWorkspaceSkills({ dispatcherCwd });

    const second = await installBundledWorkspaceSkills({ dispatcherCwd });

    expect(second.map((result) => result.status)).toEqual(
      BUNDLED_SKILL_NAMES.map(() => 'unchanged'),
    );
  });

  it('replaces stale or broken skill symlinks', async () => {
    const wrongTarget = join(root, 'old-skill');
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'dispatcher');
    mkdirSync(wrongTarget, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(wrongTarget, target, 'dir');

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const dispatcherResult = results.find((result) =>
      result.skillName === 'dispatcher'
    );

    expect(dispatcherResult?.status).toBe('replaced');
    expect(realpathSync(target)).toBe(realpathSync(bundledSkillDir('dispatcher')));
  });

  it('does not overwrite an existing real skill directory', async () => {
    const target = dispatcherWorkspaceSkillDir(dispatcherCwd, 'team-dev-workflow');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), '# user skill\n');

    const results = await installBundledWorkspaceSkills({ dispatcherCwd });
    const conflict = results.find((result) =>
      result.skillName === 'team-dev-workflow'
    );

    expect(conflict?.status).toBe('skipped');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# user skill\n');
  });

  it('rejects a missing dispatcher cwd instead of creating it', async () => {
    await expect(
      installBundledWorkspaceSkills({ dispatcherCwd: join(root, 'missing') }),
    ).rejects.toThrow('dispatcher cwd does not exist');
  });

  it('allows missing dispatcher cwd during dry-run planning', async () => {
    const missing = join(root, 'dry-run-missing');

    const results = await installBundledWorkspaceSkills({
      dispatcherCwd: missing,
      dryRun: true,
    });

    expect(results.map((result) => result.status)).toEqual(
      BUNDLED_SKILL_NAMES.map(() => 'linked'),
    );
    expect(existsSync(missing)).toBe(false);
  });

  it('fails explicitly on Windows instead of copying skills', async () => {
    await expect(
      installBundledWorkspaceSkills({ dispatcherCwd, platform: 'win32' }),
    ).rejects.toThrow('directory symlinks');
  });
});
