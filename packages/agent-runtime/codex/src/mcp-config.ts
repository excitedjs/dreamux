import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

/**
 * Render neutral MCP server descriptors into Codex `-c mcp_servers.<name>.*`
 * config-override CLI args. Provider-neutral: it knows nothing about which
 * channel or shim produced a descriptor — the Dreamux host decides which MCP
 * servers a runtime gets and passes them through the create context.
 */
export function codexMcpServerArgs(
  servers: readonly AgentRuntimeMcpServer[],
): string[] {
  return servers.flatMap((server) => [
    '-c',
    `mcp_servers.${server.name}.command=${tomlString(server.command)}`,
    '-c',
    `mcp_servers.${server.name}.args=${tomlStringArray(server.args)}`,
  ]);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
