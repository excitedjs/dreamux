/**
 * Host-owned half of the Feishu Channel MCP surface (issue #209 slice 5).
 *
 * The channel-owned half — tool names, input shapes, JSON-schema descriptors,
 * and the raw-argument parser — moved to `@excitedjs/feishu-channel` (re-exported
 * below so existing core/shim import paths stay stable). What stays here is
 * host/shim machinery: the MCP *server descriptor* (which points at the Dreamux
 * bin + admin socket + the core `feishu-mcp` shim) and the admin-method routing
 * the shim uses to forward a tool call to core's admin socket.
 */
import { dreamuxBinPath } from '../../platform/package-bin.js';
import type { AgentRuntimeMcpServer } from '../../agent-runtime/types.js';
import type {
  FeishuMcpToolInput,
  FeishuMcpToolName,
} from '@excitedjs/feishu-channel';

export {
  feishuMcpTools,
  parseFeishuMcpToolInput,
  type FeishuMcpToolName,
  type FeishuMcpToolInput,
  type FeishuMcpReplyInput,
  type FeishuMcpReactInput,
  type FeishuMcpListChatBotsInput,
} from '@excitedjs/feishu-channel';

export const FEISHU_MCP_SERVER_NAME = 'feishu';

export interface FeishuMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

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
      ...(opts.callerKind !== undefined ? ['--caller', opts.callerKind] : []),
      ...(opts.teamId !== undefined ? ['--team-id', opts.teamId] : []),
      ...(opts.leaderName !== undefined ? ['--leader-name', opts.leaderName] : []),
      '--admin-socket',
      opts.adminSocketPath,
    ],
  };
}

export function feishuMcpAdminMethod(toolName: FeishuMcpToolName): string {
  switch (toolName) {
    case 'reply':
      return 'mcp.reply';
    case 'react':
      return 'mcp.react';
    case 'list_chat_bots':
      return 'mcp.list_chat_bots';
  }
}

export function feishuMcpAdminLabel(toolName: FeishuMcpToolName): string {
  return toolName === 'list_chat_bots' ? 'list_chat_bots' : toolName;
}

export function feishuMcpAdminParams(
  dispatcherId: string,
  parsed: FeishuMcpToolInput,
): Record<string, unknown> {
  switch (parsed.toolName) {
    case 'reply':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
        text: parsed.input.text,
        ...(parsed.input.messageId !== undefined
          ? { message_id: parsed.input.messageId }
          : {}),
        ...(parsed.input.mentionUserIds !== undefined
          ? { mention_user_ids: parsed.input.mentionUserIds }
          : {}),
      };
    case 'react':
      return {
        dispatcher_id: dispatcherId,
        ...(parsed.input.chatId !== undefined ? { chat_id: parsed.input.chatId } : {}),
        message_id: parsed.input.messageId,
        emoji: parsed.input.emoji,
      };
    case 'list_chat_bots':
      return {
        dispatcher_id: dispatcherId,
        chat_id: parsed.input.chatId,
      };
  }
}
