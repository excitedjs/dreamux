import { dreamuxBinPath } from '../runtime/package-bin.js';
import type { AgentRuntimeMcpServer } from '../agent-runtime/types.js';

export const FEISHU_MCP_SERVER_NAME = 'feishu';

export interface FeishuMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export type FeishuMcpCodexArgsOptions = FeishuMcpServerDescriptorOptions;

export function feishuMcpServerDescriptor(
  opts: FeishuMcpServerDescriptorOptions,
): AgentRuntimeMcpServer {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return {
    name: FEISHU_MCP_SERVER_NAME,
    command,
    args: [
      'feishu-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}

export function feishuMcpCodexArgs(
  opts: FeishuMcpCodexArgsOptions,
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
