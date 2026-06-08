/**
 * Claude Code MCP config document translation.
 *
 * Mirrors `codex/mcp-config.ts`: the same Dreamux MCP descriptors become
 * Claude Code's native JSON document loaded via `--mcp-config <file>`.
 */

import type { AgentRuntimeMcpServer } from '../../types.js';

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
