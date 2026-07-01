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
import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
} from '../platform/paths.js';

type AgentRuntimeRole =
  | 'dispatcher'
  | 'team_leader'
  | 'teammate'
  | 'team_member';

/** Roles that receive the bundled Dreamux skills. */
function roleReceivesBundledSkills(role: AgentRuntimeRole): boolean {
  return role === 'dispatcher' || role === 'team_leader';
}

/**
 * The bundled Dreamux skill sources for a runtime `role`. For Dispatcher and
 * TeamLeader this returns one neutral source per concrete skill directory. Each
 * runtime package owns translating those directories into its native discovery
 * layout; core emits no runtime-specific layout markers.
 */
export function bundledSkillSourcesForRole(
  role: AgentRuntimeRole,
): AgentRuntimeSkillSource[] {
  if (!roleReceivesBundledSkills(role)) return [];
  return BUNDLED_SKILL_NAMES.map((name) => ({
    name,
    path: bundledSkillDir(name),
    source: 'dreamux-core',
  }));
}
