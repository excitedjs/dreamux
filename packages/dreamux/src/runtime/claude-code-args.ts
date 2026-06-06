/**
 * Pure Claude Code CLI/MCP argument translation (issue #110 PR6).
 *
 * This is the concrete proof that the AgentRuntimeProvider abstraction is not
 * "Codex renamed": the same Dreamux `AgentRuntimeMcpServer[]` descriptors that
 * the Codex runtime turns into `-c mcp_servers.*` TOML CLI flags are here turned
 * into Claude Code's native MCP config — a JSON document loaded via
 * `claude --mcp-config <file>`. Two runtimes, one descriptor contract, two
 * completely different on-the-wire shapes.
 *
 * Pure functions only — no IO, no process spawning — so they are fully unit
 * testable without a live `claude` binary.
 */

import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';
import type { DispatcherClaudeCodeConfig } from './config.js';

/** Claude Code MCP config document shape (`--mcp-config <file>`). */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/** Translate Dreamux MCP descriptors into Claude Code's MCP config document. */
export function claudeCodeMcpConfig(
  servers: readonly AgentRuntimeMcpServer[],
): ClaudeCodeMcpConfig {
  const mcpServers: ClaudeCodeMcpConfig['mcpServers'] = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: [...server.args],
    };
  }
  return { mcpServers };
}

/** Serialize the Claude Code MCP config for writing to disk. */
export function stringifyClaudeCodeMcpConfig(
  servers: readonly AgentRuntimeMcpServer[],
): string {
  return `${JSON.stringify(claudeCodeMcpConfig(servers), null, 2)}\n`;
}

export interface ClaudeCodeTurnArgsInput {
  config: DispatcherClaudeCodeConfig;
  /** Path to the generated Claude Code MCP config document. */
  mcpConfigPath: string;
  /** The turn prompt (the inbound text or a delivery notification). */
  prompt: string;
  /** Resume an existing Claude Code session, when one is known. */
  resumeSessionId?: string | null;
}

/**
 * Build the `claude` CLI args for one headless turn. Claude Code runs a turn
 * per non-interactive `--print` invocation (no persistent app-server), reads
 * its MCP servers from the JSON config, optionally resumes a prior session, and
 * emits a single JSON result (`--output-format json`) carrying the session id.
 */
export function claudeCodeTurnArgs(input: ClaudeCodeTurnArgsInput): string[] {
  const args = [
    '--print',
    '--output-format',
    'json',
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
    input.resumeSessionId !== undefined &&
    input.resumeSessionId !== null &&
    input.resumeSessionId !== ''
  ) {
    args.push('--resume', input.resumeSessionId);
  }
  args.push(...input.config.extra_args);
  // The prompt is the trailing positional argument under `--print`.
  args.push(input.prompt);
  return args;
}
