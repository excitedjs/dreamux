import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';
import type { McpServer } from '@agentclientprotocol/sdk';

export function kimiCodeAcpMcpServers(
  servers: readonly AgentRuntimeMcpServer[],
): McpServer[] {
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: [],
  }));
}
