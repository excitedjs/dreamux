/**
 * Pure Claude Code CLI/MCP argument translation (issue #110 PR6).
 *
 * This is the concrete proof that the AgentRuntimeProvider abstraction is not
 * "Codex renamed": the same Dreamux `AgentRuntimeMcpServer[]` descriptors that
 * the Codex runtime turns into `-c mcp_servers.*` TOML CLI flags are here turned
 * into Claude Code's native MCP config — an inline JSON document passed via
 * `claude --mcp-config <json>`. Two runtimes, one descriptor contract, two
 * completely different process argument shapes.
 *
 * Pure functions only — no IO, no process spawning — so they are fully unit
 * testable without a live `claude` binary.
 */

import type { DispatcherClaudeCodeConfig } from './config.js';

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
  /** Inline Claude Code MCP config JSON document. */
  mcpConfigJson: string;
  /** Resume an existing Claude Code session, when one is known (spawn-time). */
  resumeSessionId?: string | null;
  /**
   * Launcher-supplied ordered dispatcher/role system-prompt content. Claude Code
   * applies it as an APPEND via one native `--append-system-prompt` argument.
   * Omitted/empty for launches that supply none.
   */
  systemPromptAppend?: readonly string[];
  /** Runtime-owned add-dir roots that contain `.claude/skills/<name>` entries. */
  skillAddDirs?: readonly string[];
  /**
   * Neutral feature names the host asked this runtime to disable. This package
   * maps only the names Claude Code understands and ignores the rest.
   */
  disableFeatures?: readonly string[];
}

/**
 * The `--add-dir` flag pairs for runtime-owned add-dir roots, deduped by path
 * and preserving first-seen order.
 */
export function claudeCodeSkillAddDirArgs(
  skillAddDirs: readonly string[] | undefined,
): string[] {
  const paths = [...new Set(skillAddDirs ?? [])];
  return paths.flatMap((path) => ['--add-dir', path]);
}

export function claudeCodeSystemPromptAppendContent(
  append: readonly string[] | undefined,
): string | undefined {
  const prompts = (append ?? []).filter((prompt) => prompt !== '');
  if (prompts.length === 0) return undefined;
  return prompts
    .map(
      (prompt) =>
        `<system-reminder>\n${escapeXmlText(prompt)}\n</system-reminder>`,
    )
    .join('\n\n');
}

function escapeXmlText(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return char;
    }
  });
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
 * It reads its MCP servers from the inline JSON config (`--mcp-config`), optionally
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
    input.mcpConfigJson,
  ];
  // Role-gated skills: add each compatible source dir so claude discovers its
  // `.claude/skills`. Present on every (re)spawn — start and resume both rebuild
  // these args — so skills survive a crash-respawn (issue #209 slice 6).
  args.push(...claudeCodeSkillAddDirArgs(input.skillAddDirs));
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
  const systemPromptContent = claudeCodeSystemPromptAppendContent(
    input.systemPromptAppend,
  );
  if (systemPromptContent !== undefined) {
    args.push('--append-system-prompt', systemPromptContent);
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

export interface ClaudeCodeSchemaArgsInput {
  config: DispatcherClaudeCodeConfig;
  /** Inline Claude Code MCP config JSON document. */
  mcpConfigJson: string;
  /** JSON Schema object constraining the model's structured output. */
  outputSchema: Record<string, unknown>;
  /**
   * Launcher-supplied ordered dispatcher/role system-prompt content. Applied
   * as an APPEND via `--append-system-prompt`, same as the resident transport.
   */
  systemPromptAppend?: readonly string[];
  /** Runtime-owned add-dir roots that contain `.claude/skills/<name>` entries. */
  skillAddDirs?: readonly string[];
  /** Neutral feature names the host asked this runtime to disable. */
  disableFeatures?: readonly string[];
}

/**
 * Build the `claude` CLI args for a *one-shot* structured-output turn.
 *
 * The resident stream-json transport applies CLI flags at spawn time and cannot
 * re-negotiate a per-turn JSON schema, so a turn that requests `outputSchema`
 * spawns a separate short-lived `claude --print --json-schema <schema>
 * --output-format json` process: the prompt is written to stdin (default text
 * input format), and the single JSON result on stdout carries a pre-validated
 * `structured_output` field the caller parses.
 *
 * Shares the resident transport's config threading (model / permission mode /
 * extra args / MCP config / skills / system prompt append / disallowed tools)
 * so the schema turn sees the same context as a normal turn. No `--resume` —
 * each schema turn is a fresh, self-contained process.
 */
export function claudeCodeSchemaArgs(input: ClaudeCodeSchemaArgsInput): string[] {
  const args = [
    '--print',
    '--json-schema',
    JSON.stringify(input.outputSchema),
    '--output-format',
    'json',
    '--mcp-config',
    input.mcpConfigJson,
  ];
  args.push(...claudeCodeSkillAddDirArgs(input.skillAddDirs));
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
  const systemPromptContent = claudeCodeSystemPromptAppendContent(
    input.systemPromptAppend,
  );
  if (systemPromptContent !== undefined) {
    args.push('--append-system-prompt', systemPromptContent);
  }
  args.push(...input.config.extra_args);
  return args;
}
