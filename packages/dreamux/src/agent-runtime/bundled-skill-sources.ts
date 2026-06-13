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
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
  bundledSkillsDir,
} from '../platform/paths.js';

/**
 * The on-disk layout of a per-skill bundled Dreamux skill source: `path` is the
 * skill's own directory, which contains its `SKILL.md`. Codex maps this to an
 * extra skills root by taking the *parent* of such a dir (a root whose immediate
 * children are skill dirs). Kept as a plain string because
 * `@excitedjs/dreamux-types` is declaration-only and cannot export a runtime
 * constant.
 */
export const DREAMUX_SKILL_DIR_LAYOUT = 'skill-dir';

/**
 * The layout for the single Claude-Code add-dir parent source: `path` is a
 * directory that contains a `.claude/skills/<name>` tree, which Claude Code
 * discovers when the dir is passed as `--add-dir <path>`. This MUST match the
 * `CLAUDE_SKILLS_PARENT_LAYOUT` literal the `@excitedjs/agent-runtime-claude-code`
 * package translates into `--add-dir` (a cross-package test pins the equality).
 * Kept as a plain string for the same declaration-only reason as above.
 */
export const DREAMUX_CLAUDE_SKILLS_PARENT_LAYOUT = 'claude-skills-parent';

/** The synthetic source name for the bundled Claude add-dir parent. */
export const DREAMUX_BUNDLED_CLAUDE_PARENT_NAME = 'dreamux-bundled-skills';

/** Roles that receive the bundled Dreamux skills. */
function roleReceivesBundledSkills(role: AgentRuntimeRole): boolean {
  return role === 'dispatcher' || role === 'team_leader';
}

/**
 * The bundled Dreamux skill sources for a runtime `role`. For Dispatcher and
 * TeamLeader this returns BOTH engine views of the SAME on-disk skills, so each
 * builtin picks the view its engine understands and the other engine ignores the
 * incompatible layout:
 *
 * - one `skill-dir` source per bundled skill (`path` = the skill dir) — Codex
 *   applies these via `skills/extraRoots/set` (the shared parent is one root);
 * - one `claude-skills-parent` source (`path` = the add-dir parent that contains
 *   `.claude/skills/<name>`) — Claude Code translates it into a real
 *   `--add-dir <absolute package path>` flag.
 *
 * Every other role gets an empty array. The launcher passes the result as
 * `AgentRuntimeCreateContext.skillSources`.
 */
export function bundledSkillSourcesForRole(
  role: AgentRuntimeRole,
): AgentRuntimeSkillSource[] {
  if (!roleReceivesBundledSkills(role)) return [];
  const codexSources: AgentRuntimeSkillSource[] = BUNDLED_SKILL_NAMES.map(
    (name) => ({
      name,
      path: bundledSkillDir(name),
      layout: DREAMUX_SKILL_DIR_LAYOUT,
      source: 'dreamux-core',
    }),
  );
  // The Claude Code add-dir parent: a single source whose path is the directory
  // containing `.claude/skills`. Codex ignores this layout; Claude Code ignores
  // the per-skill `skill-dir` sources — so both engines read the same physical
  // `bundledSkillContainerDir()/<name>` skills from one bundled copy.
  const claudeParent: AgentRuntimeSkillSource = {
    name: DREAMUX_BUNDLED_CLAUDE_PARENT_NAME,
    path: bundledSkillsDir(),
    layout: DREAMUX_CLAUDE_SKILLS_PARENT_LAYOUT,
    source: 'dreamux-core',
  };
  return [...codexSources, claudeParent];
}
