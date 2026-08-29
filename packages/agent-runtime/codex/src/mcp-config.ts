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
    // Carried, never dropped: a descriptor's `env` holds what its server needs
    // to start, so losing it breaks the server it was minted for. Note that
    // this rendering puts those values into Codex's own command line, so `env`
    // is not a secrecy boundary here — the host is told as much and does not
    // rely on one.
    ...(server.env !== undefined
      ? ['-c', `mcp_servers.${server.name}.env=${tomlTable(server.env)}`]
      : []),
  ]);
}

function tomlTable(entries: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(entries).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{${pairs.join(', ')}}`;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
