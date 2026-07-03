/**
 * Role-gated bundled Dreamux skill selection (issue #209 slice 6).
 *
 * Dreamux core owns the bundled skills AND which roles receive them. This module
 * is the single place that maps a runtime `role` to the neutral
 * `AgentRuntimeSkillSource[]` the launcher hands a runtime via the create
 * context. The runtime package owns the mechanics of applying the sources to its
 * engine; core never touches `.codex/skills` / `.claude/skills` layout itself.
 *
 * Only the Dispatcher and TeamLeader roles receive bundled skills. Dispatchers
 * receive orchestration notes plus host-maintenance notes; TeamLeaders receive
 * only their scoped workflow notes. Ordinary TeamMate and team-member runtimes
 * receive none by default — they are scoped agents and the operational skills
 * are dispatcher/leader concerns.
 *
 * This replaces the retired workspace-symlink installer
 * (`onboard/bundled-skills.ts`), which wrote the skills into each runtime's
 * working directory; nothing here mutates the filesystem.
 */
import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';
import { bundledSkillDir, type BundledSkillName } from '../platform/paths.js';

type AgentRuntimeRole =
  | 'dispatcher'
  | 'team_leader'
  | 'teammate'
  | 'team_member';

const BUNDLED_SKILLS_BY_ROLE: Record<AgentRuntimeRole, readonly BundledSkillName[]> = {
  dispatcher: ['dispatcher-workflow', 'dreamux-maintenance'],
  team_leader: ['team-workflow'],
  teammate: [],
  team_member: [],
};

/**
 * The bundled Dreamux skill sources for a runtime `role`. For roles with a
 * bundled skill this returns one neutral source per concrete skill directory. Each
 * runtime package owns translating those directories into its native discovery
 * layout; core emits no runtime-specific layout markers.
 */
export function bundledSkillSourcesForRole(
  role: AgentRuntimeRole,
): AgentRuntimeSkillSource[] {
  return BUNDLED_SKILLS_BY_ROLE[role].map((name) => ({
    name,
    path: bundledSkillDir(name),
    source: 'dreamux-core',
  }));
}

export function bundledSkillNamesForRole(
  role: AgentRuntimeRole,
): readonly BundledSkillName[] {
  return BUNDLED_SKILLS_BY_ROLE[role];
}
