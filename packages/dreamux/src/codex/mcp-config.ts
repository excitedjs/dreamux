import { dreamuxBinPath } from '../runtime/package-bin.js';

export const FEISHU_MCP_SERVER_NAME = 'feishu';

export interface FeishuMcpCodexArgsOptions {
  dispatcherId: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export function feishuMcpCodexArgs(
  opts: FeishuMcpCodexArgsOptions,
): string[] {
  const command = opts.command ?? dreamuxBinPath(opts.env);
  return [
    '-c',
    `mcp_servers.${FEISHU_MCP_SERVER_NAME}.command=${tomlString(command)}`,
    '-c',
    `mcp_servers.${FEISHU_MCP_SERVER_NAME}.args=${tomlStringArray([
      'feishu-mcp',
      '--dispatcher',
      opts.dispatcherId,
      '--admin-socket',
      opts.adminSocketPath,
    ])}`,
  ];
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
