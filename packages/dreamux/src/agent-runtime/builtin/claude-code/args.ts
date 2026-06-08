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

import type { DispatcherClaudeCodeConfig } from './config.js';

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
