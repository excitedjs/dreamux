/**
 * Claude Code MCP config document translation.
 *
 * Mirrors `codex/mcp-config.ts`: the same Dreamux MCP descriptors become
 * Claude Code's native JSON document passed inline via `--mcp-config <json>`.
 */

import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

/** Claude Code MCP config document shape (`--mcp-config <json>`). */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  >;
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
      // Carried, never dropped: a descriptor's `env` holds what its server needs
      // to start. It is not kept secret by being here — this document is passed
      // inline on Claude Code's own command line — so the host does not treat
      // `env` as a secrecy boundary.
      ...(server.env !== undefined ? { env: { ...server.env } } : {}),
    };
  }
  return { mcpServers };
}

/** Serialize the Claude Code MCP config for inline CLI use. */
export function stringifyClaudeCodeMcpConfig(
  servers: readonly AgentRuntimeMcpServer[],
): string {
  return JSON.stringify(claudeCodeMcpConfig(servers));
}
