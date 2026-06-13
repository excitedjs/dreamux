/**
 * Core-side Codex MCP bridge.
 *
 * The generic `codexMcpServerArgs` renderer now lives in
 * `@excitedjs/agent-runtime-codex`; it is re-exported here so existing core/test
 * import paths stay stable (issue #209 slice 3). The Feishu-specific helper
 * stays in core: it crosses the channel boundary (the Codex runtime package must
 * not know about Feishu), so core wires the Feishu MCP descriptor into the
 * generic renderer.
 */
import { codexMcpServerArgs } from '@excitedjs/agent-runtime-codex';
import {
  feishuMcpServerDescriptor,
  type FeishuMcpServerDescriptorOptions,
} from '../../../channel/feishu/feishu-mcp-surface.js';

export { codexMcpServerArgs };
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
