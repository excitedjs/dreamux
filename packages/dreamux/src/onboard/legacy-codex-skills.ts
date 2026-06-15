/**
 * Legacy workspace `.codex/skills` paths — the symlink layout pre-#209-slice-6
 * `dreamux onboard` wrote into a Codex dispatcher's workspace. Bundled skills are
 * now injected at runtime by role (Codex `skills/extraRoots/set`), so dreamux no
 * longer creates this directory; `uninstall` keeps the path builders only to
 * REPORT (never remove) the symlinks an older install may have left behind —
 * they are left untouched (operators may delete the directory themselves) — and
 * the onboard tests use them to assert the directory is NOT created. Kept in core (not the
 * Codex package) because it is a host-owned onboarding artifact, and out of the
 * neutral `platform/paths.ts` layer because that layer never names `.codex`.
 */
import { join } from 'node:path';

import { BUNDLED_SKILL_NAMES, type BundledSkillName } from '../platform/paths.js';

/** Workspace-local Codex skills dir (`<cwd>/.codex/skills`). */
export function dispatcherWorkspaceCodexSkillsDir(cwd: string): string {
  return join(cwd, '.codex', 'skills');
}

/** One bundled skill's workspace dir (`<cwd>/.codex/skills/<skill>`). */
export function dispatcherWorkspaceSkillDir(
  cwd: string,
  skillName: BundledSkillName,
): string {
  return join(dispatcherWorkspaceCodexSkillsDir(cwd), skillName);
}

/** Every bundled skill's workspace dir, for legacy cleanup / non-creation checks. */
export function dispatcherWorkspaceSkillDirs(cwd: string): string[] {
  return BUNDLED_SKILL_NAMES.map((skillName) =>
    dispatcherWorkspaceSkillDir(cwd, skillName),
  );
}

/** The dispatcher skill's workspace `SKILL.md` path (`.../dispatcher/SKILL.md`). */
export function dispatcherWorkspaceSkillPath(cwd: string): string {
  return join(dispatcherWorkspaceSkillDir(cwd, 'dispatcher'), 'SKILL.md');
}
