/**
 * Role-gated bundled Dreamux skill selection (issue #209 slice 6).
 *
 * Dreamux core owns the bundled skills AND which roles receive them. This module
 * is the single place that maps a runtime `role` to the neutral
 * `AgentRuntimeSkillSource[]` the launcher hands a runtime via the create
 * context. The runtime package owns the mechanics of applying the sources to its
 * engine; core never touches `.codex/skills` / `.claude/skills` layout itself.
 *
 * Only the Dispatcher and TeamLeader roles receive the bundled skills. Ordinary
 * TeamMate and team-member runtimes receive none by default — they are scoped,
 * single-task agents and the operational skills are dispatcher/leader concerns.
 *
 * This replaces the retired workspace-symlink installer
 * (`onboard/bundled-skills.ts`), which wrote the skills into each runtime's
 * working directory; nothing here mutates the filesystem.
 */
import type { AgentRuntimeRole, AgentRuntimeSkillSource } from './types.js';
import { BUNDLED_SKILL_NAMES, bundledSkillDir } from '../platform/paths.js';

/**
 * The on-disk layout of a bundled Dreamux skill source: `path` is the skill's
 * own directory, which contains its `SKILL.md`. A runtime maps this to its
 * engine's skill-discovery scheme (codex treats the *parent* of such a dir as an
 * extra skills root; claude-code, whose `--add-dir` needs a `.claude/skills`
 * container, treats it as incompatible and injects nothing). Kept as a plain
 * string because `@excitedjs/dreamux-types` is declaration-only and cannot
 * export a runtime constant.
 */
export const DREAMUX_SKILL_DIR_LAYOUT = 'skill-dir';

/** Roles that receive the bundled Dreamux skills. */
function roleReceivesBundledSkills(role: AgentRuntimeRole): boolean {
  return role === 'dispatcher' || role === 'team_leader';
}

/**
 * The bundled Dreamux skill sources for a runtime `role`. Returns one source per
 * bundled skill for Dispatcher/TeamLeader, and an empty array for every other
 * role. The launcher passes the result as `AgentRuntimeCreateContext.skillSources`.
 */
export function bundledSkillSourcesForRole(
  role: AgentRuntimeRole,
): AgentRuntimeSkillSource[] {
  if (!roleReceivesBundledSkills(role)) return [];
  return BUNDLED_SKILL_NAMES.map((name) => ({
    name,
    path: bundledSkillDir(name),
    layout: DREAMUX_SKILL_DIR_LAYOUT,
    source: 'dreamux-core',
  }));
}
