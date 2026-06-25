/**
 * Pure Claude Code CLI/MCP argument translation (issue #110 PR6).
 *
 * This is the concrete proof that the AgentRuntimeProvider abstraction is not
 * "Codex renamed": the same Dreamux `AgentRuntimeMcpServer[]` descriptors that
 * the Codex runtime turns into `-c mcp_servers.*` TOML CLI flags are here turned
 * into Claude Code's native MCP config — a JSON document loaded via
 * `claude --mcp-config <file>`. Two runtimes, one descriptor contract, two
 * completely different process argument shapes.
 *
 * Pure functions only — no IO, no process spawning — so they are fully unit
 * testable without a live `claude` binary.
 */

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import type { DispatcherClaudeCodeConfig } from './config.js';

/**
 * The skill-source `layout` Claude Code can translate into `--add-dir`: `path`
 * is a directory that contains a `.claude/skills` tree (claude's native skill
 * discovery location for added directories). Sources with any other layout —
 * e.g. the bundled Dreamux `skill-dir` sources, which are flat skill folders
 * with no `.claude/skills` parent — are NOT add-dir compatible and emit nothing,
 * so today's bundled skills feed codex only (claude-code's existing behavior of
 * injecting no bundled skills is preserved). The mapping is implemented for
 * compatible / external sources. Kept as a plain string because
 * `@excitedjs/dreamux-types` is declaration-only.
 */
export const CLAUDE_SKILLS_PARENT_LAYOUT = 'claude-skills-parent';

/**
 * Neutral host feature names → the Claude Code native tools they disable. Every
 * requested feature's tools are merged into a single `--disallowedTools` flag
 * (it takes a comma list, so emit it once); unknown feature names map to no
 * tools and are ignored.
 */
const CLAUDE_DISALLOWED_TOOLS_BY_FEATURE: Record<string, readonly string[]> = {
  cron: ['CronCreate', 'CronDelete', 'CronList'],
  userInterrupt: ['AskUserQuestion'],
};

export interface ClaudeCodeResidentArgsInput {
  config: DispatcherClaudeCodeConfig;
  /** Path to the generated Claude Code MCP config document. */
  mcpConfigPath: string;
  /** Resume an existing Claude Code session, when one is known (spawn-time). */
  resumeSessionId?: string | null;
  /**
   * Launcher-supplied dispatcher/role system-prompt content. Claude Code applies
   * it as an APPEND (per its `systemPrompt` capability) via
   * `--append-system-prompt`, layered on top of the engine's own system prompt.
   * Omitted/empty for launches that supply none (e.g. teammates).
   */
  systemPromptContent?: string;
  /**
   * Role-gated bundled/external skill sources core selected (issue #209 slice
   * 6). Claude Code translates the add-dir-compatible ones (see
   * {@link CLAUDE_SKILLS_PARENT_LAYOUT}) into `--add-dir <path>` flags so claude
   * discovers their `.claude/skills`. Omitted/empty for launches with none.
   */
  skillSources?: readonly AgentRuntimeSkillSource[];
  /**
   * Neutral feature names the host asked this runtime to disable. This package
   * maps only the names Claude Code understands and ignores the rest.
   */
  disableFeatures?: readonly string[];
}

/**
 * The `--add-dir` flag pairs for the add-dir-compatible skill sources, deduped
 * by path and preserving first-seen order. Pure: compatibility is decided from
 * the source `layout`, never by touching the filesystem.
 */
export function claudeCodeSkillAddDirArgs(
  skillSources: readonly AgentRuntimeSkillSource[] | undefined,
): string[] {
  const paths = [
    ...new Set(
      (skillSources ?? [])
        .filter((s) => s.layout === CLAUDE_SKILLS_PARENT_LAYOUT)
        .map((s) => s.path),
    ),
  ];
  return paths.flatMap((path) => ['--add-dir', path]);
}

/**
 * Build the `claude` CLI args for the *resident* stream-json transport (issue
 * #120). Unlike the retired one-shot `claude --print <prompt>`, this launches a
 * long-lived process that keeps stdin/stdout open: `--input-format stream-json`
 * consumes NDJSON `user` messages on stdin (one per turn) until EOF, and
 * `--output-format stream-json --verbose` streams `init` / `assistant` /
 * `result` envelopes on stdout. The prompt is therefore NOT a CLI argument —
 * each turn is written to stdin as a `user` message line (see
 * `claude-code/stream.ts`).
 *
 * It reads its MCP servers from the JSON config (`--mcp-config`), optionally
 * resumes a prior session at spawn time (`--resume`, used both for operator
 * resume and for re-spawn after an unexpected exit), and threads the operator's
 * model / permission mode / extra args through.
 */
export function claudeCodeResidentArgs(input: ClaudeCodeResidentArgsInput): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    input.mcpConfigPath,
  ];
  // Role-gated skills: add each compatible source dir so claude discovers its
  // `.claude/skills`. Present on every (re)spawn — start and resume both rebuild
  // these args — so skills survive a crash-respawn (issue #209 slice 6).
  args.push(...claudeCodeSkillAddDirArgs(input.skillSources));
  const disallowedTools = (input.disableFeatures ?? []).flatMap(
    (feature) => CLAUDE_DISALLOWED_TOOLS_BY_FEATURE[feature] ?? [],
  );
  if (disallowedTools.length > 0) {
    args.push('--disallowedTools', disallowedTools.join(','));
  }
  if (input.config.permission_mode !== null) {
    args.push('--permission-mode', input.config.permission_mode);
  }
  if (input.config.model !== null) {
    args.push('--model', input.config.model);
  }
  if (
    input.systemPromptContent !== undefined &&
    input.systemPromptContent !== ''
  ) {
    args.push('--append-system-prompt', input.systemPromptContent);
  }
  if (
    input.resumeSessionId !== undefined &&
    input.resumeSessionId !== null &&
    input.resumeSessionId !== ''
  ) {
    args.push('--resume', input.resumeSessionId);
  }
  args.push(...input.config.extra_args);
  return args;
}
