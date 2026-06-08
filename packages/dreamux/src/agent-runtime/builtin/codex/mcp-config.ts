import type { AgentRuntimeMcpServer } from '../../types.js';
import {
  feishuMcpServerDescriptor,
  type FeishuMcpServerDescriptorOptions,
} from '../../../channel/feishu/feishu-mcp-surface.js';

export {
  FEISHU_MCP_SERVER_NAME,
  feishuMcpServerDescriptor,
  type FeishuMcpServerDescriptorOptions,
} from '../../../channel/feishu/feishu-mcp-surface.js';

export function feishuMcpCodexArgs(
  opts: FeishuMcpServerDescriptorOptions,
): string[] {
  return codexMcpServerArgs([feishuMcpServerDescriptor(opts)]);
}

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
